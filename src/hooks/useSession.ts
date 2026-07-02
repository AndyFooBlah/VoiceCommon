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

/** Consecutive failed session-resumption attempts before we halt the session. */
const MAX_RESUME_FAILURES = 3;

/**
 * Length of the turn-opening fingerprint used to detect a mid-turn restart
 * (e.g. the native-audio model emitting its greeting twice in one turn). If the
 * first ~16 chars of a turn reappear later in the SAME turn, the model has
 * restarted and we suppress the duplicate audio for the rest of the turn.
 */
const TURN_OPENING_FINGERPRINT_LEN = 16;

/** Word overlap ratio above which a bot turn is considered a repetition (0–1). */
const REPETITION_THRESHOLD = 0.85;

/** Minimum words in a turn before repetition detection fires. */
const REPETITION_MIN_WORDS = 12;

// ---------------------------------------------------------------------------
// Client-side VAD tuning (manual turn control). Energy is RMS of the 16kHz
// mic frame in [0,1]. These defaults are a starting point — the per-frame
// tuning log lets consumers dial them in from real sessions.
// ---------------------------------------------------------------------------
/** Initial noise-floor estimate before adaptation kicks in. */
const VAD_INIT_FLOOR = 0.005;
/** Clamp bounds for the adaptive noise floor. */
const VAD_MIN_FLOOR = 0.0008;
const VAD_MAX_FLOOR = 0.05;
/** rms must exceed floor×factor to count as speech (idle vs. during bot speech). */
const VAD_SPEECH_FACTOR = 3.0;
const VAD_BARGEIN_FACTOR = 6.0;
/** Sustained speech required before committing activityStart (idle vs. barge-in). */
const VAD_START_DEBOUNCE_MS = 120;
const VAD_BARGEIN_DEBOUNCE_MS = 300;
/**
 * Sustained above-threshold speech required to RESET the end-of-turn silence
 * timer once the user's turn is open. Transient background-noise blips are
 * shorter than this, so they no longer restart the wait — they only briefly
 * pause it. Without this, faint intermittent noise keeps a turn open forever.
 */
