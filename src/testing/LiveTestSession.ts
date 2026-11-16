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
 * LiveTestSession — a headless Gemini Live client for tests.
 *
 * Node only. No React, no DOM, no Firebase: just `@google/genai`. It opens a
 * real Live WebSocket with the config you give it, records everything the
 * server sends as a typed event trace, and offers small helpers for driving a
 * conversation (text, paced PCM audio, manual activity signals, tool
 * responses) and for waiting on trace events.
 *
 * Secrets: the API key or ephemeral token is used to construct the SDK client
 * and is otherwise held only inside the redactor that strips it from text. It
 * is never logged, never exposed as a property, never put in the trace, and
 * every error message is redacted before it is thrown.
 */

import { GoogleGenAI } from '@google/genai';
import type {
  FunctionResponseScheduling,
  LiveConnectConfig,
  LiveServerMessage,
  Session,
} from '@google/genai';
import { LIVE_API_VERSION } from '../services/liveConnectConfig';
import { INPUT_SAMPLE_RATE, pcmBytesForMs, silencePcm } from './audio';
import { makeRedactor } from './redact';

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

interface TraceBase {
  /** Milliseconds since the session object was created. */
  t: number;
}

export interface LiveToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Everything the kit records, in arrival order. */
export type LiveTraceEvent =
  // --- received from the server ---
  | (TraceBase & { type: 'open' })
  | (TraceBase & { type: 'setupComplete' })
  | (TraceBase & { type: 'audio'; bytes: number })
  | (TraceBase & { type: 'text'; text: string; thought: boolean })
  | (TraceBase & { type: 'inputTranscription'; text: string })
  | (TraceBase & { type: 'outputTranscription'; text: string })
  | (TraceBase & { type: 'toolCall'; calls: LiveToolCall[] })
  | (TraceBase & { type: 'toolCallCancellation'; ids: string[] })
  | (TraceBase & { type: 'generationComplete' })
  | (TraceBase & { type: 'turnComplete' })
  | (TraceBase & { type: 'interrupted' })
  | (TraceBase & { type: 'interactionStatus'; status: string })
  | (TraceBase & { type: 'goAway'; timeLeft: string | undefined })
  | (TraceBase & { type: 'sessionResumptionUpdate'; resumable: boolean; handle: string | undefined })
  | (TraceBase & { type: 'usage'; totalTokens: number | undefined; promptTokens: number | undefined; responseTokens: number | undefined })
  | (TraceBase & { type: 'error'; message: string })
  | (TraceBase & { type: 'close'; code: number | undefined; reason: string })
  // --- sent by the test ---
  | (TraceBase & { type: 'sentText'; text: string; via: 'realtimeInput' | 'clientContent' })
  | (TraceBase & { type: 'sentAudioStart'; ms: number; label: string | undefined })
  | (TraceBase & { type: 'sentAudioEnd'; ms: number; label: string | undefined; complete: boolean })
  | (TraceBase & { type: 'sentActivityStart' })
  | (TraceBase & { type: 'sentActivityEnd' })
  | (TraceBase & { type: 'sentAudioStreamEnd' })
  | (TraceBase & { type: 'sentToolResponse'; id: string; name: string });

export type LiveTraceEventType = LiveTraceEvent['type'];
export type LiveTraceEventOf<T extends LiveTraceEventType> = Extract<LiveTraceEvent, { type: T }>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The server closed the socket (or never answered) before `setupComplete`. */
export class LiveSetupError extends Error {
  /** WebSocket close code, when the server closed the connection. */
  readonly code: number | undefined;
  /** WebSocket close reason from the server, redacted. */
  readonly reason: string;
  constructor(message: string, code: number | undefined, reason: string) {
    super(message);
    this.name = 'LiveSetupError';
    this.code = code;
    this.reason = reason;
  }
}

