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
 *   2. During: Stream PCM to Gemini, play bot audio, sync transcript in real-time
 *   3. Stop: Close Gemini, stop recorder, upload audio to GCS, finalize session
 *   4. Error: Auto-reconnect preserving session context
 *
 * The hook is generic — it accepts a system instruction and tool set from the
 * calling application. Tool call dispatch is handled via the onToolCall callback.
 */

import { useState, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration, ThinkingLevel } from '@google/genai';
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

/** Compute word-overlap ratio between two strings to detect near-duplicate bot turns. */
function wordOverlapRatio(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const wa = tokenize(a);
  const wb = tokenize(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) { if (wb.has(w)) shared++; }
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
  /** Called when bot audio starts playing (for UI feedback). */
  onBotSpeaking?: (speaking: boolean) => void;
  /**
   * When true, a hidden text turn is sent immediately after the session
   * connects so the bot takes the first turn (greets the user).
   * The system instruction should describe what to say.
   */
  autoGreet?: boolean;
}

export interface UseSessionReturn {
  messages: Message[];
  connectionStatus: ConnectionStatus;
  /**
   * Start a new session. Accepts an optional instruction override so callers
   * that build the instruction just before calling startSession can bypass
   * the React state propagation delay (stale-closure problem).
   */
  startSession: (overrideInstruction?: string) => Promise<void>;
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
    onToolCall,
    onSessionEndRequest,
    onBotSpeaking,
    autoGreet = false,
  } = options;

  const [messages, setMessages] = useState<Message[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [isRecording, setIsRecording] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<string | null>(null);
  const sessionStartRef = useRef<Date | null>(null);
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  const messageIndexRef = useRef(0);

  const liveSessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const scheduleTimeRef = useRef(0);

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
      console.log(`[Session] Syncing transcript to Firestore (session=${sessionRef.current}, entries=${transcriptRef.current.length})`);
      syncTranscriptToFirestore(sessionRef.current, transcriptRef.current).catch((err) => {
        console.error('[Session] Transcript sync failed:', err);
      });
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Audio playback
  // ---------------------------------------------------------------------------

  function playAudioChunk(pcm24k: ArrayBuffer): void {
    if (!audioContextRef.current) return;
    const ctx = audioContextRef.current;
    const pcmData = new Int16Array(pcm24k);
    const float32 = new Float32Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) float32[i] = pcmData[i] / 32768;

    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(now, scheduleTimeRef.current);
    if (startAt - now > MAX_AUDIO_LOOKAHEAD_S) {
      console.warn('[Session] Audio lookahead exceeded MAX — resetting schedule time');
      scheduleTimeRef.current = now;
      return;
    }
    source.start(startAt);
    scheduleTimeRef.current = startAt + buffer.duration;

    if (onBotSpeaking) {
      onBotSpeaking(true);
      source.onended = () => {
        if (scheduleTimeRef.current <= ctx.currentTime + 0.05) onBotSpeaking(false);
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Gemini message handler
  // ---------------------------------------------------------------------------

  async function handleServerMessage(msg: LiveServerMessage): Promise<void> {
    // Audio output
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

    // Output audio transcription (new in Gemini 3.1)
    if (msg.serverContent?.outputTranscription?.text) {
      const text = msg.serverContent.outputTranscription.text;
      console.log('[Session] Output transcription chunk:', text);
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

    // Text output — accumulate into bot turn (fallback for text-capable models)
    if (msg.serverContent?.modelTurn?.parts) {
      const textParts = msg.serverContent.modelTurn.parts
        .filter((p) => p.text)
        .map((p) => p.text!)
        .join('');
      if (textParts) {
        console.log('[Session] Text part from modelTurn:', textParts);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === 'bot') {
            return [...prev.slice(0, -1), { ...last, text: last.text + textParts }];
          }
          return [...prev, { id: crypto.randomUUID(), role: 'bot', text: textParts, timestamp: new Date() }];
        });
      }
    }

    // Turn complete — flush bot turn to transcript
    if (msg.serverContent?.turnComplete) {
      console.log('[Session] Turn complete — flushing bot turn to transcript');
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === 'bot' && last.text.trim()) {
          appendToTranscript('bot', last.text.trim());
        }
        return prev;
      });
    }

    // User speech (input transcription)
    if (msg.serverContent?.inputTranscription?.text) {
      const text = msg.serverContent.inputTranscription.text;
      console.log('[Session] Input transcription:', text);
      if (text.trim()) {
        addMessage('user', text);
        appendToTranscript('user', text);
      }
    }

    // Function calls
    if (msg.toolCall?.functionCalls?.length) {
      for (const call of msg.toolCall.functionCalls) {
        const name = call.name ?? '';
        const args = (call.args ?? {}) as Record<string, unknown>;
        console.log(`[Session] Tool call: ${name}`, args);

        if (name === 'endSession') {
          console.log('[Session] endSession tool called — signaling session end request');
          onSessionEndRequest?.();
          return;
        }

        let result = 'Tool executed.';
        if (onToolCall) {
          try {
            result = await onToolCall(name, args);
            console.log(`[Session] Tool result for ${name}:`, result.slice(0, 200));
          } catch (err) {
            result = `Tool error: ${String(err)}`;
            console.error(`[Session] Tool ${name} threw:`, err);
          }
        }

        addMessage('tool', `[${name}]`, { toolName: name, toolArgs: args });
        appendToTranscript('tool', `[${name}]`, { toolName: name, toolArgs: args, toolResult: result.slice(0, 500) });

        liveSessionRef.current?.sendToolResponse({
          functionResponses: [{ id: call.id, name, response: { result } }],
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  const startSession = useCallback(async (overrideInstruction?: string) => {
    if (isRecording) {
      console.log('[Session] startSession called but already recording — ignoring');
      return;
    }
    setError(null);
    setMessages([]);
    transcriptRef.current = [];
    messageIndexRef.current = 0;

    // Use the override if provided (avoids stale-closure when the caller builds
    // the instruction and calls startSession in the same tick as setState).
    const instructionToUse = overrideInstruction ?? systemInstruction;

    try {
      console.log('[Session] Starting session for user:', userId);

      // Create Firestore session
      console.log('[Session] Creating Firestore session...');
      const sId = await createSession(userId);
      sessionRef.current = sId;
      setSessionId(sId);
      sessionStartRef.current = new Date();
      console.log('[Session] Firestore session created:', sId);

      // Start audio mixer (captures mic + bot audio for archival)
      console.log('[Session] Starting audio mixer...');
      await mixer.start();
      console.log('[Session] Audio mixer started. inputContext:', mixer.inputContext?.state, 'playbackContext:', mixer.playbackContext?.state);

      // Reuse the mixer's playback AudioContext (24kHz) for bot audio scheduling
      audioContextRef.current = mixer.playbackContext ?? new AudioContext({ sampleRate: 24000 });
      scheduleTimeRef.current = 0;
      console.log('[Session] AudioContext for playback — sampleRate:', audioContextRef.current.sampleRate, 'state:', audioContextRef.current.state);

      // Connect to Gemini Live
      console.log('[Session] Connecting to Gemini Live model:', GEMINI_MODEL);
      const ai = new GoogleGenAI({ apiKey: getConfig().geminiApiKey });

      const allTools = [
        ...tools,
        {
          name: 'endSession',
          description: 'End the voice session. Call this only when the user explicitly signals they want to stop.',
          parameters: { type: Type.OBJECT, properties: {}, required: [] },
        } as FunctionDeclaration,
      ];

      console.log('[Session] Gemini config:', {
        model: GEMINI_MODEL,
        modalities: ['AUDIO'],
        toolCount: allTools.length,
        systemInstructionLength: instructionToUse.length,
      });
      console.log('[Session] System instruction:\n', instructionToUse);

      const liveSession = await ai.live.connect({
        model: GEMINI_MODEL,
        config: {
          systemInstruction: { parts: [{ text: instructionToUse }] },
          // Native audio models (gemini-3.1-flash-live-preview) ONLY support AUDIO modality.
          // Including TEXT causes the server to close the WebSocket immediately.
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},  // New in Gemini 3.1
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          tools: [{ functionDeclarations: allTools }],
        },
        callbacks: {
          onmessage: (msg: LiveServerMessage) => {
            handleServerMessage(msg).catch((err) => console.error('[Session] handleServerMessage error:', err));
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
            const reason = event?.reason ? `"${event.reason}"` : '(no reason)';
            const wasClean = event?.wasClean ?? 'unknown';
            console.log(`[Session] Gemini connection closed — code=${code} reason=${reason} wasClean=${wasClean}`);
            disconnectWorklet();
            liveSessionRef.current = null;
            setConnectionStatus(ConnectionStatus.DISCONNECTED);
          },
        },
      });

      liveSessionRef.current = liveSession;
      console.log('[Session] Gemini Live connected successfully');
      setConnectionStatus(ConnectionStatus.CONNECTED);
      setIsRecording(true);

      // Start streaming microphone PCM to Gemini via AudioWorklet.
      // The worklet code is inlined as a Blob URL so no static file is needed.
      console.log('[Session] Setting up AudioWorklet for microphone capture...');
      const inputCtx = mixer.inputContext!;
      const micStream = mixer.stream!;
      console.log('[Session] inputContext state:', inputCtx.state, 'sampleRate:', inputCtx.sampleRate);

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
      console.log('[Session] Loading AudioWorklet module from Blob URL...');
      await inputCtx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);
      console.log('[Session] AudioWorklet module loaded');

      const source = inputCtx.createMediaStreamSource(micStream);
      const worklet = new AudioWorkletNode(inputCtx, 'pcm-processor');
      source.connect(worklet);

      // Store refs for cleanup
      workletSourceRef.current = source;
      workletNodeRef.current = worklet;
      console.log('[Session] AudioWorklet connected — microphone streaming active');

      let pcmFrameCount = 0;
      worklet.port.onmessage = (e: MessageEvent<{ channelData: Float32Array }>) => {
        if (!liveSessionRef.current) return;
        // Convert Float32 samples to Int16, then to Uint8Array for base64 encoding
        const float32 = e.data.channelData;
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
        }
        const pcm16 = encode(new Uint8Array(int16.buffer));

        pcmFrameCount++;
        if (pcmFrameCount <= 5 || pcmFrameCount % 100 === 0) {
          console.log(`[Session] Sending PCM frame #${pcmFrameCount} — samples=${float32.length}, bytes=${int16.byteLength}`);
        }

        try {
          liveSessionRef.current.sendRealtimeInput({
            audio: { data: pcm16, mimeType: 'audio/pcm;rate=16000' },
          });
        } catch (err) {
          console.error('[Session] sendRealtimeInput failed:', err);
        }
      };

      // Trigger the bot to take the first turn.
      // For native audio models, we simulate a complete (silent) user turn:
      //   activityStart → 100ms silence → activityEnd
      // The VAD sees a completed turn with no speech and triggers the model
      // to respond immediately with its opening greeting.
      if (autoGreet) {
        console.log('[Session] Sending auto-greet trigger (silent turn)...');
        try {
          // 100ms of silence at 16kHz = 1600 Int16 samples = 3200 bytes
          const silence = new Uint8Array(1600 * 2); // all zeros
          const silenceB64 = encode(silence);
          liveSession.sendRealtimeInput({ activityStart: {} });
          liveSession.sendRealtimeInput({ audio: { data: silenceB64, mimeType: 'audio/pcm;rate=16000' } });
          liveSession.sendRealtimeInput({ activityEnd: {} });
          console.log('[Session] Auto-greet trigger sent.');
        } catch (err) {
          console.error('[Session] Auto-greet trigger failed:', err);
        }
      }
    } catch (err) {
      console.error('[Session] Start error:', err);
      setError(`Failed to start session: ${String(err)}`);
      setConnectionStatus(ConnectionStatus.ERROR);
    }
  }, [isRecording, userId, systemInstruction, tools, mixer, onToolCall, onSessionEndRequest, disconnectWorklet, autoGreet]);

  const stopSession = useCallback(async () => {
    if (!isRecording) {
      console.log('[Session] stopSession called but not recording — ignoring');
      return;
    }
    console.log('[Session] Stopping session...');
    setIsRecording(false);
    setConnectionStatus(ConnectionStatus.DISCONNECTED);

    try {
      disconnectWorklet();

      liveSessionRef.current?.close();
      liveSessionRef.current = null;
      console.log('[Session] Gemini Live session closed');

      audioContextRef.current = null;

      console.log('[Session] Stopping audio mixer and collecting recording...');
      const audioBlob = await mixer.stop();
      const duration = sessionStartRef.current
        ? Math.round((Date.now() - sessionStartRef.current.getTime()) / 1000)
        : 0;
      console.log(`[Session] Recording stopped — duration=${duration}s, blobSize=${audioBlob?.size ?? 0}`);

      let audioUrl: string | undefined;
      if (audioBlob && sessionRef.current) {
        console.log('[Session] Uploading audio to GCS...');
        try {
          audioUrl = await archiveAudioToGCS(audioBlob, userId, sessionRef.current);
          console.log('[Session] Audio uploaded:', audioUrl);
        } catch (err) {
          console.error('[Session] Audio upload failed:', err);
        }
      }

      if (sessionRef.current) {
        console.log('[Session] Finalizing Firestore session...');
        await finalizeSession(sessionRef.current, 'completed', duration, audioUrl);
        console.log('[Session] Session finalized');
      }
    } catch (err) {
      console.error('[Session] Stop error:', err);
      if (sessionRef.current) {
        await finalizeSession(sessionRef.current, 'interrupted', 0).catch(console.error);
      }
    }
  }, [isRecording, userId, mixer, disconnectWorklet]);

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
