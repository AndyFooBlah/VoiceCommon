// Copyright 2026 Andrew Brook
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Live session hook for VoiceCommon.
 *
 * Orchestrates the full lifecycle of a voice AI session:
 *   1. Start: Initialize audio mixer → Create Firestore session → Connect Gemini Live
 *   2. During: Stream PCM to Gemini, play bot audio (recorded to archive), sync transcript
 *   3. Stop: Close Gemini, stop recorder, upload audio to GCS, finalize session
 *   4. Reconnect: On unexpected disconnect, automatically re-establish the Gemini
 *      connection, flush partial audio, and send a context-aware resume cue.
 *
 * The hook is generic — it accepts a system instruction and tool set from the
 * calling application. Tool call dispatch is handled via the onToolCall callback.
 *
 * All user-supplied callbacks (onToolCall, onSessionEndRequest, onBotSpeaking,
 * onSessionEnd) are stored in refs so they never cause stale-closure bugs even
 * if the parent component re-renders between session start and message receipt.
 */

import { useState, useRef, useCallback } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../services/firebase';
import {
  GoogleGenAI,
  LiveServerMessage,
  Modality,
  Type,
  FunctionDeclaration,
  ThinkingLevel,
  StartSensitivity,
  EndSensitivity,
  SpeechConfig,
} from '@google/genai';
import { getConfig } from '../services/config';
import { Timestamp } from 'firebase/firestore';
import { Message, ConnectionStatus, TranscriptEntry } from '../types';
import { useAudioMixer } from './useAudioMixer';
import { encode } from '../services/audioUtils';
import {
  createSession,
  finalizeSession,
  archiveAudioToGCS,
  syncTranscriptToFirestore,
} from '../services/storage';

const GEMINI_MODEL = 'gemini-3.1-flash-live-preview';

/** Maximum seconds of audio lookahead before triggering a runaway-loop reset. */
const MAX_AUDIO_LOOKAHEAD_S = 30;

/** Maximum auto-reconnect attempts per session before giving up. */
const MAX_RECONNECT_ATTEMPTS = 3;

/** Word overlap ratio above which a bot turn is considered a repetition (0–1). */
const REPETITION_THRESHOLD = 0.85;

/** Minimum words in a turn before repetition detection fires. */
const REPETITION_MIN_WORDS = 12;

/** Compute word-overlap ratio between two strings to detect near-duplicate bot turns. */
function wordOverlapRatio(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const wa = tokenize(a);
  const wb = tokenize(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) {
    if (wb.has(w)) shared++;
  }
  return shared / Math.min(wa.size, wb.size);
}

export interface UseSessionOptions {
  userId: string;
  /** The full system instruction for Gemini. */
  systemInstruction: string;
  /** Tool declarations to register with Gemini. */
  tools?: FunctionDeclaration[];
  /**
   * Called when Gemini invokes a tool. The return value is sent back as the
   * tool result. Return a string describing the result.
   */
  onToolCall?: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Called when the bot requests to end the session via the 'endSession' tool. */
  onSessionEndRequest?: () => void;
  /**
   * Called after the session is fully finalized (audio uploaded, Firestore
   * updated). Use this to trigger post-session analysis, clean up state, etc.
   */
  onSessionEnd?: () => void;
  /** Called when bot audio starts or stops playing (for UI feedback). */
  onBotSpeaking?: (speaking: boolean) => void;
  /**
   * Text sent via sendRealtimeInput immediately after connecting so the bot
   * takes the first turn. Use bracket notation to signal it is a system cue,
   * not actual user speech — e.g. "[Session started. Please greet the family.]"
   * Omit to leave the user to speak first.
   */
  autoGreetText?: string;
  /**
   * Voice configuration for the Gemini model (e.g. prebuilt voice name).
   * Passed directly to the Gemini Live API `speechConfig` field.
   * Omit to use the model default.
   */
  speechConfig?: SpeechConfig;
  /**
   * Firestore collection path for session documents.
   * Default: 'sessions' (top-level flat collection).
   * For apps with nested/scoped sessions use a path like:
   *   'families/{familyId}/dossiers/{dossierId}/sessions'
   * The transcript subcollection and finalization calls all use this prefix.
   */
  sessionsCollection?: string;
}