/** `waitFor` gave up, or the session closed while waiting. */
export class LiveWaitError extends Error {
  readonly closed: { code: number | undefined; reason: string } | null;
  constructor(message: string, closed: { code: number | undefined; reason: string } | null) {
    super(message);
    this.name = 'LiveWaitError';
    this.closed = closed;
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface LiveTestSessionOptions {
  /**
   * A long-lived Gemini API key, read from the environment of a Node test
   * process. Never use this in browser code. Exactly one of `apiKey` /
   * `ephemeralToken` is required.
   */
  apiKey?: string;
  /** An ephemeral token (`auth_tokens/...`) minted by `authTokens.create`. */
  ephemeralToken?: string;
  /** Live model id. */
  model: string;
  /** The `config` passed to `ai.live.connect` (see `buildLiveConnectConfig`). */
  config: LiveConnectConfig;
  /** API version for the WebSocket. Defaults to the hook's `LIVE_API_VERSION`. */
  apiVersion?: string;
  /** How long to wait for `setupComplete`. Default 15 000 ms. */
  connectTimeoutMs?: number;
  /** Keep the bot's 24 kHz PCM so `outputAudioPcm()` can return it. Default false. */
  captureOutputAudio?: boolean;
  /**
   * Keep every raw server message, in arrival order, in `rawMessages`, with
   * audio payloads replaced by their byte counts and resumption handles
   * masked. Used to record replayable traces (see
   * `scripts/capture-live-traces.mjs`). Default false.
   */
  captureRawMessages?: boolean;
}

/** One raw server message as recorded by `captureRawMessages`. */
export interface LiveRawMessage {
  /** Milliseconds since the session object was created. */
  t: number;
  /**
   * The server message as received, except that every `inlineData.data`
   * payload is replaced by `{ bytes }` and `newHandle` is masked.
   */
  message: Record<string, unknown>;
}

export interface WaitOptions {
  /**
   * Only consider trace events at or after this index (from `mark()`).
   * Default 0: events already in the trace can satisfy the wait.
   */
  since?: number;
  /** Used in the timeout message. */
  description?: string;
  /**
   * Keep streaming digital silence while waiting, as an open microphone
   * would. Server-side VAD needs the audio stream to continue in order to
   * detect the end of speech.
   */
  streamSilence?: boolean;
}

export interface SendAudioOptions {
  /** Chunk size in milliseconds. Default 100. */
  chunkMs?: number;
  /**
   * Pace chunks at real-time speed (default true), as a microphone does.
   * Server VAD and barge-in timing only mean something at real-time pace.
   */
  realtime?: boolean;
  /** Label recorded on the sentAudioStart / sentAudioEnd trace events. */
  label?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class LiveTestSession {
  /** Every event sent or received, in order. */
  readonly trace: LiveTraceEvent[] = [];
  readonly model: string;

  private session: Session | null = null;
  private readonly startedAt = Date.now();
  private readonly redact: (value: unknown) => string;
  private readonly listeners = new Set<() => void>();
  private readonly captureOutputAudio: boolean;
  private readonly outputAudio: Buffer[] = [];
  private readonly captureRawMessages: boolean;
  /** Raw server messages (needs `captureRawMessages: true`). */
  readonly rawMessages: LiveRawMessage[] = [];
  private closeInfo: { code: number | undefined; reason: string } | null = null;
  private closing = false;

  private constructor(options: LiveTestSessionOptions) {
    this.model = options.model;
    this.captureOutputAudio = options.captureOutputAudio === true;
    this.captureRawMessages = options.captureRawMessages === true;
    this.redact = makeRedactor([options.apiKey, options.ephemeralToken]);
  }

  /**
   * Open a Live session and wait for `setupComplete`.
   *
   * @throws {LiveSetupError} when the server closes the socket before setup
   *   completes (the usual sign of a rejected config, e.g. code 1007) or does
   *   not answer in time. `code` and `reason` carry what the server said.
   */
  static async connect(options: LiveTestSessionOptions): Promise<LiveTestSession> {
    const credential = options.apiKey ?? options.ephemeralToken;
    if (!credential) {
      throw new Error('LiveTestSession.connect needs an apiKey or an ephemeralToken');
    }
    if (options.apiKey && options.ephemeralToken) {
      throw new Error('LiveTestSession.connect takes an apiKey or an ephemeralToken, not both');
    }
    const self = new LiveTestSession(options);
    const timeoutMs = options.connectTimeoutMs ?? 15_000;

    const ai = new GoogleGenAI({
      apiKey: credential,
      httpOptions: { apiVersion: options.apiVersion ?? LIVE_API_VERSION },
    });

    // The SDK logs two console warnings whenever an ephemeral token is used.
    // They carry no secret, but silence them so test output stays readable.
    const restoreWarn = options.ephemeralToken ? muteSdkTokenWarnings() : () => {};

    // `ai.live.connect()` resolves only once the server has sent
    // setupComplete. When the server REJECTS the setup it closes the socket
    // instead, and the SDK promise then never settles (measured with
    // @google/genai 2.11.0). So race it against the close event, which is
    // where the rejection's code and reason arrive.
    let onEarlyClose: () => void = () => {};
    const closedEarly = new Promise<'closed'>((resolve) => {
      onEarlyClose = () => resolve('closed');
    });
    const connecting = ai.live.connect({
      model: options.model,
      config: options.config,
      callbacks: {
        onopen: () => self.push({ type: 'open' }),
        onmessage: (message: LiveServerMessage) => self.onMessage(message),
        onerror: (event: { message?: string }) =>
          self.push({ type: 'error', message: self.redact(event?.message ?? 'WebSocket error') }),
        onclose: (event: { code?: number; reason?: string }) => {
          self.closeInfo = { code: event?.code, reason: self.redact(event?.reason ?? '') };
          self.push({ type: 'close', code: event?.code, reason: self.closeInfo.reason });
          onEarlyClose();
        },
      },
    });
    // If the close wins the race this promise is abandoned; never let it
    // surface as an unhandled rejection.
    connecting.catch(() => undefined);

    let winner: Session | 'closed';
    try {
      winner = await withTimeout(Promise.race([connecting, closedEarly]), timeoutMs, 'setupComplete');
    } catch (err) {
      // Timed out (or the SDK threw). If the socket opens later after all,
      // close it rather than leave it dangling.
      self.closing = true;
      connecting.then((late) => late.close()).catch(() => undefined);
      const closed = self.closeInfo as { code: number | undefined; reason: string } | null;
      throw new LiveSetupError(
        `Live connect failed for ${options.model}: ${self.redact(err)}`,
        closed?.code,
        closed?.reason ?? self.redact(err),
      );
    } finally {
      restoreWarn();
    }

    if (winner === 'closed') {
      const closed = self.closeInfo as unknown as { code: number | undefined; reason: string };
      throw new LiveSetupError(
        `Live setup rejected for ${options.model}: socket closed with ${closed.code ?? 'no code'}` +
          (closed.reason ? ` "${closed.reason}"` : '') +
          ' before setupComplete',
        closed.code,
        closed.reason,
      );
    }
    self.session = winner;

    // The SDK resolves after setupComplete, so this returns at once; it stays
    // as a guard in case a future SDK resolves on socket open instead.
    try {
      await self.waitFor((e) => e.type === 'setupComplete', timeoutMs, { description: 'setupComplete' });
    } catch (err) {
      const closed = self.closeInfo as { code: number | undefined; reason: string } | null;
      await self.close();
      throw new LiveSetupError(
        closed
          ? `Live setup rejected for ${options.model}: socket closed with ${closed.code ?? 'no code'}` +
            (closed.reason ? ` "${closed.reason}"` : '') +
            ' before setupComplete'
          : `Live setup for ${options.model} did not complete: ${self.redact(err)}`,
        closed?.code,
        closed?.reason ?? '',
      );
    }
    return self;
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** Close code and reason once the socket has closed, else null. */
  get closed(): { code: number | undefined; reason: string } | null {
    return this.closeInfo;
  }

  /** Milliseconds since the session object was created. */
  now(): number {
    return Date.now() - this.startedAt;
  }

  /** Current length of the trace. Pass as `since` to scope a later wait. */
  mark(): number {
    return this.trace.length;
  }

  /** Events of one type, optionally only those at or after a mark. */
  events<T extends LiveTraceEventType>(type: T, since = 0): LiveTraceEventOf<T>[] {
    return this.trace.slice(since).filter((e): e is LiveTraceEventOf<T> => e.type === type);
  }

  /** First event of a type at or after a mark. */
  first<T extends LiveTraceEventType>(type: T, since = 0): LiveTraceEventOf<T> | undefined {
    return this.events(type, since)[0];
  }

  /** Total bot audio bytes (24 kHz 16-bit mono PCM) received since a mark. */
  audioBytes(since = 0): number {
    return this.events('audio', since).reduce((sum, e) => sum + e.bytes, 0);
  }

  /** Concatenated output transcription since a mark. */
  outputText(since = 0): string {
    return this.events('outputTranscription', since).map((e) => e.text).join('');
  }

  /** Concatenated input transcription since a mark. */
  inputText(since = 0): string {
    return this.events('inputTranscription', since).map((e) => e.text).join('');
  }

  /** The most recent resumable session-resumption handle, if any. */
  latestResumptionHandle(): string | undefined {
    const updates = this.events('sessionResumptionUpdate').filter((e) => e.resumable && e.handle);
    return updates.length ? updates[updates.length - 1].handle : undefined;
  }

  /** Bot audio captured so far (needs `captureOutputAudio: true`). 24 kHz PCM. */
  outputAudioPcm(): Buffer {
    return Buffer.concat(this.outputAudio);
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /**
   * Send text as realtime input. This is the path `useSession` uses for its
   * opening cue (`autoGreetText`).
   */
  sendText(text: string): void {
    this.requireOpen().sendRealtimeInput({ text });
    this.push({ type: 'sentText', text, via: 'realtimeInput' });
  }

  /** Send a text turn with `sendClientContent` (structured turn content). */
  sendClientText(text: string, turnComplete = true): void {
    this.requireOpen().sendClientContent({
      turns: [{ role: 'user', parts: [{ text }] }],
      turnComplete,
    });
    this.push({ type: 'sentText', text, via: 'clientContent' });
  }

  /**
   * Stream 16 kHz mono 16-bit little-endian PCM as realtime input, paced like
   * a microphone. Resolves when the last chunk has been sent, or early (with
   * `complete: false` on the trace event) if the socket closes.
   */
  async sendAudioPcm16k(pcm: Uint8Array, options: SendAudioOptions = {}): Promise<void> {
    const chunkMs = options.chunkMs ?? 100;
    const realtime = options.realtime !== false;
    const chunkBytes = pcmBytesForMs(chunkMs);
    const totalMs = Math.round((pcm.byteLength / 2 / INPUT_SAMPLE_RATE) * 1000);
    const session = this.requireOpen();
    this.push({ type: 'sentAudioStart', ms: totalMs, label: options.label });
    const startedAt = Date.now();
    let complete = true;
    for (let offset = 0, i = 0; offset < pcm.byteLength; offset += chunkBytes, i++) {
      if (this.closeInfo || this.closing) {
        complete = false;
        break;
      }
      const chunk = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.byteLength));
      session.sendRealtimeInput({
        audio: {
          data: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64'),
          mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
        },
      });
      if (realtime) {
        // Drift-corrected: the next chunk is due at a fixed offset from the
        // start, however long the send itself took.
        const due = startedAt + (i + 1) * chunkMs;
        const wait = due - Date.now();
        if (wait > 0) await sleep(wait);
      }
    }
    this.push({ type: 'sentAudioEnd', ms: totalMs, label: options.label, complete });
  }

  /** Stream digital silence, paced like a microphone. */
  async sendSilence(ms: number, options: SendAudioOptions = {}): Promise<void> {
    await this.sendAudioPcm16k(silencePcm(ms), { label: 'silence', ...options });
  }

  /** Manual turn control: the user started speaking. */
  activityStart(): void {
    this.requireOpen().sendRealtimeInput({ activityStart: {} });
    this.push({ type: 'sentActivityStart' });
  }

  /** Manual turn control: the user finished speaking. */
  activityEnd(): void {
    this.requireOpen().sendRealtimeInput({ activityEnd: {} });
    this.push({ type: 'sentActivityEnd' });
  }

  /** Server VAD: the audio stream has paused (e.g. the microphone was muted). */
  audioStreamEnd(): void {
    this.requireOpen().sendRealtimeInput({ audioStreamEnd: true });
    this.push({ type: 'sentAudioStreamEnd' });
  }

  /**
   * Answer a tool call. A string result is wrapped as `{ result }`, which is
   * exactly what `useSession` sends for an `onToolCall` return value.
   */
  respondToTool(
    call: Pick<LiveToolCall, 'id' | 'name'>,
    result: string | Record<string, unknown>,
    options: { scheduling?: FunctionResponseScheduling } = {},
  ): void {
    this.requireOpen().sendToolResponse({
      functionResponses: [
        {
          id: call.id,
          name: call.name,
          response: typeof result === 'string' ? { result } : result,
          ...(options.scheduling ? { scheduling: options.scheduling } : {}),
        },
      ],
    });
    this.push({ type: 'sentToolResponse', id: call.id, name: call.name });
  }

  // -------------------------------------------------------------------------
  // Waiting
  // -------------------------------------------------------------------------

  /**
   * Wait until some trace event satisfies `predicate`.
   *
   * @returns the matching event.
   * @throws {LiveWaitError} on timeout, or as soon as the socket closes
   *   without a matching event (so a rejected turn fails fast, with the close
   *   code and reason in the message).
   */
  async waitFor(
    predicate: (event: LiveTraceEvent, index: number) => boolean,
    timeoutMs: number,
    options: WaitOptions = {},
  ): Promise<LiveTraceEvent> {
    const what = options.description ?? 'a matching event';
    const deadline = Date.now() + timeoutMs;
    let cursor = options.since ?? 0;
    let silenceDueAt = Date.now();

    for (;;) {
      for (; cursor < this.trace.length; cursor++) {
        if (predicate(this.trace[cursor], cursor)) return this.trace[cursor];
      }
      if (this.closeInfo) {
        throw new LiveWaitError(
          `Session closed (${this.closeInfo.code ?? 'no code'}${
            this.closeInfo.reason ? ` "${this.closeInfo.reason}"` : ''
          }) while waiting for ${what}`,
          this.closeInfo,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new LiveWaitError(`Timed out after ${timeoutMs} ms waiting for ${what}`, null);
      }
      if (options.streamSilence) {
        // 100 ms of silence every 100 ms, like an open microphone.
        if (Date.now() >= silenceDueAt) {
          try {
            this.requireOpen().sendRealtimeInput({
              audio: {
                data: silencePcm(100).toString('base64'),
                mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
              },
            });
          } catch {
            // The close is reported on the next loop iteration.
          }
          silenceDueAt += 100;
        }
        await this.nextEvent(Math.min(remaining, Math.max(1, silenceDueAt - Date.now())));
      } else {
        await this.nextEvent(remaining);
      }
    }
  }

  /** Wait for the next event of a type at or after a mark. */
  async waitForType<T extends LiveTraceEventType>(
    type: T,
    timeoutMs: number,
    options: WaitOptions = {},
  ): Promise<LiveTraceEventOf<T>> {
    const event = await this.waitFor((e) => e.type === type, timeoutMs, {
      description: type,
      ...options,
    });
    return event as LiveTraceEventOf<T>;
  }

  /** Close the session. Safe to call more than once. */
  async close(): Promise<void> {
    this.closing = true;
    const session = this.session;
    this.session = null;
    if (!session || this.closeInfo) return;
    try {
      session.close();
    } catch {
      // Already closed.
    }
    // Give the close frame a moment so the trace ends with a `close` event.
    const deadline = Date.now() + 1_000;
    while (!this.closeInfo && Date.now() < deadline) {
      await this.nextEvent(deadline - Date.now());
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireOpen(): Session {
    if (!this.session || this.closeInfo) {
      throw new LiveWaitError(
        this.closeInfo
          ? `Session is closed (${this.closeInfo.code ?? 'no code'}${
              this.closeInfo.reason ? ` "${this.closeInfo.reason}"` : ''
            })`
          : 'Session is not open',
        this.closeInfo,
      );
    }
    return this.session;
  }

  private push(event: DistributiveOmit<LiveTraceEvent, 't'>): void {
    this.trace.push({ ...event, t: this.now() } as LiveTraceEvent);
    for (const wake of [...this.listeners]) wake();
  }

  /** Resolve on the next trace event or after `ms`, whichever comes first. */
  private nextEvent(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.listeners.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.max(0, ms));
      this.listeners.add(wake);
    });
  }

  private onMessage(message: LiveServerMessage): void {
    if (this.captureRawMessages) {
      this.rawMessages.push({ t: this.now(), message: sanitizeRawMessage(message) });
    }
    if (message.setupComplete) this.push({ type: 'setupComplete' });

    const content = message.serverContent;
    if (content) {
      for (const part of content.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          const audio = Buffer.from(part.inlineData.data, 'base64');
          if (this.captureOutputAudio) this.outputAudio.push(audio);
          this.push({ type: 'audio', bytes: audio.byteLength });
        } else if (typeof part.text === 'string') {
          this.push({ type: 'text', text: part.text, thought: part.thought === true });
        }
      }
      if (content.inputTranscription?.text) {
        this.push({ type: 'inputTranscription', text: content.inputTranscription.text });
      }
      if (content.outputTranscription?.text) {
        this.push({ type: 'outputTranscription', text: content.outputTranscription.text });
      }
      if (content.interrupted) this.push({ type: 'interrupted' });
      if (content.generationComplete) this.push({ type: 'generationComplete' });
      if (content.turnComplete) this.push({ type: 'turnComplete' });
    }

    const calls = message.toolCall?.functionCalls;
    if (calls?.length) {
      this.push({
        type: 'toolCall',
        calls: calls.map((c) => ({
          id: c.id ?? '',
          name: c.name ?? '',
          args: (c.args ?? {}) as Record<string, unknown>,
        })),
      });
    }
    if (message.toolCallCancellation?.ids?.length) {
      this.push({ type: 'toolCallCancellation', ids: message.toolCallCancellation.ids });
    }
    if (message.goAway) this.push({ type: 'goAway', timeLeft: message.goAway.timeLeft });
    if (message.sessionResumptionUpdate) {
      this.push({
        type: 'sessionResumptionUpdate',
        resumable: message.sessionResumptionUpdate.resumable === true,
        handle: message.sessionResumptionUpdate.newHandle,
      });
    }
    if (message.usageMetadata) {
      this.push({
        type: 'usage',
        totalTokens: message.usageMetadata.totalTokenCount,
        promptTokens: message.usageMetadata.promptTokenCount,
        responseTokens: message.usageMetadata.responseTokenCount,
      });
    }
    // Not in the SDK's types. Extended-thinking sessions report it, either at
    // the top level of the message or inside serverContent.
    const status =
      (message as { interactionStatus?: unknown }).interactionStatus ??
      (content as { interactionStatus?: unknown } | undefined)?.interactionStatus;
    if (typeof status === 'string') this.push({ type: 'interactionStatus', status });
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * JSON-safe copy of a server message for a recorded trace: audio payloads
 * become `{ bytes }` (the audio itself is never kept) and resumption handles,
 * which are session credentials, are masked.
 */
function sanitizeRawMessage(message: unknown): Record<string, unknown> {
  const visit = (value: unknown, key: string): unknown => {
    if (Array.isArray(value)) return value.map((v) => visit(v, key));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue;
        if (k === 'data' && key === 'inlineData' && typeof v === 'string') {
          out.bytes = Buffer.from(v, 'base64').byteLength;
        } else if (k === 'newHandle' && typeof v === 'string') {
          out.newHandle = 'HANDLE-MASKED';
        } else {
          out[k] = visit(v, k);
        }
      }
      return out;
    }
    return value;
  };
  return visit(message, '') as Record<string, unknown>;
}

/**
 * Compact, human-readable rendering of a trace: one line per event, with runs
 * of audio chunks collapsed. Contains transcripts and tool names but never a
 * credential (the trace itself never holds one). Resumption handles are cut
 * to a short prefix.
 */
export function formatLiveTrace(trace: readonly LiveTraceEvent[], maxLines = 80): string[] {
  const lines: string[] = [];
  let audio: { from: number; to: number; chunks: number; bytes: number } | null = null;
  const flush = () => {
    if (!audio) return;
    lines.push(`+${audio.from}ms audio x${audio.chunks} (${(audio.bytes / 48_000).toFixed(2)} s) until +${audio.to}ms`);
    audio = null;
  };
  for (const event of trace) {
    if (event.type === 'audio') {
      if (!audio) audio = { from: event.t, to: event.t, chunks: 0, bytes: 0 };
      audio.to = event.t;
      audio.chunks += 1;
      audio.bytes += event.bytes;
      continue;
    }
    flush();
    const { t, type, ...rest } = event as LiveTraceEvent & Record<string, unknown>;
    if (type === 'sessionResumptionUpdate' && typeof rest.handle === 'string') {
      rest.handle = `${rest.handle.slice(0, 6)}…`;
    }
    if (type === 'usage') continue;
    const body = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    lines.push(`+${t}ms ${type}${body.length > 220 ? `${body.slice(0, 219)}…` : body}`);
  }
  flush();
  if (lines.length <= maxLines) return lines;
  const head = Math.floor(maxLines / 3);
  return [...lines.slice(0, head), `… ${lines.length - maxLines} lines omitted …`, ...lines.slice(lines.length - (maxLines - head))];
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The SDK warns on every ephemeral-token connect ("experimental", and
 * "v1alpha only" for other API versions). Drop exactly those two lines while
 * connecting; everything else still reaches the console.
 */
function muteSdkTokenWarnings(): () => void {
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    const first = typeof args[0] === 'string' ? args[0] : '';
    if (first.startsWith('Warning: Ephemeral token support') || first.startsWith("Warning: The SDK's ephemeral token support")) {
      return;
    }
    original(...args);
  };
  return () => {
    console.warn = original;
  };
}
