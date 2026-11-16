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
 * Replay harness: feeds a recorded Gemini Live event trace
 * (src/__tests__/fixtures/live-traces/*.json, recorded from the real API by
 * scripts/capture-live-traces.mjs) through useSession's real message handler,
 * on a virtual clock that also drives a fake playback AudioContext.
 *
 * Everything the hook does in response is observable: the transcript it
 * persists, the messages it renders, the tool responses it sends, the
 * onBotSpeaking transitions, the audio it schedules (and whether each chunk
 * also reaches the recorder), and when it asks the app to end the session.
 *
 * This file only exports the harness; the tests are in
 * useSession.replay.test.ts. vi.mock calls for the modules below must be made
 * by the importing test file (vitest hoists them per file).
 */

import fs from 'node:fs';
import path from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { vi } from 'vitest';
import type { TranscriptEntry } from '../../types';

// ---------------------------------------------------------------------------
// Trace fixtures
// ---------------------------------------------------------------------------

export interface TraceServerEvent {
  t: number;
  from: 'server';
  message: Record<string, any>;
}
export interface TraceClientEvent {
  t: number;
  from: 'client';
  kind: string;
  id?: string;
  name?: string;
  result?: string;
  scheduling?: string;
}
export type TraceEvent = TraceServerEvent | TraceClientEvent;
export interface LiveTraceFixture {
  meta: {
    scenario: string;
    model: string;
    capturedAt: string;
    sdk: string;
    generator: string;
    note: string;
    thinkingLevel: string | null;
  };
  events: TraceEvent[];
}

const TRACE_DIR = path.resolve(__dirname, '..', 'fixtures', 'live-traces');

export function listTraceFixtures(): string[] {
  return fs.readdirSync(TRACE_DIR).filter((f) => f.endsWith('.json')).sort();
}

export function loadTrace(scenario: string, model: string): LiveTraceFixture {
  return JSON.parse(fs.readFileSync(path.join(TRACE_DIR, `${scenario}.${model}.json`), 'utf8'));
}

/** Put real (silent) PCM back where the recorder kept only a byte count. */
function rehydrate(value: any): any {
  if (Array.isArray(value)) return value.map(rehydrate);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = rehydrate(v);
    if (typeof out.bytes === 'number' && typeof out.mimeType === 'string') {
      out.data = Buffer.alloc(out.bytes).toString('base64');
      delete out.bytes;
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Fake playback AudioContext on the virtual clock
// ---------------------------------------------------------------------------

export interface ScheduledChunk {
  /** Seconds on the context clock. */
  startAt: number;
  /** When the chunk was due to finish. */
  plannedEndAt: number;
  /** When it actually stopped sounding (earlier than planned if it was cut). */
  endAt: number;
  stopped: boolean;
  reachedSpeakers: boolean;
  reachedRecorder: boolean;
}

export function createFakePlayback() {
  const origin = Date.now();
  const chunks: ScheduledChunk[] = [];
  const recorderDest = { kind: 'recorder-destination' };
  const context = {
    sampleRate: 24_000,
    state: 'running' as AudioContextState,
    destination: { kind: 'speakers' },
    get currentTime() {
      return (Date.now() - origin) / 1000;
    },
    createBuffer: (_channels: number, length: number, sampleRate: number) => ({
      length,
      duration: length / sampleRate,
      copyToChannel: () => undefined,
    }),
    createBufferSource: () => {
      const chunk: ScheduledChunk = {
        startAt: 0,
        plannedEndAt: 0,
        endAt: 0,
        stopped: false,
        reachedSpeakers: false,
        reachedRecorder: false,
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const source: any = {
        buffer: null,
        onended: null,
        connect: (dest: unknown) => {
          if (dest === context.destination) chunk.reachedSpeakers = true;
          if (dest === recorderDest) chunk.reachedRecorder = true;
        },
        start: (when: number) => {
          chunk.startAt = when;
          chunk.plannedEndAt = when + source.buffer.duration;
          chunk.endAt = chunk.plannedEndAt;
          chunks.push(chunk);
          timer = setTimeout(() => source.onended?.(), Math.max(0, (chunk.endAt - context.currentTime) * 1000));
        },
        stop: () => {
          if (context.currentTime >= chunk.plannedEndAt) return; // already finished
          chunk.stopped = true;
          chunk.endAt = Math.max(chunk.startAt, Math.min(chunk.plannedEndAt, context.currentTime));
          clearTimeout(timer);
        },
      };
      return source;
    },
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    context,
    recorderDest,
    chunks,
    /** Virtual ms (since the context was created) at which the last audio stopped sounding. */
    drainedAtMs: () => Math.round(Math.max(0, ...chunks.map((c) => c.endAt)) * 1000),
    /** Seconds of audio scheduled, and seconds that never sounded because playback was stopped. */
    scheduledS: () => chunks.reduce((s, c) => s + (c.plannedEndAt - c.startAt), 0),
    cutS: () => chunks.reduce((s, c) => s + (c.plannedEndAt - c.endAt), 0),
    nowMs: () => Date.now() - origin,
  };
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface ReplayDeps {
  /** The hook under test. */
  useSession: (options: any) => any;
  /** Captured live.connect callbacks (set by the test file's @google/genai mock). */
  callbacks: { current: Record<string, (...args: any[]) => any> };
  liveSession: { sendToolResponse: ReturnType<typeof vi.fn>; sendRealtimeInput: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  playback: ReturnType<typeof createFakePlayback>;
  syncTranscript: ReturnType<typeof vi.fn>;
  mixer: { stop: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> };
  /** The stubbed AudioWorkletNode the hook listens to for microphone frames. */
  worklet: { current: { port: { onmessage: ((e: any) => void) | null } } | null };
}

export interface ReplayOptions {
  /** Stop feeding the trace at this trace time (ms). Default: the whole trace. */
  untilMs?: number;
  /** Extra virtual time to run after the last event, so audio can drain. Default 3000 ms. */
  tailMs?: number;
  /** useSession options to merge in. */
  hookOptions?: Record<string, unknown>;
  /** Call stopSession() from onSessionEndRequest, as CarBot and weatherbot-app do. Default false. */
  stopOnEndRequest?: boolean;
}

export interface ReplayResult {
  model: string;
  /** What the hook persisted, in order. */
  transcript: Array<Pick<TranscriptEntry, 'role' | 'text' | 'toolName' | 'toolResult' | 'messageIndex'> & { atMs: number }>;
  /** What the hook rendered, in order. */
  messages: Array<{ role: string; text: string }>;
  toolCallsSeen: Array<{ name: string; args: unknown; atMs: number }>;
  toolResponses: Array<{ atMs: number; payload: any }>;
  botSpeaking: Array<{ speaking: boolean; atMs: number }>;
  interactionStatuses: Array<{ status: string; atMs: number }>;
  /**
   * Whether microphone audio was being forwarded to the model, sampled every
   * 20 ms of virtual time; one entry per change. (The greeting echo mute
   * holds it closed while the opening greeting plays.)
   */
  micOpen: Array<{ open: boolean; atMs: number }>;
  endRequestedAtMs: number | null;
  stoppedAtMs: number | null;
  /** Trace time at which all scheduled bot audio has finished playing. */
  audioDrainedAtMs: number;
  /** Seconds of bot audio scheduled, and seconds of it that never sounded (cut off). */
  audioScheduledS: number;
  audioCutS: number;
  everyChunkReachedRecorder: boolean;
  recorderStopCalls: number;
  recorderFlushCalls: number;
  errors: string[];
}

/**
 * Replay one trace through the hook. Trace time 0 is the session's connect;
 * all `atMs` values in the result are on the trace's own timeline.
 */
export async function replayTrace(
  trace: LiveTraceFixture,
  deps: ReplayDeps,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const { playback, liveSession, callbacks } = deps;
  const pendingTools = new Map<string, (result: string) => void>();
  const toolCallsSeen: ReplayResult['toolCallsSeen'] = [];
  const botSpeaking: ReplayResult['botSpeaking'] = [];
  const interactionStatuses: ReplayResult['interactionStatuses'] = [];
  const transcriptTimes: number[] = [];
  const errors: string[] = [];
  let endRequestedAtMs: number | null = null;
  let stoppedAtMs: number | null = null;

  // Trace time of the virtual "now": the playback context was created at
  // connect, which is trace time `base`.
  const firstServer = trace.events.find((e) => e.from === 'server');
  const base = firstServer?.t ?? 0;
  const traceNow = () => base + playback.nowMs();

  deps.syncTranscript.mockImplementation(async (_id: string, entries: TranscriptEntry[]) => {
    while (transcriptTimes.length < entries.length) transcriptTimes.push(traceNow());
  });
  const toolResponses: ReplayResult['toolResponses'] = [];
  liveSession.sendToolResponse.mockImplementation((payload: any) => {
    toolResponses.push({ atMs: traceNow(), payload });
  });

  const hook = renderHook(() =>
    deps.useSession({
      userId: 'user-1',
      systemInstruction: 'replay',
      liveModel: trace.meta.model,
      onToolCall: (name: string, args: unknown) =>
        new Promise<string>((resolve) => {
          toolCallsSeen.push({ name, args, atMs: traceNow() });
          pendingTools.set(name, resolve);
        }),
      onBotSpeaking: (speaking: boolean) => {
        // Record changes only. The bot starts out silent, and the hook may
        // repeat a "not speaking" notification (it does on every interruption).
        const current = botSpeaking.length ? botSpeaking[botSpeaking.length - 1].speaking : false;
        if (current !== speaking) botSpeaking.push({ speaking, atMs: traceNow() });
      },
      onInteractionStatus: (status: string) => interactionStatuses.push({ status, atMs: traceNow() }),
      onSessionEndRequest: () => {
        endRequestedAtMs = traceNow();
        if (options.stopOnEndRequest) {
          stoppedAtMs = traceNow();
          void hook.result.current.stopSession();
        }
      },
      ...options.hookOptions,
    }),
  );

  await act(async () => {
    await hook.result.current.startSession();
  });

  // A microphone frame every 20 ms: does the hook forward it to the model?
  const micOpen: ReplayResult['micOpen'] = [];
  const probeMic = () => {
    const port = deps.worklet.current?.port;
    if (!port?.onmessage) return;
    const audioSends = () => liveSession.sendRealtimeInput.mock.calls.filter((c: any[]) => c[0]?.audio).length;
    const before = audioSends();
    port.onmessage({ data: { channelData: new Float32Array(320) } });
    const open = audioSends() > before;
    const last = micOpen[micOpen.length - 1];
    if (!last || last.open !== open) micOpen.push({ open, atMs: traceNow() });
  };

  const advanceTo = async (t: number) => {
    while (traceNow() < t) {
      const step = Math.min(20, t - traceNow());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(step);
      });
      probeMic();
    }
  };
  probeMic();

  for (const event of trace.events) {
    if (options.untilMs !== undefined && event.t > options.untilMs) break;
    if (event.t < base) continue;
    await advanceTo(event.t);
    if (event.from === 'server') {
      if (event.message.setupComplete) continue;
      await act(async () => {
        try {
          callbacks.current.onmessage(rehydrate(event.message));
        } catch (err) {
          errors.push(String(err));
        }
        await Promise.resolve();
      });
    } else if ((event.kind === 'toolResponded' || event.kind === 'toolWouldFinish') && event.name) {
      // The application tool finishes now (endSession is answered by the hook itself).
      const resolve = pendingTools.get(event.name);
      if (resolve) {
        pendingTools.delete(event.name);
        await act(async () => {
          resolve(event.result ?? 'ok');
          await Promise.resolve();
          await Promise.resolve();
        });
      }
    }
  }
  await advanceTo(traceNow() + (options.tailMs ?? 3_000));

  const entries: TranscriptEntry[] = deps.syncTranscript.mock.calls.length
    ? deps.syncTranscript.mock.calls[deps.syncTranscript.mock.calls.length - 1][1]
    : [];
  const result: ReplayResult = {
    model: trace.meta.model,
    transcript: entries.map((e, i) => ({
      role: e.role,
      text: e.text,
      toolName: e.toolName,
      toolResult: e.toolResult,
      messageIndex: e.messageIndex,
      atMs: transcriptTimes[i] ?? -1,
    })),
    messages: hook.result.current.messages.map((m: any) => ({ role: m.role, text: m.text })),
    toolCallsSeen,
    toolResponses,
    botSpeaking,
    interactionStatuses,
    micOpen,
    endRequestedAtMs,
    stoppedAtMs,
    audioDrainedAtMs: base + playback.drainedAtMs(),
    audioScheduledS: Number(playback.scheduledS().toFixed(2)),
    audioCutS: Number(playback.cutS().toFixed(2)),
    everyChunkReachedRecorder: playback.chunks.every((c) => c.reachedRecorder && c.reachedSpeakers),
    recorderStopCalls: deps.mixer.stop.mock.calls.length,
    recorderFlushCalls: deps.mixer.flush.mock.calls.length,
    errors,
  };
  hook.unmount();
  return result;
}
