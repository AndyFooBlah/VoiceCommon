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
import { mintLiveToken } from '../services/config';
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
  /**
   * Additional fields to merge into the session document in Firestore.
   * Useful for app-specific metadata (e.g. LegacyBot's storytellerUid).
   */
  additionalSessionData?: Record<string, any>;
  /**
   * Override for audio archival. When provided, VoiceCommon calls this instead
   * of its default `sessions/{userId}/{sessionId}.webm` upload path. Use this
   * when the consuming app has Storage rules scoped to a different layout
   * (e.g. LegacyBot uses `{familyId}/{dossierId}/{sessionId}.webm`).
   * Must return a downloadable URL (or empty string) after upload completes.
   */
  archiveAudio?: (
    blob: Blob,
    userId: string,
    sessionId: string,
  ) => Promise<string>;
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
   * @param overrideTools - Tool declarations to use instead of options.tools.
   *   The same list is also used on auto-reconnect within the session
   *   (stored in toolsRef), so a session that started with a fresh set
   *   of tools fetched from a backend will continue to use them on
   *   reconnect.
   */
  startSession: (
    overrideInstruction?: string,
    overrideAutoGreetText?: string,
    overrideTools?: FunctionDeclaration[],
  ) => Promise<void>;
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
  const archiveAudioRef = useRef(options.archiveAudio);
  archiveAudioRef.current = options.archiveAudio;
  const autoGreetTextRef = useRef(autoGreetText);
  autoGreetTextRef.current = autoGreetText;
  const additionalSessionDataRef = useRef(options.additionalSessionData);
  additionalSessionDataRef.current = options.additionalSessionData;

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

  // Turn tracking for tool-call cancellation on interrupt
  const currentTurnIdRef = useRef(0);
  const cancelledTurnsRef = useRef<Set<number>>(new Set());

  // Per-turn timing instrumentation.
  //
  // Logs each significant model-output event with millisecond offsets so the
  // consumer can see, on a single timeline, *exactly* when filler text was
  // produced vs. when a tool call was dispatched. Specifically helpful for
  // diagnosing "the bot calls the tool first and then says 'one sec' after"
  // problems — those show up here as a `tool-call` event before any
  // `audio-chunk` / `output-text` events in the same turn.
  //
  // All event times are taken at the moment the event arrives over the
  // WebSocket, not when the audio finishes playing. The audio queue depth
  // (in ms) is also logged so you can tell whether scheduled audio has been
  // delivered before a tool call lands.
  const turnStartMsRef = useRef<number>(0);
  const turnHasEventsRef = useRef(false);
  const turnAudioMsRef = useRef(0);
  const turnTextRef = useRef('');
  const turnEventCountRef = useRef(0);

  function logTurnEvent(label: string, extra: string = ''): void {
    const now = performance.now();
    if (!turnHasEventsRef.current) {
      turnStartMsRef.current = now;
      turnHasEventsRef.current = true;
      turnAudioMsRef.current = 0;
      turnTextRef.current = '';
      turnEventCountRef.current = 0;
    }
    turnEventCountRef.current += 1;
    const offset = (now - turnStartMsRef.current).toFixed(0).padStart(5, ' ');
    // Audio queue depth: ms of scheduled bot audio still ahead of the
    // playback cursor. Lets you correlate "tool-call at +120ms with 0ms
    // queued" (silent dispatch) vs. "+1200ms with 800ms queued" (filler
    // already playing).
    const ctx = audioContextRef.current;
    const queuedMs = ctx
      ? Math.max(0, (scheduleTimeRef.current - ctx.currentTime) * 1000).toFixed(0)
      : '?';
    console.log(
      `[Session-Turn turn=${currentTurnIdRef.current} +${offset}ms #${turnEventCountRef.current} queue=${queuedMs}ms] ${label}${extra ? ' ' + extra : ''}`,
    );
  }

  function resetTurnTiming(reason: string): void {
    if (turnHasEventsRef.current) {
      const totalAudio = turnAudioMsRef.current.toFixed(0);
      const transcript = turnTextRef.current.trim().slice(0, 120);
      console.log(
        `[Session-Turn turn=${currentTurnIdRef.current} END reason=${reason} events=${turnEventCountRef.current} audio=${totalAudio}ms text=${JSON.stringify(transcript)}]`,
      );
    }
    turnHasEventsRef.current = false;
  }

  // Current bot turn accumulator.
  //
  // We track the text of the in-progress bot turn in a ref (not derived from
  // messages state) so turnComplete can finalize exactly once without reading
  // through a setMessages updater — side effects inside updaters are not
  // idempotent under React 18 concurrent rendering and caused duplicated
  // transcript entries.
  //
  // `currentBotTurnRef` holds the accumulating text of the active turn.
  // `botTurnSealedRef` is true when the last bot turn has been finalized
  // (via turnComplete or interrupted) — the next transcription chunk then
  // starts a fresh message rather than appending to the previous one.
  const currentBotTurnRef = useRef('');
  const botTurnSealedRef = useRef(true);

  // Reconnect state
  const isStoppingRef = useRef(false);          // true when stopSession is intentional
  const reconnectAttemptsRef = useRef(0);
  // Guards against concurrent reconnect flows when onclose fires multiple times.
  // Without this, two reconnect flows can spawn two mixers (and two mic/bot
  // pipelines) — the root cause of the "two audio streams playing" symptom.
  const reconnectInProgressRef = useRef(false);
  // Synchronous guard against startSession re-entry. setIsRecording(true) is
  // async so two rapid calls (StrictMode double-invoke, double-clicks) can both
  // pass the isRecording check — the ref closes the window.
  const startInProgressRef = useRef(false);

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
        // M13: Firestore error objects may embed raw request payloads /
        // document data in `err.data` or `.stack`, and transcript rows
        // contain user speech. Log only the code + message.
        const code = (err as { code?: string })?.code ?? 'unknown';
        const message = (err as { message?: string })?.message ?? 'no-message';
        console.error(`[Session] Transcript sync failed: code=${code} message=${message}`);
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

  /**
   * Append text to the in-progress bot turn, both to the ref (for
   * finalization) and to messages state (for live UI rendering).
   * Starts a new message on a sealed boundary; otherwise extends the last.
   */
  function appendBotChunk(text: string): void {
    if (!text) return;
    currentBotTurnRef.current += text;
    const sealed = botTurnSealedRef.current;
    botTurnSealedRef.current = false;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!sealed && last?.role === 'bot') {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...prev, { id: crypto.randomUUID(), role: 'bot', text, timestamp: new Date() }];
    });
  }

  /**
   * Finalize the current bot turn: write to transcript, run repetition
   * detection, reset accumulator. Safe to call zero or many times per turn —
   * does nothing if the accumulator is empty or already sealed.
   */
  function sealBotTurn(reason: 'turnComplete' | 'interrupted'): void {
    if (botTurnSealedRef.current) return;
    const text = currentBotTurnRef.current.trim();
    currentBotTurnRef.current = '';
    botTurnSealedRef.current = true;
    if (!text) return;

    appendToTranscript('bot', text);

    if (reason === 'turnComplete') {
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
  }

  function handleServerMessage(msg: LiveServerMessage): void {
    // User barge-in — Gemini signals the model's current turn was interrupted
    // by user speech. Stop any queued bot audio immediately and seal the
    // partial transcript so the next bot chunk starts a fresh message.
    if (msg.serverContent?.interrupted) {
      console.log('[Session] User interrupted — purging bot audio queue');
      logTurnEvent('interrupted', '(barge-in)');
      resetTurnTiming('interrupted');
      cancelledTurnsRef.current.add(currentTurnIdRef.current);
      currentTurnIdRef.current += 1;
      stopActiveAudio();
      sealBotTurn('interrupted');
    }

    // Audio output — play chunks and record them to the archive via mixedDest
    if (msg.serverContent?.modelTurn?.parts) {
      let audioChunkCount = 0;
      let totalSamples = 0;
      for (const part of msg.serverContent.modelTurn.parts) {
        if (part.inlineData?.mimeType?.startsWith('audio/pcm')) {
          const raw = atob(part.inlineData.data ?? '');
          const bytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          playAudioChunk(bytes.buffer);
          audioChunkCount += 1;
          // PCM16 @ 24kHz → 2 bytes per sample → ms = bytes / (24000 * 2 / 1000)
          totalSamples += bytes.length / 2;
        }
      }
      if (audioChunkCount > 0) {
        const chunkMs = (totalSamples / 24).toFixed(0); // 24 samples/ms at 24kHz
        turnAudioMsRef.current += Number(chunkMs);
        logTurnEvent('audio-chunk', `count=${audioChunkCount} duration=${chunkMs}ms`);
      }
    }

    // Output audio transcription (Gemini 3.1+)
    if (msg.serverContent?.outputTranscription?.text) {
      const text = msg.serverContent.outputTranscription.text;
      if (text.trim()) {
        turnTextRef.current += text;
        // Truncate for log — full text is captured in the END line.
        const preview = text.length > 40 ? text.slice(0, 40) + '…' : text;
        logTurnEvent('output-text', JSON.stringify(preview));
        appendBotChunk(text);
      }
    }

    // Text output (fallback for non-audio-only models)
    if (msg.serverContent?.modelTurn?.parts) {
      const textParts = msg.serverContent.modelTurn.parts
        .filter((p) => p.text)
        .map((p) => p.text!)
        .join('');
      if (textParts) {
        turnTextRef.current += textParts;
        logTurnEvent('output-text(fallback)',
          JSON.stringify(textParts.slice(0, 40) + (textParts.length > 40 ? '…' : '')));
        appendBotChunk(textParts);
      }
    }

    // Turn complete — flush to transcript and run repetition detection
    if (msg.serverContent?.turnComplete) {
      logTurnEvent('turn-complete');
      resetTurnTiming('turnComplete');
      currentTurnIdRef.current += 1;
      sealBotTurn('turnComplete');
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
      // Log BEFORE dispatch so the turn timeline shows whether the tool-call
      // landed before any audio/text (silent dispatch — bad) or after some
      // filler audio (good).
      for (const c of msg.toolCall.functionCalls) {
        logTurnEvent('tool-call-received',
          `name=${c.name} args=${JSON.stringify(c.args ?? {}).slice(0, 80)}`);
      }
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
        // Flush the in-progress bot turn (the goodbye) before tearing the
        // session down. Gemini delivers transcription chunks via
        // appendBotChunk into currentBotTurnRef.current; sealBotTurn is
        // normally called only on `turnComplete`, but for tool-initiated
        // endSession that turnComplete often arrives after the consumer
        // has already closed the WebSocket — so without this seal, the
        // bot's last reply never lands in Firestore.
        sealBotTurn('turnComplete');
        onSessionEndRequestRef.current?.();
        return;
      }

      const turnAtDispatch = currentTurnIdRef.current;
      logTurnEvent('tool-dispatch-start', `name=${name}`);
      const dispatchStartMs = performance.now();
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
      const dispatchMsNum = Math.round(performance.now() - dispatchStartMs);
      const dispatchMs = dispatchMsNum.toString();
      logTurnEvent('tool-dispatch-end',
        `name=${name} took=${dispatchMs}ms resultLen=${result.length}`);

      addMessage('tool', `[${name}]`, {
        toolName: name,
        toolArgs: args,
        toolResult: result,
        toolDurationMs: dispatchMsNum,
        toolResultBytes: result.length,
      });
      appendToTranscript('tool', `[${name}]`, {
        toolName: name,
        toolArgs: args,
        toolResult: result.slice(0, 500),
        toolDurationMs: dispatchMsNum,
        toolResultBytes: result.length,
      });

      if (cancelledTurnsRef.current.has(turnAtDispatch)) {
        console.log(`[Session] Skipping sendToolResponse for ${name} — turn was cancelled`);
        logTurnEvent('tool-response-skipped', `name=${name} (turn cancelled)`);
      } else {
        try {
          liveSessionRef.current?.sendToolResponse({
            functionResponses: [{ id: call.id, name, response: { result } }],
          });
          logTurnEvent('tool-response-sent', `name=${name}`);
        } catch (err) {
          console.error(`[Session] sendToolResponse failed for ${name}:`, err);
          errorCountRef.current++;
        }
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
    // Prefer a single-use ephemeral token from the consumer's server-side
    // broker. Falls back to the long-lived key if no tokenProvider is
    // configured (legacy / dev mode only — see VoiceCommonConfig).
    const { token } = await mintLiveToken();
    // Ephemeral token + v1alpha — the SDK's auth-token support is wired
    // only to the v1alpha endpoint; the default v1 returns a URL shape that
    // rejects the token. See https://ai.google.dev/gemini-api/docs/ephemeral-tokens
    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });

    const allTools: FunctionDeclaration[] = [
      ...toolsRef.current,
      {
        name: 'endSession',
        description: 'End the voice session. Call this only when the user explicitly signals they want to stop.',
        parameters: { type: Type.OBJECT, properties: {}, required: [] },
      } as FunctionDeclaration,
    ];

    // Tool-registry visibility log at connect time — proves what was
    // ACTUALLY handed to Gemini Live, not what we hoped. Critical when
    // a session shows "model never called a tool"; without this log we
    // can't distinguish "model chose not to" from "model didn't have
    // any tools to call".
    console.log(
      `[Session] Connecting to Gemini with ${allTools.length} tool declaration(s):`,
      allTools.map((t) => t.name).join(', '),
    );

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
    if (reconnectInProgressRef.current) {
      console.warn('[Session] attemptReconnect called while already reconnecting — skipping duplicate');
      return;
    }
    reconnectInProgressRef.current = true;

    const existingSessionId = sessionRef.current;
    console.log(`[Session] Reconnecting — session=${existingSessionId}, transcript entries=${transcriptRef.current.length}`);

    // Stop any bot audio buffers still scheduled against the old context so
    // they can't bleed into the new stream after reconnect completes.
    stopActiveAudio();

    // Flush partial audio before restarting mixer
    const partialBlob = mixer.flush();
    if (partialBlob && existingSessionId) {
      const archive = archiveAudioRef.current ?? archiveAudioToGCS;
      archive(partialBlob, userId, existingSessionId).catch((err) =>
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
      reconnectInProgressRef.current = false;
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
    } finally {
      reconnectInProgressRef.current = false;
    }
  }, [userId, mixer, connectGemini, stopActiveAudio]);

  // ---------------------------------------------------------------------------
  // Session lifecycle: start
  // ---------------------------------------------------------------------------

  const startSession = useCallback(async (
    overrideInstruction?: string,
    overrideAutoGreetText?: string,
    overrideTools?: FunctionDeclaration[],
  ) => {
    if (isRecording || startInProgressRef.current) {
      console.log('[Session] startSession called but already recording/starting — ignoring');
      return;
    }
    startInProgressRef.current = true;
    setError(null);
    setMessages([]);
    transcriptRef.current = [];
    messageIndexRef.current = 0;
    lastBotTurnRef.current = '';
    currentBotTurnRef.current = '';
    botTurnSealedRef.current = true;
    isStoppingRef.current = false;
    reconnectAttemptsRef.current = 0;
    reconnectInProgressRef.current = false;
    toolCallCountRef.current = 0;
    errorCountRef.current = 0;
    currentTurnIdRef.current = 0;
    cancelledTurnsRef.current.clear();

    const instructionToUse = overrideInstruction ?? systemInstructionRef.current;
    const greetToUse = overrideAutoGreetText !== undefined ? overrideAutoGreetText : autoGreetTextRef.current;

    // If the caller passed a fresh tools list (e.g. fetched from a backend
    // tool registry), pin it into toolsRef so connectGemini AND auto-reconnect
    // both use it for the duration of the session. Without this, reconnect
    // would silently revert to whatever was passed at hook-construction time.
    if (overrideTools !== undefined) {
      toolsRef.current = overrideTools;
    }

    try {
      console.log('[Session] Starting session for user:', userId);

      // Create Firestore session record
      const sId = await createSession(userId, sessionsCollectionRef.current, additionalSessionDataRef.current);
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
        startInProgressRef.current = false;
        console.log('[Session] Session ready, sessionRef set');
      });
    } catch (err) {
      console.error('[Session] Start error:', err);
      setError(`Failed to start session: ${String(err)}`);
      setConnectionStatus(ConnectionStatus.ERROR);
      startInProgressRef.current = false;

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
    // Defence-in-depth: flush any in-progress bot turn before closing the
    // WebSocket. The endSession tool handler already seals on its way out,
    // but stopSession can also be called from the manual stop button or
    // from auto-recovery error paths — both of which would otherwise
    // silently drop whatever the bot was mid-saying.
    sealBotTurn('interrupted');
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
          const archive = archiveAudioRef.current ?? archiveAudioToGCS;
          audioUrl = await archive(audioBlob, userId, sessionRef.current);
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