const VAD_RETRIGGER_MS = 200;
/** Fallback end-of-turn silence when no endOfSpeechSilenceMs is configured. */
const VAD_DEFAULT_WAIT_MS = 1500;

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
   * How long the user may pause (silence, in milliseconds) before the bot
   * treats the turn as finished and responds. Larger values make the bot wait
   * more patiently for the user to keep talking; smaller values make it step
   * in sooner. Maps to the Gemini Live
   * `realtimeInputConfig.automaticActivityDetection.silenceDurationMs` field.
   * Omit to use the API default. Updated every render, so mid-session changes
   * take effect on the next (re)connect.
   */
  endOfSpeechSilenceMs?: number;
  /**
   * How eager the model is to decide the user has *finished* speaking.
   * 'HIGH' (default) commits end-of-speech quickly — good for snappy
   * back-and-forth. 'LOW' makes the model wait through longer/uncertain
   * pauses before taking its turn — use it when the speaker tends to pause
   * mid-thought and you don't want the bot jumping in. Maps to
   * `automaticActivityDetection.endOfSpeechSensitivity`. Updated every render.
   */
  endOfSpeechSensitivity?: 'HIGH' | 'LOW';
  /**
   * Opt-in manual turn control. When true, VoiceCommon disables Gemini's
   * automatic voice-activity detection (`automaticActivityDetection.disabled`)
   * and instead decides turn boundaries on the client: it detects when the
   * user starts speaking (energy-based VAD) and only ends their turn after
   * `endOfSpeechSilenceMs` of continuous silence. Use this when the bot must
   * wait patiently through long pauses — the native-audio model ignores large
   * `silenceDurationMs` values, so server-side VAD cannot deliver it. Barge-in
   * is preserved with a stricter threshold while the bot is speaking. Requires
   * mic echo cancellation (enabled by the mixer) so the bot's own audio does
   * not trip detection.
   */
  manualTurnControl?: boolean;
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

  // End-of-speech silence ref — updated every render so a mid-session change
  // (or reconnect) picks up the latest "how patiently the bot waits" value.
  const endOfSpeechSilenceMsRef = useRef(options.endOfSpeechSilenceMs);
  endOfSpeechSilenceMsRef.current = options.endOfSpeechSilenceMs;

  // End-of-speech sensitivity ref — 'LOW' makes the model less eager to
  // declare the user's turn finished. Defaults to 'HIGH' (current behavior).
  const endOfSpeechSensitivityRef = useRef(options.endOfSpeechSensitivity);
  endOfSpeechSensitivityRef.current = options.endOfSpeechSensitivity;

  // Manual turn control (client-side VAD) opt-in.
  const manualTurnControlRef = useRef(options.manualTurnControl);
  manualTurnControlRef.current = options.manualTurnControl;

  // Internal bot-speaking flag (mirrors onBotSpeaking) used to gate barge-in
  // detection in manual turn control.
  const botSpeakingRef = useRef(false);

  // Client-side VAD state machine — reset on each connect. `frame` energy is
  // RMS; the noise floor adapts during quiet, non-bot, non-speech frames.
  const vadRef = useRef({
    noiseFloor: VAD_INIT_FLOOR,
    userSpeaking: false,
    speechMs: 0,
    silenceMs: 0,
    logAccumMs: 0,
  });

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
  // Tools: two-mode pattern.
  //   - Mode A (static): consumer passes a fixed tools array at hook
  //     construction; we want it to track on re-render so updates land.
  //   - Mode B (dynamic): consumer calls startSession(_, _, overrideTools)
  //     with a list fetched at start time. The override MUST survive the
  //     re-renders that startSession's own setState calls trigger; if we
  //     unconditionally synced from `options.tools` here, the override
  //     would be wiped before connectGemini reads the ref.
  // The flag below switches between modes: once an override lands, the
  // auto-sync stops, and the override is the source of truth for the
  // rest of the session. stopSession clears the flag for the next start.
  const toolsRef = useRef(tools);
  const toolsOverriddenRef = useRef(false);
  if (!toolsOverriddenRef.current) {
    toolsRef.current = tools;
  }
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
  // Mid-turn restart detection (e.g. double greeting). Reset at each turn start.
  const turnOpeningRef = useRef('');       // fingerprint of this turn's opening
  const suppressTurnRef = useRef(false);   // true once a restart is detected → drop the rest

  function logTurnEvent(label: string, extra: string = ''): void {
    const now = performance.now();
    if (!turnHasEventsRef.current) {
      turnStartMsRef.current = now;
      turnHasEventsRef.current = true;
      turnAudioMsRef.current = 0;
      turnTextRef.current = '';
      turnEventCountRef.current = 0;
      turnOpeningRef.current = '';
      suppressTurnRef.current = false;
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

  // Stop/halt state
  const isStoppingRef = useRef(false);          // true when stopSession is intentional
  const reconnectAttemptsRef = useRef(0);       // total resume attempts (session metric)
  // Set to the latest haltWithError so the WebSocket onclose handler (created
  // inside connectGemini before stopSession exists) can trigger a clean halt
  // without a stale closure.
  const haltWithErrorRef = useRef<(message: string) => void>(() => {});

  // Session-resumption state. The recorder keeps running across resumes (one
  // continuous recording); only the Gemini WebSocket reconnects underneath it.
  const resumptionHandleRef = useRef<string | undefined>(undefined); // latest handle from the server
  const resumeInProgressRef = useRef(false);                          // guards concurrent resumes
  const resumeFailuresRef = useRef(0);                                // consecutive failures (→ halt at MAX)
  const pcmModuleContextRef = useRef<BaseAudioContext | null>(null);  // context the PCM worklet is registered on
  // Late-bound so the onmessage/onclose callbacks (created in connectGemini
  // before resumeConnection exists) can trigger a resume without a stale closure.
  const resumeConnectionRef = useRef<(reason: string) => void>(() => {});
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
    botSpeakingRef.current = false;
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
        botSpeakingRef.current = false;
        onBotSpeakingRef.current?.(false);
      }
    };

    source.start(startAt);
    scheduleTimeRef.current = startAt + buffer.duration;
    botSpeakingRef.current = true;
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
   * Detect a mid-turn restart: the native-audio model sometimes emits its
   * opening twice in a single turn (the "double greeting"). We fingerprint the
   * first ~16 chars of the turn; if that fingerprint reappears later in the same
   * turn, the model has started over, so we set suppressTurnRef to drop the
   * duplicate's audio and transcript for the remainder of the turn. Called after
   * each bot transcription chunk is appended to turnTextRef.
   */
  function detectTurnRestart(): void {
    if (suppressTurnRef.current) return;
    const acc = turnTextRef.current.toLowerCase();
    if (!turnOpeningRef.current) {
      if (acc.trim().length >= TURN_OPENING_FINGERPRINT_LEN) {
        turnOpeningRef.current = acc.trim().slice(0, TURN_OPENING_FINGERPRINT_LEN);
      }
      return;
    }
    const opening = turnOpeningRef.current;
    const first = acc.indexOf(opening);
    const second = first === -1 ? -1 : acc.indexOf(opening, first + opening.length);
    if (second !== -1) {
      suppressTurnRef.current = true;
      console.warn(
        `[Session] Mid-turn restart detected (opening "${opening.trim()}" repeated) — suppressing the duplicate for the rest of this turn`,
      );
    }
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

  /** Send a manual activity signal (turn boundary) to Gemini. */
  function sendActivity(kind: 'start' | 'end'): void {
    try {
      liveSessionRef.current?.sendRealtimeInput(
        kind === 'start' ? { activityStart: {} } : { activityEnd: {} },
      );
    } catch (err) {
      console.error(`[Session] sendRealtimeInput(activity${kind}) failed:`, err);
    }
  }

  /**
   * Client-side voice-activity detection for manual turn control. Called per
   * mic frame (only when manualTurnControl is enabled). Detects utterance
   * start/end from frame energy and brackets the user's turn with
   * activityStart/activityEnd — holding activityEnd until endOfSpeechSilenceMs
   * of continuous silence so the bot waits patiently through pauses. Barge-in
   * is preserved with a stricter threshold while the bot is speaking.
   */
  function runClientVad(frame: Float32Array): void {
    const v = vadRef.current;
    const frameMs = frame.length / 16; // 16 samples per ms at 16kHz

    let sumSquares = 0;
    for (let i = 0; i < frame.length; i++) sumSquares += frame[i] * frame[i];
    const rms = Math.sqrt(sumSquares / frame.length);

    const botSpeaking = botSpeakingRef.current;
    const factor = botSpeaking ? VAD_BARGEIN_FACTOR : VAD_SPEECH_FACTOR;
    const startDebounceMs = botSpeaking ? VAD_BARGEIN_DEBOUNCE_MS : VAD_START_DEBOUNCE_MS;
    const threshold = v.noiseFloor * factor;
    const waitMs = endOfSpeechSilenceMsRef.current ?? VAD_DEFAULT_WAIT_MS;

    // Periodic tuning log so thresholds can be dialed in from real sessions.
    v.logAccumMs += frameMs;
    if (v.logAccumMs >= 2000) {
      v.logAccumMs = 0;
      console.log(
        `[Session] VAD level: rms=${rms.toFixed(4)} floor=${v.noiseFloor.toFixed(4)} ` +
          `thr=${threshold.toFixed(4)} speaking=${v.userSpeaking} silence=${Math.round(v.silenceMs)}ms bot=${botSpeaking}`,
      );
    }

    if (rms > threshold) {
      v.speechMs += frameMs;
      // Only SUSTAINED speech resets the end-of-turn silence timer. A lone
      // above-threshold blip (background noise, a cough, a keyboard tap) is
      // shorter than VAD_RETRIGGER_MS, so it pauses the count for a frame or
      // two rather than restarting the whole wait. This is what keeps faint
      // intermittent noise from holding the turn open indefinitely.
      if (v.speechMs >= VAD_RETRIGGER_MS) {
        v.silenceMs = 0;
      }
      if (!v.userSpeaking && v.speechMs >= startDebounceMs) {
        v.userSpeaking = true;
        v.speechMs = 0;
        sendActivity('start');
        console.log(
          `[Session] VAD activityStart (rms=${rms.toFixed(4)} thr=${threshold.toFixed(4)} bargeIn=${botSpeaking})`,
        );
        // Guarded barge-in: user cut in while the bot was speaking — stop the
        // queued bot audio and seal its partial turn immediately.
        if (botSpeaking) {
          stopActiveAudio();
          sealBotTurn('interrupted');
        }
      }
    } else {
      v.silenceMs += frameMs;
      v.speechMs = 0;
      // Adapt the noise floor only during quiet, non-bot, non-speech frames so
      // the bot's echo can't inflate it.
      if (!botSpeaking && !v.userSpeaking) {
        v.noiseFloor = Math.min(
          VAD_MAX_FLOOR,
          Math.max(VAD_MIN_FLOOR, v.noiseFloor * 0.95 + rms * 0.05),
        );
      }
      if (v.userSpeaking && v.silenceMs >= waitMs) {
        v.userSpeaking = false;
        v.silenceMs = 0;
        sendActivity('end');
        console.log(`[Session] VAD activityEnd (waited ${Math.round(waitMs)}ms of silence)`);
      }
    }
  }

  function handleServerMessage(msg: LiveServerMessage): void {
    // Session-resumption handle — store the latest so an unexpected disconnect
    // can resume this exact session (with full context) instead of halting.
    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) {
      resumptionHandleRef.current = msg.sessionResumptionUpdate.newHandle;
    }
    // The server warns before it resets a connection. Nothing to do proactively
    // for now — the onclose handler resumes with the stored handle — but log it.
    if (msg.goAway) {
      console.log(`[Session] GoAway received (timeLeft=${msg.goAway.timeLeft ?? 'unknown'}) — will resume on close`);
    }

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
          // Drop audio once we've detected a mid-turn restart (double greeting):
          // the already-scheduled first greeting keeps playing; the duplicate is
          // never scheduled.
          if (suppressTurnRef.current) continue;
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
        // logTurnEvent first: it resets per-turn refs on a turn's first event,
        // so turnTextRef must accumulate AFTER it (otherwise the opening chunk,
        // which carries the greeting fingerprint, would be wiped).
        const preview = text.length > 40 ? text.slice(0, 40) + '…' : text;
        logTurnEvent('output-text', JSON.stringify(preview));
        turnTextRef.current += text;
        detectTurnRestart();
        // Skip the transcript/UI append for a detected duplicate so the record
        // shows a single clean greeting.
        if (!suppressTurnRef.current) appendBotChunk(text);
      }
    }

    // Text output (fallback for non-audio-only models)
    if (msg.serverContent?.modelTurn?.parts) {
      const textParts = msg.serverContent.modelTurn.parts
        .filter((p) => p.text)
        .map((p) => p.text!)
        .join('');
      if (textParts) {
        logTurnEvent('output-text(fallback)',
          JSON.stringify(textParts.slice(0, 40) + (textParts.length > 40 ? '…' : '')));
        turnTextRef.current += textParts;
        detectTurnRestart();
        if (!suppressTurnRef.current) appendBotChunk(textParts);
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

    // VAD visibility log — proves the end-of-speech silence value ACTUALLY
    // handed to Gemini, so we can distinguish "the configured wait never
    // propagated" from "the model ignored it". See endOfSpeechSilenceMs.
    const endSensitivity =
      endOfSpeechSensitivityRef.current === 'LOW'
        ? EndSensitivity.END_SENSITIVITY_LOW
        : EndSensitivity.END_SENSITIVITY_HIGH;
    if (manualTurnControlRef.current) {
      console.log(
        `[Session] VAD: manual turn control (client-side; end-of-turn after ${
          endOfSpeechSilenceMsRef.current ?? VAD_DEFAULT_WAIT_MS
        }ms silence)`,
      );
    } else {
      console.log(
        `[Session] VAD: silenceDurationMs=${
          endOfSpeechSilenceMsRef.current ?? '(server default ~800ms)'
        } endOfSpeechSensitivity=${endOfSpeechSensitivityRef.current ?? 'HIGH'}`,
      );
    }

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
        // Turn detection. In manual mode we disable the server's automatic
        // VAD entirely and drive turn boundaries from the client (runClientVad),
        // because the native-audio model ignores large silenceDurationMs values.
        // Otherwise: high start sensitivity keeps barge-in snappy; end-of-speech
        // sensitivity/silence are configurable.
        realtimeInputConfig: {
          automaticActivityDetection: manualTurnControlRef.current
            ? { disabled: true }
            : {
                startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
                endOfSpeechSensitivity: endSensitivity,
                // How long a pause the user is allowed before the bot commits
                // end-of-speech and takes its turn. Omit to use the API default.
                ...(endOfSpeechSilenceMsRef.current != null
                  ? { silenceDurationMs: endOfSpeechSilenceMsRef.current }
                  : {}),
              },
        },
        // Voice selection — only included when the caller provides a speech config
        ...(speechConfig ? { speechConfig } : {}),
        // Session resumption: the server issues resumption handles we store and
        // pass back on reconnect, so a session survives the Live API's ~10-min
        // connection resets and ~15-min session cap WITH full conversation
        // context (no re-greeting). Passing a handle resumes; empty starts fresh.
        sessionResumption: resumptionHandleRef.current
          ? { handle: resumptionHandleRef.current }
          : {},
        // Context-window compression lets long interviews run past the 15-min
        // audio session limit by summarising older turns.
        contextWindowCompression: { slidingWindow: {} },
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

          // Unexpected disconnect (Live API ~10-min connection reset, ~15-min
          // session cap, or a transient 1011). Resume the SAME session via its
          // resumption handle rather than starting fresh — this preserves full
          // conversation context (no re-greeting). Crucially, we do NOT touch
          // the mixer/recorder: recording stays continuous across the reconnect
          // (one file, no overwrite — the old restart-and-reupload path lost
          // the opening minutes). We halt only if resumption keeps failing or
          // the recorder itself fails (see resumeConnection / haltWithError).
          console.warn('[Session] Unexpected disconnect — resuming session (recording continues)');
          setConnectionStatus(ConnectionStatus.CONNECTING);
          resumeConnectionRef.current('disconnect');
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
    // Register the PCM worklet module ONCE per AudioContext. The input context
    // persists across session-resumption reconnects (we never restart the mixer,
    // so recording stays continuous), and re-adding the module to the same
    // context throws "already registered". A fresh session gets a fresh context.
    if (pcmModuleContextRef.current !== inputCtx) {
      const workletBlob = new Blob([workletCode], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(workletBlob);
      await inputCtx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);
      pcmModuleContextRef.current = inputCtx;
    }

    const source = inputCtx.createMediaStreamSource(micStream);
    const worklet = new AudioWorkletNode(inputCtx, 'pcm-processor');
    source.connect(worklet);
    workletSourceRef.current = source;
    workletNodeRef.current = worklet;

    // Reset client-side VAD state for this connection (manual turn control).
    vadRef.current = {
      noiseFloor: VAD_INIT_FLOOR,
      userSpeaking: false,
      speechMs: 0,
      silenceMs: 0,
      logAccumMs: 0,
    };
    botSpeakingRef.current = false;

    let pcmFrameCount = 0;
    worklet.port.onmessage = (e: MessageEvent<{ channelData: Float32Array }>) => {
      if (!liveSessionRef.current) return;
      const float32 = e.data.channelData;

      // Manual turn control: derive turn boundaries from frame energy and send
      // activityStart/activityEnd. The raw audio is still streamed below.
      if (manualTurnControlRef.current) {
        runClientVad(float32);
      }

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
  // Session resumption (survive Live API connection resets without losing the
  // recording or the conversation)
  // ---------------------------------------------------------------------------

  /**
   * Resume the current session on an unexpected disconnect. Re-establishes the
   * Gemini WebSocket using the stored resumption handle (full context, no
   * re-greeting) and re-wires only the mic→PCM input path. The mixer/recorder
   * is deliberately left running, so the archival recording is one continuous
   * file across reconnects. After MAX_RESUME_FAILURES consecutive failures we
   * halt and finalize the recording captured so far.
   */
  const resumeConnection = useCallback(async (reason: string) => {
    if (isStoppingRef.current) return;
    if (resumeInProgressRef.current) {
      console.warn('[Session] resumeConnection called while already resuming — skipping');
      return;
    }
    resumeInProgressRef.current = true;
    reconnectAttemptsRef.current += 1;
    const handle = resumptionHandleRef.current;
    console.log(
      `[Session] Resuming session (reason=${reason}, attempt=${reconnectAttemptsRef.current}, handle=${handle ? 'present' : 'none'})`,
    );

    // Tear down only the input path + any scheduled bot audio. Do NOT stop the
    // mixer — recording must stay continuous across the reconnect.
    disconnectWorklet();
    stopActiveAudio();

    try {
      // No greeting cue on resume: session resumption preserves the conversation.
      await connectGemini(systemInstructionRef.current, undefined, speechConfigRef.current, () => {
        if (sessionRef.current) setSessionId(sessionRef.current);
        setConnectionStatus(ConnectionStatus.CONNECTED);
        resumeFailuresRef.current = 0;
        console.log('[Session] Resume successful');
      });
    } catch (err) {
      console.error('[Session] Resume failed:', err);
      errorCountRef.current += 1;
      resumeFailuresRef.current += 1;
      resumeInProgressRef.current = false;
      if (resumeFailuresRef.current >= MAX_RESUME_FAILURES) {
        void haltWithErrorRef.current(
          'The connection kept dropping and could not be restored. Your recording so far has been saved — please start a new session to continue.',
        );
      } else {
        // Brief backoff, then retry.
        setTimeout(() => resumeConnectionRef.current('retry'), 1_000);
      }
      return;
    }
    resumeInProgressRef.current = false;
  }, [connectGemini, disconnectWorklet, stopActiveAudio]);
  resumeConnectionRef.current = resumeConnection;

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
    // Fresh session — do not resume a previous one.
    resumptionHandleRef.current = undefined;
    resumeFailuresRef.current = 0;
    resumeInProgressRef.current = false;
    pcmModuleContextRef.current = null;
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
      toolsOverriddenRef.current = true;
    }

    try {
      console.log('[Session] Starting session for user:', userId);

      // Create Firestore session record
      const sId = await createSession(userId, sessionsCollectionRef.current, additionalSessionDataRef.current);
      sessionRef.current = sId;
      setSessionId(sId);
      sessionStartRef.current = new Date();
      console.log('[Session] Firestore session created:', sId);

      // Start audio mixer (captures mic + bot audio for archival). If the
      // recorder fails mid-session, halt — an interview must never continue
      // without its raw audio being recorded.
      await mixer.start(() =>
        haltWithErrorRef.current(
          'Audio recording stopped working, so the session was ended to avoid conducting the interview without a recording. Please start a new session.',
        ),
      );
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
    // Clear the tools-override latch so the next session start either
    // installs a fresh override or falls back to the static options.tools.
    toolsOverriddenRef.current = false;
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

  /**
   * Halt the session because of an unrecoverable failure (unexpected
   * disconnect, or the audio recorder failing). Finalizes the complete
   * recording captured so far via stopSession (a single upload — no
   * overwrite), then surfaces an error and leaves the session in ERROR so the
   * UI can tell the user to start a new session. Idempotent.
   */
  const haltWithError = useCallback(async (message: string) => {
    if (isStoppingRef.current) return; // already stopping/halting
    console.warn('[Session] Halting session:', message);
    errorCountRef.current += 1;
    setError(message);
    try {
      await stopSession();
    } finally {
      setConnectionStatus(ConnectionStatus.ERROR);
    }
  }, [stopSession]);
  haltWithErrorRef.current = haltWithError;

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