export interface UseSessionReturn {
  messages: Message[];
  connectionStatus: ConnectionStatus;
  /**
   * Start a new session. Accepts optional overrides so callers that build the
   * instruction and/or greeting just before calling startSession can bypass the
   * React state propagation delay (stale-closure problem).
   *
   * @param overrideInstruction - System instruction to use instead of options.systemInstruction
   * @param overrideAutoGreetText - Opening cue to send instead of options.autoGreetText
   */
  startSession: (overrideInstruction?: string, overrideAutoGreetText?: string) => Promise<void>;
  stopSession: () => Promise<void>;
  isRecording: boolean;
  sessionId: string | null;
  error: string | null;
}

export function useSession(options: UseSessionOptions): UseSessionReturn {
  const {
    userId,
    systemInstruction,
    tools = [],
    autoGreetText,
    sessionsCollection = 'sessions',
  } = options;

  // Speech config ref — updated every render so reconnect uses latest voice setting
  const speechConfigRef = useRef(options.speechConfig);
  speechConfigRef.current = options.speechConfig;

  // ---------------------------------------------------------------------------
  // Callback refs — updated every render, read by stable callbacks to prevent
  // stale closures when the parent component re-renders mid-session.
  // ---------------------------------------------------------------------------
  const onToolCallRef = useRef(options.onToolCall);
  onToolCallRef.current = options.onToolCall;
  const onSessionEndRequestRef = useRef(options.onSessionEndRequest);
  onSessionEndRequestRef.current = options.onSessionEndRequest;
  const onSessionEndRef = useRef(options.onSessionEnd);
  onSessionEndRef.current = options.onSessionEnd;
  const onBotSpeakingRef = useRef(options.onBotSpeaking);
  onBotSpeakingRef.current = options.onBotSpeaking;

  // Current instruction and tools stored in refs so reconnect uses latest values
  const systemInstructionRef = useRef(systemInstruction);
  systemInstructionRef.current = systemInstruction;
  const toolsRef = useRef(tools);
  toolsRef.current = tools;
  const sessionsCollectionRef = useRef(sessionsCollection);
  sessionsCollectionRef.current = sessionsCollection;
  const autoGreetTextRef = useRef(autoGreetText);
  autoGreetTextRef.current = autoGreetText;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const [messages, setMessages] = useState<Message[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [isRecording, setIsRecording] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Refs
  // ---------------------------------------------------------------------------
  const sessionRef = useRef<string | null>(null);           // Firestore session ID
  const sessionStartRef = useRef<Date | null>(null);
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  const messageIndexRef = useRef(0);

  const liveSessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const scheduleTimeRef = useRef(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set()); // track for interrupt

  // Repetition detection
  const lastBotTurnRef = useRef('');

  // Reconnect state
  const isStoppingRef = useRef(false);          // true when stopSession is intentional
  const reconnectAttemptsRef = useRef(0);

  // Session telemetry counters
  const toolCallCountRef = useRef(0);
  const errorCountRef = useRef(0);

  // Worklet refs for proper cleanup
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const workletSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const mixer = useAudioMixer();

  // ---------------------------------------------------------------------------
  // Worklet cleanup
  // ---------------------------------------------------------------------------

  const disconnectWorklet = useCallback(() => {
    console.log('[Session] Disconnecting audio worklet...');
    if (workletNodeRef.current) {
      try { workletNodeRef.current.port.onmessage = null; } catch (e) { console.warn('[Session] Error clearing worklet onmessage:', e); }
      try { workletNodeRef.current.disconnect(); } catch (e) { console.warn('[Session] Error disconnecting worklet node:', e); }
      workletNodeRef.current = null;
    }
    if (workletSourceRef.current) {
      try { workletSourceRef.current.disconnect(); } catch (e) { console.warn('[Session] Error disconnecting worklet source:', e); }
      workletSourceRef.current = null;
    }
    console.log('[Session] Audio worklet disconnected.');
  }, []);

  // ---------------------------------------------------------------------------
  // Transcript helpers
  // ---------------------------------------------------------------------------

  const addMessage = useCallback((role: 'user' | 'bot' | 'tool', text: string, extra?: Partial<Message>) => {
    const msg: Message = {
      id: crypto.randomUUID(),
      role,
      text,
      timestamp: new Date(),
      ...extra,
    };
    setMessages((prev) => [...prev, msg]);
    return msg;
  }, []);

  const appendToTranscript = useCallback((role: 'user' | 'bot' | 'tool', text: string, extra?: Partial<TranscriptEntry>) => {
    const entry: TranscriptEntry = {
      role,
      text,
      timestamp: Timestamp.now(),
      messageIndex: messageIndexRef.current++,
      ...extra,
    };
    transcriptRef.current = [...transcriptRef.current, entry];
    if (sessionRef.current) {
      syncTranscriptToFirestore(sessionRef.current, transcriptRef.current, sessionsCollectionRef.current).catch((err) => {
        console.error('[Session] Transcript sync failed:', err);
      });
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Audio playback + interrupt
  // ---------------------------------------------------------------------------

  /** Stop all active bot audio sources immediately (e.g. on bot repetition or interrupt). */
  const stopActiveAudio = useCallback(() => {
    for (const source of activeSourcesRef.current) {
      try { source.stop(); } catch { /* already ended */ }
    }
    activeSourcesRef.current.clear();
    scheduleTimeRef.current = audioContextRef.current?.currentTime ?? 0;
    onBotSpeakingRef.current?.(false);
  }, []);

  function playAudioChunk(pcm24k: ArrayBuffer): void {
    const ctx = audioContextRef.current;
    if (!ctx || ctx.state === 'closed') return;

    const pcmData = new Int16Array(pcm24k);
    const float32 = new Float32Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) float32[i] = pcmData[i] / 32768;

    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Connect to speakers
    source.connect(ctx.destination);
    // Also connect to mixer recording destination so bot audio is archived
    if (mixer.mixedDest) source.connect(mixer.mixedDest);

    const now = ctx.currentTime;
    const startAt = Math.max(now, scheduleTimeRef.current);

    if (startAt - now > MAX_AUDIO_LOOKAHEAD_S) {
      console.warn('[Session] Audio lookahead exceeded MAX — interrupting and resetting');
      stopActiveAudio();
      return;
    }

    activeSourcesRef.current.add(source);
    source.onended = () => {
      activeSourcesRef.current.delete(source);
      // If no more scheduled audio, notify speaking stopped
      if (scheduleTimeRef.current <= ctx.currentTime + 0.05) {
        onBotSpeakingRef.current?.(false);
      }
    };

    source.start(startAt);
    scheduleTimeRef.current = startAt + buffer.duration;
    onBotSpeakingRef.current?.(true);
  }

  // ---------------------------------------------------------------------------
  // Gemini message handler
  // ---------------------------------------------------------------------------

  function handleServerMessage(msg: LiveServerMessage): void {
    // Audio output — play chunks and record them to the archive via mixedDest
    if (msg.serverContent?.modelTurn?.parts) {
      for (const part of msg.serverContent.modelTurn.parts) {
        if (part.inlineData?.mimeType?.startsWith('audio/pcm')) {
          const raw = atob(part.inlineData.data ?? '');
          const bytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          playAudioChunk(bytes.buffer);
        }
      }
    }

    // Output audio transcription (Gemini 3.1+)
    if (msg.serverContent?.outputTranscription?.text) {
      const text = msg.serverContent.outputTranscription.text;
      if (text.trim()) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === 'bot') {
            return [...prev.slice(0, -1), { ...last, text: last.text + text }];
          }
          return [...prev, { id: crypto.randomUUID(), role: 'bot', text, timestamp: new Date() }];
        });
      }
    }

    // Text output (fallback for non-audio-only models)
    if (msg.serverContent?.modelTurn?.parts) {
      const textParts = msg.serverContent.modelTurn.parts
        .filter((p) => p.text)
        .map((p) => p.text!)
        .join('');
      if (textParts) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === 'bot') {
            return [...prev.slice(0, -1), { ...last, text: last.text + textParts }];
          }
          return [...prev, { id: crypto.randomUUID(), role: 'bot', text: textParts, timestamp: new Date() }];
        });
      }
    }

    // Turn complete — flush to transcript and run repetition detection
    if (msg.serverContent?.turnComplete) {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === 'bot' && last.text.trim()) {
          const text = last.text.trim();
          appendToTranscript('bot', text);

          // Repetition detection: if the bot repeated itself nearly verbatim,
          // stop the audio and nudge it to move on.
          const words = text.split(/\s+/).length;
          if (
            lastBotTurnRef.current &&
            words >= REPETITION_MIN_WORDS &&
            wordOverlapRatio(text, lastBotTurnRef.current) >= REPETITION_THRESHOLD
          ) {
            console.warn('[Session] Repetition detected — interrupting and sending recovery prompt');
            stopActiveAudio();
            liveSessionRef.current?.sendRealtimeInput({
              text: '[System: you just repeated yourself almost verbatim. Do not repeat. Move the conversation forward by asking a new question or exploring a new topic.]',
            });
          } else {
            lastBotTurnRef.current = text;
          }
        }
        return prev;
      });
    }

    // User speech (input transcription)
    if (msg.serverContent?.inputTranscription?.text) {
      const text = msg.serverContent.inputTranscription.text;
      if (text.trim()) {
        addMessage('user', text);
        appendToTranscript('user', text);
      }
    }

    // Function calls
    if (msg.toolCall?.functionCalls?.length) {
      // Handle tool calls asynchronously but don't let errors propagate into the handler
      void handleToolCalls(msg.toolCall.functionCalls);
    }
  }

  async function handleToolCalls(calls: Array<{ id?: string; name?: string; args?: unknown }>): Promise<void> {
    for (const call of calls) {
      const name = call.name ?? '';
      const args = (call.args ?? {}) as Record<string, unknown>;
      console.log(`[Session] Tool call: ${name}`, args);
      toolCallCountRef.current++;

      if (name === 'endSession') {
        console.log('[Session] endSession tool called');
        // Send acknowledgement before triggering stop so Gemini can deliver closing audio
        try {
          liveSessionRef.current?.sendToolResponse({
            functionResponses: [{ id: call.id, name, response: { result: 'ok' } }],
          });
        } catch (err) {
          console.error('[Session] sendToolResponse for endSession failed:', err);
        }
        onSessionEndRequestRef.current?.();
        return;
      }

      let result = 'Tool executed.';
      if (onToolCallRef.current) {
        try {
          result = await onToolCallRef.current(name, args);
          console.log(`[Session] Tool result for ${name}:`, result.slice(0, 200));
        } catch (err) {
          result = `Tool error: ${String(err)}`;
          console.error(`[Session] Tool ${name} threw:`, err);
        }
      }

      addMessage('tool', `[${name}]`, { toolName: name, toolArgs: args });
      appendToTranscript('tool', `[${name}]`, { toolName: name, toolArgs: args, toolResult: result.slice(0, 500) });

      try {
        liveSessionRef.current?.sendToolResponse({
          functionResponses: [{ id: call.id, name, response: { result } }],
        });
      } catch (err) {
        console.error(`[Session] sendToolResponse failed for ${name}:`, err);
        errorCountRef.current++;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: connect to Gemini Live
  // ---------------------------------------------------------------------------

  /**
   * Establishes a Gemini Live WebSocket connection and wires up the AudioWorklet.
   * Used by both startSession and the auto-reconnect path.
   *
   * @param instruction - System instruction to use (may differ between start and reconnect)
   * @param greetText - Text to send as the opening cue after connection
   * @param speechConfig - Optional Gemini speechConfig (voice name, etc.)
   * @param onConnected - Called once the connection is established (before greet)
   */
  const connectGemini = useCallback(async (
    instruction: string,
    greetText: string | undefined,
    speechConfig: SpeechConfig | undefined,
    onConnected: () => void,
  ) => {
    const ai = new GoogleGenAI({ apiKey: getConfig().geminiApiKey });

    const allTools: FunctionDeclaration[] = [
      ...toolsRef.current,
      {
        name: 'endSession',
        description: 'End the voice session. Call this only when the user explicitly signals they want to stop.',
        parameters: { type: Type.OBJECT, properties: {}, required: [] },
      } as FunctionDeclaration,
    ];

    const liveSession = await ai.live.connect({
      model: GEMINI_MODEL,
      config: {
        systemInstruction: { parts: [{ text: instruction }] },
        // Native audio models (gemini-3.1-flash-live-preview) ONLY support AUDIO modality.
        // Including TEXT causes the server to close the WebSocket immediately.
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        tools: [{ functionDeclarations: allTools }],
        // High sensitivity makes the bot interruptible faster when the user
        // begins talking — the API default is too sluggish.
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
          },
        },
        // Voice selection — only included when the caller provides a speech config
        ...(speechConfig ? { speechConfig } : {}),
      },
      callbacks: {
        onmessage: (msg: LiveServerMessage) => {
          try {
            handleServerMessage(msg);
          } catch (err) {
            console.error('[Session] handleServerMessage error:', err);
          }
        },
        onerror: (err: ErrorEvent) => {
          console.error('[Session] Gemini WebSocket error:', err);
          setError('Connection error — please try again.');
          setConnectionStatus(ConnectionStatus.ERROR);
          disconnectWorklet();
          liveSessionRef.current = null;
        },
        onclose: (event?: any) => {
          const code = event?.code ?? 'unknown';
          const wasClean = event?.wasClean ?? false;
          console.log(`[Session] Gemini connection closed — code=${code} wasClean=${wasClean} stopping=${isStoppingRef.current}`);
          disconnectWorklet();
          liveSessionRef.current = null;

          if (isStoppingRef.current) {
            // Intentional stop — do nothing, stopSession handles finalization
            return;
          }

          // Unexpected disconnect — attempt auto-reconnect
          if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttemptsRef.current++;
            console.log(`[Session] Auto-reconnect attempt ${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS}`);
            setConnectionStatus(ConnectionStatus.CONNECTING);
            void attemptReconnect();
          } else {
            console.warn('[Session] Max reconnect attempts reached — giving up');
            setConnectionStatus(ConnectionStatus.ERROR);
            setError('Connection lost — please restart the session.');
          }
        },
      },
    });

    liveSessionRef.current = liveSession;
    onConnected();

    // Start the AudioWorklet for microphone PCM streaming
    const inputCtx = mixer.inputContext!;
    const micStream = mixer.stream!;

    const workletCode = `
      class PCMProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const input = inputs[0];
          if (input && input[0] && input[0].length > 0) {
            const copy = new Float32Array(input[0]);
            this.port.postMessage({ channelData: copy }, [copy.buffer]);
          }
          return true;
        }
      }
      registerProcessor('pcm-processor', PCMProcessor);
    `;
    const workletBlob = new Blob([workletCode], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(workletBlob);
    await inputCtx.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);

    const source = inputCtx.createMediaStreamSource(micStream);
    const worklet = new AudioWorkletNode(inputCtx, 'pcm-processor');
    source.connect(worklet);
    workletSourceRef.current = source;
    workletNodeRef.current = worklet;

    let pcmFrameCount = 0;
    worklet.port.onmessage = (e: MessageEvent<{ channelData: Float32Array }>) => {
      if (!liveSessionRef.current) return;
      const float32 = e.data.channelData;
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
      }
      const pcm16 = encode(new Uint8Array(int16.buffer));

      pcmFrameCount++;
      if (pcmFrameCount <= 5 || pcmFrameCount % 200 === 0) {
        console.log(`[Session] PCM frame #${pcmFrameCount} — samples=${float32.length}`);
      }

      try {
        liveSessionRef.current.sendRealtimeInput({
          audio: { data: pcm16, mimeType: 'audio/pcm;rate=16000' },
        });
      } catch (err) {
        console.error('[Session] sendRealtimeInput failed:', err);
      }
    };

    if (greetText) {
      try {
        liveSession.sendRealtimeInput({ text: greetText });
        console.log('[Session] Opening cue sent:', greetText);
      } catch (err) {
        console.error('[Session] Opening cue failed:', err);
      }
    }
  }, [mixer, disconnectWorklet]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Auto-reconnect
  // ---------------------------------------------------------------------------

  /**
   * Reconnects to Gemini after an unexpected disconnect.
   * Flushes partial audio to GCS, restarts the mixer, and sends a context-aware
   * resume prompt so the bot can acknowledge the interruption naturally.
   */
  const attemptReconnect = useCallback(async () => {
    const existingSessionId = sessionRef.current;
    console.log(`[Session] Reconnecting — session=${existingSessionId}, transcript entries=${transcriptRef.current.length}`);

    // Flush partial audio before restarting mixer
    const partialBlob = mixer.flush();
    if (partialBlob && existingSessionId) {
      archiveAudioToGCS(partialBlob, userId, existingSessionId).catch((err) =>
        console.error('[Session] Partial audio upload failed:', err),
      );
    }

    // Restart the mixer for new audio capture
    try {
      await mixer.stop().catch(() => null);
      await mixer.start();
      audioContextRef.current = mixer.playbackContext ?? new AudioContext({ sampleRate: 24000 });
      scheduleTimeRef.current = 0;
      activeSourcesRef.current.clear();
    } catch (err) {
      console.error('[Session] Failed to restart audio mixer during reconnect:', err);
      setConnectionStatus(ConnectionStatus.ERROR);
      return;
    }

    // Build resume context from recent transcript
    const recentEntries = transcriptRef.current.slice(-20);
    const recentContext = recentEntries
      .map((e) => `${e.role === 'user' ? 'User' : 'Assistant'}: ${e.text}`)
      .join('\n');
    const resumeCue = recentContext
      ? `[Network interruption. Briefly acknowledge the glitch, recap the specific moment you were at, then continue naturally. Recent context:\n${recentContext}]`
      : `[Network interruption. Briefly acknowledge the glitch, then invite the user to continue.]`;

    try {
      await connectGemini(systemInstructionRef.current, resumeCue, speechConfigRef.current, () => {
        // Restore session ID — we're continuing the same session, not starting a new one
        if (existingSessionId) {
          sessionRef.current = existingSessionId;
          setSessionId(existingSessionId);
        }
        setConnectionStatus(ConnectionStatus.CONNECTED);
        console.log('[Session] Reconnect successful');
      });
    } catch (err) {
      console.error('[Session] Reconnect failed:', err);
      setConnectionStatus(ConnectionStatus.ERROR);
      setError('Reconnect failed — please restart the session.');
    }
  }, [userId, mixer, connectGemini]);

  // ---------------------------------------------------------------------------
  // Session lifecycle: start
  // ---------------------------------------------------------------------------

  const startSession = useCallback(async (overrideInstruction?: string, overrideAutoGreetText?: string) => {
    if (isRecording) {
      console.log('[Session] startSession called but already recording — ignoring');
      return;
    }
    setError(null);
    setMessages([]);
    transcriptRef.current = [];
    messageIndexRef.current = 0;
    lastBotTurnRef.current = '';
    isStoppingRef.current = false;
    reconnectAttemptsRef.current = 0;
    toolCallCountRef.current = 0;
    errorCountRef.current = 0;

    const instructionToUse = overrideInstruction ?? systemInstructionRef.current;
    const greetToUse = overrideAutoGreetText !== undefined ? overrideAutoGreetText : autoGreetTextRef.current;

    try {
      console.log('[Session] Starting session for user:', userId);

      // Create Firestore session record
      const sId = await createSession(userId, sessionsCollectionRef.current);
      sessionRef.current = sId;
      setSessionId(sId);
      sessionStartRef.current = new Date();
      console.log('[Session] Firestore session created:', sId);

      // Start audio mixer (captures mic + bot audio for archival)
      await mixer.start();
      audioContextRef.current = mixer.playbackContext ?? new AudioContext({ sampleRate: 24000 });
      scheduleTimeRef.current = 0;
      activeSourcesRef.current.clear();
      console.log('[Session] Audio mixer started');

      // Connect to Gemini Live
      await connectGemini(instructionToUse, greetToUse, speechConfigRef.current, () => {
        setConnectionStatus(ConnectionStatus.CONNECTED);
        setIsRecording(true);
        console.log('[Session] Session ready, sessionRef set');
      });
    } catch (err) {
      console.error('[Session] Start error:', err);
      setError(`Failed to start session: ${String(err)}`);
      setConnectionStatus(ConnectionStatus.ERROR);

      // Clean up orphaned Firestore session if connect failed after creation
      if (sessionRef.current) {
        finalizeSession(sessionRef.current, 'interrupted', 0, undefined, sessionsCollectionRef.current).catch(console.error);
        sessionRef.current = null;
        setSessionId(null);
      }
      mixer.stop().catch(() => null);
    }
  }, [isRecording, userId, mixer, connectGemini]);

  // ---------------------------------------------------------------------------
  // Session lifecycle: stop
  // ---------------------------------------------------------------------------

  const stopSession = useCallback(async () => {
    if (!isRecording) {
      console.log('[Session] stopSession called but not recording — ignoring');
      return;
    }
    console.log('[Session] Stopping session...');
    isStoppingRef.current = true;
    setIsRecording(false);
    setConnectionStatus(ConnectionStatus.DISCONNECTED);
    stopActiveAudio();

    try {
      disconnectWorklet();
      liveSessionRef.current?.close();
      liveSessionRef.current = null;
      audioContextRef.current = null;

      const audioBlob = await mixer.stop();
      const duration = sessionStartRef.current
        ? Math.round((Date.now() - sessionStartRef.current.getTime()) / 1000)
        : 0;
      console.log(`[Session] Recording stopped — duration=${duration}s, blobSize=${audioBlob?.size ?? 0}`);

      let audioUrl: string | undefined;
      if (audioBlob && sessionRef.current) {
        try {
          audioUrl = await archiveAudioToGCS(audioBlob, userId, sessionRef.current);
          console.log('[Session] Audio uploaded:', audioUrl);
        } catch (err) {
          console.error('[Session] Audio upload failed:', err);
        }
      }

      if (sessionRef.current) {
        await finalizeSession(sessionRef.current, 'completed', duration, audioUrl, sessionsCollectionRef.current);
        console.log('[Session] Session finalized');

        // Merge session telemetry metrics into the session document
        try {
          const sessionMetrics = {
            reconnectCount: reconnectAttemptsRef.current,
            toolCallCount: toolCallCountRef.current,
            errorCount: errorCountRef.current,
            durationSeconds: duration,
          };
          await updateDoc(doc(db, sessionsCollectionRef.current, sessionRef.current), { sessionMetrics });
          console.log('[Session] Session metrics written:', sessionMetrics);
        } catch (err) {
          console.error('[Session] Failed to write session metrics:', err);
        }
      }

      // Notify caller — use for post-session analysis, clean-up, etc.
      onSessionEndRef.current?.();
    } catch (err) {
      console.error('[Session] Stop error:', err);
      if (sessionRef.current) {
        await finalizeSession(sessionRef.current, 'interrupted', 0, undefined, sessionsCollectionRef.current).catch(console.error);
      }
      onSessionEndRef.current?.();
    }
  }, [isRecording, userId, mixer, disconnectWorklet, stopActiveAudio]);

  return {
    messages,
    connectionStatus,
    startSession,
    stopSession,
    isRecording,
    sessionId,
    error,
  };
}
