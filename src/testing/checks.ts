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
 * Named live conformance checks.
 *
 * Each check opens its own real Gemini Live session, does one thing, and
 * returns a {@link LiveCheckResult}: `{ name, pass, status, detail, metrics }`.
 * Checks never throw for a provider-side failure; the failure is the result.
 * They are usable one at a time, or together through `runLiveConformance`.
 *
 * Status values:
 *   - `pass`             — behaved as expected.
 *   - `warn`             — worked, but outside a soft budget (still `pass: true`).
 *   - `skipped`          — not applicable to this configuration (`pass: true`).
 *   - `fail`             — the production path is broken.
 *   - `contract-changed` — a provider-contract canary flipped: the server no
 *                          longer behaves the way the model registry says.
 *                          Sessions may still work; the registry needs review.
 */

import { FunctionResponseScheduling, GoogleGenAI, Modality, Type } from '@google/genai';
import type { FunctionDeclaration, LiveConnectConfig } from '@google/genai';
import { LIVE_API_VERSION } from '../services/liveConnectConfig';
import { LIVE_MODELS, getLiveModelInfo, resolveThinkingConfig } from '../services/liveModels';
import type { ThinkingRequest } from '../services/liveModels';
import { LiveSetupError, LiveTestSession, LiveWaitError, formatLiveTrace } from './LiveTestSession';
import type { LiveToolCall } from './LiveTestSession';
import { loadSpeechFixture } from './fixtures';
import type { SpeechFixtureId } from './fixtures';
import { makeRedactor } from './redact';
import { clip, wordMatchRatio } from './text';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LiveCheckStatus = 'pass' | 'warn' | 'skipped' | 'fail' | 'contract-changed';

export interface LiveCheckResult {
  name: string;
  /** True for `pass`, `warn` and `skipped`. */
  pass: boolean;
  status: LiveCheckStatus;
  /** One line a person can act on. Never contains a key or token. */
  detail: string;
  metrics: Record<string, number | string | boolean>;
  durationMs: number;
  /**
   * Present only when the check did not pass: a compact trace of every
   * session the check opened (see `formatLiveTrace`), for diagnosis. Contains
   * transcripts and tool names, never a credential.
   */
  trace?: string[];
}

/** What a check connects with. */
export interface LiveCheckTarget {
  /** Long-lived Gemini API key from the test process environment. */
  apiKey: string;
  model: string;
  /** The exact `config` production passes to `ai.live.connect`. */
  config: LiveConnectConfig;
  /** WebSocket API version. Defaults to the hook's `LIVE_API_VERSION`. */
  apiVersion?: string;
}

type Outcome = {
  status: LiveCheckStatus;
  detail: string;
  metrics?: Record<string, number | string | boolean>;
};

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

async function runCheck(
  name: string,
  apiKey: string,
  body: (open: (overrides?: Partial<Parameters<typeof LiveTestSession.connect>[0]>) => Promise<LiveTestSession>) => Promise<Outcome>,
  target?: LiveCheckTarget,
): Promise<LiveCheckResult> {
  const startedAt = Date.now();
  const redact = makeRedactor([apiKey]);
  const sessions: LiveTestSession[] = [];
  const open = async (overrides: Partial<Parameters<typeof LiveTestSession.connect>[0]> = {}) => {
    if (!target && !(overrides.model && overrides.config)) {
      throw new Error('check opened a session without a target');
    }
    const usesToken = typeof overrides.ephemeralToken === 'string';
    const session = await LiveTestSession.connect({
      ...(usesToken ? {} : { apiKey }),
      model: target?.model ?? '',
      config: target?.config ?? {},
      apiVersion: target?.apiVersion,
      ...overrides,
    });
    sessions.push(session);
    return session;
  };

  let outcome: Outcome;
  try {
    outcome = await body(open);
  } catch (err) {
    if (err instanceof LiveSetupError) {
      outcome = {
        status: 'fail',
        detail: redact(err.message),
        metrics: { closeCode: err.code ?? 'none', closeReason: err.reason },
      };
    } else if (err instanceof LiveWaitError) {
      outcome = {
        status: 'fail',
        detail: redact(err.message),
        metrics: err.closed ? { closeCode: err.closed.code ?? 'none', closeReason: err.closed.reason } : {},
      };
    } else {
      outcome = { status: 'fail', detail: `Unexpected error: ${redact(err)}` };
    }
  } finally {
    await Promise.all(sessions.map((s) => s.close().catch(() => undefined)));
  }
  const pass = outcome.status === 'pass' || outcome.status === 'warn' || outcome.status === 'skipped';
  return {
    name,
    pass,
    status: outcome.status,
    detail: redact(outcome.detail),
    metrics: outcome.metrics ?? {},
    durationMs: Date.now() - startedAt,
    ...(pass
      ? {}
      : {
          trace: sessions.flatMap((s, i) => [
            `--- session ${i + 1} of ${sessions.length} (${s.model}) ---`,
            ...formatLiveTrace(s.trace).map((line) => redact(line)),
          ]),
        }),
  };
}

/** True when the config disables the server's automatic VAD. */
export function isManualTurnControl(config: LiveConnectConfig): boolean {
  return config.realtimeInputConfig?.automaticActivityDetection?.disabled === true;
}

/** Copy of a config with the server's automatic VAD disabled. */
export function withManualTurnControl(config: LiveConnectConfig): LiveConnectConfig {
  return {
    ...config,
    realtimeInputConfig: {
      ...config.realtimeInputConfig,
      automaticActivityDetection: { disabled: true },
    },
  };
}

/** Copy of a config with a different server-VAD silence duration. */
export function withSilenceDurationMs(config: LiveConnectConfig, silenceDurationMs: number): LiveConnectConfig {
  return {
    ...config,
    realtimeInputConfig: {
      ...config.realtimeInputConfig,
      automaticActivityDetection: {
        ...config.realtimeInputConfig?.automaticActivityDetection,
        disabled: false,
        silenceDurationMs,
      },
    },
  };
}

function configuredSilenceMs(config: LiveConnectConfig): number | undefined {
  return config.realtimeInputConfig?.automaticActivityDetection?.silenceDurationMs;
}

function declaredToolNames(config: LiveConnectConfig): string[] {
  const names: string[] = [];
  for (const tool of config.tools ?? []) {
    if ('functionDeclarations' in tool) {
      for (const d of tool.functionDeclarations ?? []) if (d.name) names.push(d.name);
    }
  }
  return names;
}

function withExtraTool(config: LiveConnectConfig, declaration: FunctionDeclaration): LiveConnectConfig {
  const existing: FunctionDeclaration[] = [];
  const others = [];
  for (const tool of config.tools ?? []) {
    if ('functionDeclarations' in tool && tool.functionDeclarations) existing.push(...tool.functionDeclarations);
    else others.push(tool);
  }
  return { ...config, tools: [...others, { functionDeclarations: [...existing, declaration] }] };
}

/** Milliseconds between two trace timestamps, rounded. */
const ms = (from: number, to: number) => Math.round(to - from);

/**
 * Speak one fixture as a full user turn using the config's own turn-taking
 * mode, then wait for the bot's reply to finish.
 */
async function speakTurn(
  session: LiveTestSession,
  config: LiveConnectConfig,
  pcm: Uint8Array,
  replyTimeoutMs: number,
): Promise<{ since: number; speechEndT: number; firstAudioT: number | undefined }> {
  const since = session.mark();
  const manual = isManualTurnControl(config);
  if (manual) session.activityStart();
  await session.sendAudioPcm16k(pcm, { label: 'speech' });
  const speechEndT = session.now();
  if (manual) session.activityEnd();
  await session.waitForType('turnComplete', replyTimeoutMs, {
    since,
    // An open microphone keeps streaming; server VAD needs that to see the end.
    streamSilence: !manual,
    description: 'the bot to finish replying to the spoken turn',
  });
  // Input transcription can trail the reply slightly; give it a moment.
  if (session.events('inputTranscription', since).length === 0) {
    await session
      .waitForType('inputTranscription', 2_000, { since, streamSilence: !manual })
      .catch(() => undefined);
  }
  return { since, speechEndT, firstAudioT: session.first('audio', since)?.t };
}

// ---------------------------------------------------------------------------
// (1) Setup accepted
// ---------------------------------------------------------------------------

/**
 * The production config is accepted: the socket reaches `setupComplete`.
 * On failure the detail carries the server's close code and reason, which is
 * where a rejected thinking level, tool schema or voice shows up.
 */
export function checkSetupAccepted(target: LiveCheckTarget): Promise<LiveCheckResult> {
  return runCheck('setup', target.apiKey, async (open) => {
    const session = await open();
    const opened = session.first('open')?.t ?? 0;
    const setup = session.first('setupComplete')?.t ?? session.now();
    return {
      status: 'pass',
      detail: `setupComplete for ${target.model}`,
      metrics: {
        setupMs: ms(opened, setup),
        toolDeclarations: declaredToolNames(target.config).length,
        thinkingLevel: String(target.config.thinkingConfig?.thinkingLevel ?? 'omitted'),
      },
    };
  }, target);
}

// ---------------------------------------------------------------------------
// (2) Text turn
// ---------------------------------------------------------------------------

export interface TextTurnOptions {
  /** Text sent as realtime input, as `useSession` sends its opening cue. */
  prompt?: string;
  timeoutMs?: number;
}

/** A text cue produces bot audio, an output transcription and turnComplete. */
export function checkTextTurn(target: LiveCheckTarget, options: TextTurnOptions = {}): Promise<LiveCheckResult> {
  const prompt = options.prompt ?? '[Session started. Please greet the user in one short sentence.]';
  return runCheck('text-turn', target.apiKey, async (open) => {
    const session = await open();
    const since = session.mark();
    const sentAt = session.now();
    session.sendText(prompt);
    const done = await session.waitForType('turnComplete', options.timeoutMs ?? 30_000, { since });
    const audioBytes = session.audioBytes(since);
    const text = session.outputText(since).trim();
    const firstAudio = session.first('audio', since)?.t;
    const metrics = {
      firstAudioMs: firstAudio === undefined ? -1 : ms(sentAt, firstAudio),
      turnCompleteMs: ms(sentAt, done.t),
      audioSeconds: Number((audioBytes / 48_000).toFixed(2)),
      outputTranscriptionEvents: session.events('outputTranscription', since).length,
      reply: clip(text, 60),
    };
    if (audioBytes === 0) return { status: 'fail', detail: 'turnComplete arrived but no bot audio was received', metrics };
    if (!text) return { status: 'fail', detail: 'bot audio arrived without any output transcription', metrics };
    return { status: 'pass', detail: `bot replied "${clip(text, 60)}"`, metrics };
  }, target);
}

// ---------------------------------------------------------------------------
// (3) Audio turn under server VAD
// ---------------------------------------------------------------------------

export interface AudioTurnOptions {
  fixture?: SpeechFixtureId;
  /** Minimum fraction of the fixture's words the input transcription must contain. Default 0.6. */
  minWordMatch?: number;
  timeoutMs?: number;
}

function audioTurnOutcome(
  session: LiveTestSession,
  turn: { since: number; speechEndT: number; firstAudioT: number | undefined },
  expectedText: string,
  minWordMatch: number,
): Outcome {
  const heard = session.inputText(turn.since).trim();
  const match = wordMatchRatio(expectedText, heard);
  const audioBytes = session.audioBytes(turn.since);
  const firstInput = session.first('inputTranscription', turn.since)?.t;
  const metrics = {
    wordMatch: Number(match.toFixed(2)),
    heard: clip(heard, 60),
    inputTranscriptionEvents: session.events('inputTranscription', turn.since).length,
    inputTranscriptionAfterSpeechEndMs: firstInput === undefined ? -1 : ms(turn.speechEndT, firstInput),
    speechEndToFirstAudioMs: turn.firstAudioT === undefined ? -1 : ms(turn.speechEndT, turn.firstAudioT),
    audioSeconds: Number((audioBytes / 48_000).toFixed(2)),
    reply: clip(session.outputText(turn.since), 60),
  };
  if (audioBytes === 0) return { status: 'fail', detail: 'the bot did not answer the spoken turn', metrics };
  if (!heard) return { status: 'fail', detail: 'no input transcription was received for the spoken turn', metrics };
  if (match < minWordMatch) {
    return {
      status: 'fail',
      detail: `input transcription "${clip(heard, 60)}" matches only ${(match * 100).toFixed(0)}% of "${expectedText}"`,
      metrics,
    };
  }
  return { status: 'pass', detail: `heard "${clip(heard, 60)}" and answered`, metrics };
}

/**
 * A spoken user turn under the profile's server-VAD settings: the input
 * transcription fuzzy-matches the fixture and the bot answers. Skipped when
 * the config uses manual turn control (see `checkManualTurnControl`).
 */
export function checkAudioTurn(target: LiveCheckTarget, options: AudioTurnOptions = {}): Promise<LiveCheckResult> {
  return runCheck('audio-turn', target.apiKey, async (open) => {
    if (isManualTurnControl(target.config)) {
      return { status: 'skipped', detail: 'config uses manual turn control; covered by manual-turn-control' };
    }
    const fixture = loadSpeechFixture(options.fixture ?? 'question-capital');
    const session = await open();
    const turn = await speakTurn(session, target.config, fixture.pcm, options.timeoutMs ?? 30_000);
    return audioTurnOutcome(session, turn, fixture.text, options.minWordMatch ?? 0.6);
  }, target);
}

// ---------------------------------------------------------------------------
// (4) Tools
// ---------------------------------------------------------------------------

export interface ToolProbe {
  /** Text that should make the model call `expectTool`. */
  prompt: string;
  /** Name of the tool that must be called. */
  expectTool: string;
  /** What the test answers the call with. Default `'ok'`. */
  result?: string | Record<string, unknown>;
  /** Words that must appear in the bot's spoken reply after the tool result. */
  expectInReply?: string;
}

const BUILTIN_PROBE_TOOL: FunctionDeclaration = {
  name: 'lookupConformanceCodeWord',
  description: 'Looks up the conformance-test code word. Call it whenever the user asks for the code word.',
  parameters: { type: Type.OBJECT, properties: {}, required: [] },
};

const BUILTIN_PROBE: ToolProbe = {
  prompt: 'Please call the lookupConformanceCodeWord tool now, then tell me the code word it returns.',
  expectTool: BUILTIN_PROBE_TOOL.name!,
  result: 'The code word is marigold.',
  expectInReply: 'marigold',
};

/**
 * Tool round trip: a prompt triggers the named tool, the test answers it, and
 * the bot carries on speaking. With no probe, a built-in tool is added to the
 * config's own declarations and probed instead.
 */
export function checkToolRoundTrip(
  target: LiveCheckTarget,
  probe?: ToolProbe,
  options: { timeoutMs?: number } = {},
): Promise<LiveCheckResult> {
  const usingBuiltin = !probe;
  const active = probe ?? BUILTIN_PROBE;
  const config = usingBuiltin ? withExtraTool(target.config, BUILTIN_PROBE_TOOL) : target.config;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return runCheck('tool-round-trip', target.apiKey, async (open) => {
    if (!usingBuiltin && !declaredToolNames(config).includes(active.expectTool)) {
      return {
        status: 'fail',
        detail: `tool '${active.expectTool}' is not declared in the config (declared: ${declaredToolNames(config).join(', ') || 'none'})`,
      };
    }
    const session = await open({ config });
    const since = session.mark();
    const sentAt = session.now();
    session.sendText(active.prompt);

    // Other tools may be called first; answer them and keep waiting.
    const othersCalled: string[] = [];
    let cursor = since;
    let wanted: LiveToolCall | undefined;
    let callT = 0;
    const deadline = Date.now() + timeoutMs;
    while (!wanted) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          status: 'fail',
          detail: `the model never called '${active.expectTool}'` +
            (othersCalled.length ? ` (it called: ${othersCalled.join(', ')})` : '') +
            `; it said "${clip(session.outputText(since), 60)}"`,
          metrics: { otherToolsCalled: othersCalled.join(',') },
        };
      }
      const event = await session.waitForType('toolCall', remaining, {
        since: cursor,
        description: `a call to ${active.expectTool}`,
      }).catch((err) => {
        if (err instanceof LiveWaitError && !err.closed) return undefined;
        throw err;
      });
      if (!event) continue;
      cursor = session.trace.indexOf(event) + 1;
      for (const call of event.calls) {
        if (call.name === active.expectTool && !wanted) {
          wanted = call;
          callT = event.t;
        } else {
          othersCalled.push(call.name);
          session.respondToTool(call, 'ok');
        }
      }
    }

    const audioBeforeResponse = session.audioBytes(since);
    const afterResponse = session.mark();
    session.respondToTool(wanted, active.result ?? 'ok');
    // With asynchronous function calling (the gemini-3.8-live default) the
    // turn that issued the call ends at once: generationComplete and
    // turnComplete arrive right after the toolCall, BEFORE the spoken reply
    // to the tool result. So the reply's turnComplete is the first one after
    // the reply's audio starts, not the first one after the response.
    const replyAudio = await session.waitFor((e) => e.type === 'audio', timeoutMs, {
      since: afterResponse,
      description: 'the bot to speak after the tool response',
    });
    const replyAudioIndex = session.trace.indexOf(replyAudio);
    const turnCompleteBeforeReply = session.trace
      .slice(afterResponse, replyAudioIndex)
      .some((e) => e.type === 'turnComplete');
    await session.waitForType('turnComplete', timeoutMs, { since: replyAudioIndex });
    const reply = session.outputText(afterResponse).trim();
    const metrics = {
      toolCallMs: ms(sentAt, callT),
      toolResponseToReplyAudioMs: ms(callT, replyAudio.t),
      // 'fc_' ids are blocking calls, 'call_' ids are asynchronous ones.
      callIdPrefix: wanted.id.split('_')[0] || 'none',
      turnCompleteBeforeReply,
      spokeBeforeToolResponse: audioBeforeResponse > 0,
      otherToolsCalled: othersCalled.join(','),
      reply: clip(reply, 60),
    };
    if (active.expectInReply && wordMatchRatio(active.expectInReply, reply) < 1) {
      return {
        status: 'fail',
        detail: `tool was called and answered, but the reply "${clip(reply, 60)}" does not mention "${active.expectInReply}"`,
        metrics,
      };
    }
    return {
      status: 'pass',
      detail: `'${active.expectTool}' called, answered, and the bot continued: "${clip(reply, 50)}"`,
      metrics,
    };
  }, target);
}

/**
 * The full tool-declaration list is ACCEPTED: setup completes and a first
 * turn runs with every declaration live. A schema the server dislikes closes
 * the socket here, with the reason in the detail.
 */
export function checkToolDeclarationsAccepted(
  target: LiveCheckTarget,
  options: { timeoutMs?: number } = {},
): Promise<LiveCheckResult> {
  return runCheck('tool-declarations', target.apiKey, async (open) => {
    const names = declaredToolNames(target.config);
    if (names.length === 0) return { status: 'skipped', detail: 'config declares no tools' };
    const session = await open();
    const since = session.mark();
    session.sendText('[Connection test. Reply with one short sentence.]');
    // Either outcome proves the declarations were accepted and are live.
    await session.waitFor((e) => e.type === 'turnComplete' || e.type === 'toolCall', options.timeoutMs ?? 30_000, {
      since,
      description: 'a first turn with all tools declared',
    });
    return {
      status: 'pass',
      detail: `${names.length} tool declaration(s) accepted: ${clip(names.join(', '), 90)}`,
      metrics: { toolDeclarations: names.length },
    };
  }, target);
}

// ---------------------------------------------------------------------------
// (5) Manual turn control
// ---------------------------------------------------------------------------

/**
 * Manual turn control: with automatic VAD disabled, `activityStart` + audio +
 * `activityEnd` produces a reply. Always run with VAD disabled, whatever the
 * config says, so an app knows its fallback mode works too.
 */
export function checkManualTurnControl(target: LiveCheckTarget, options: AudioTurnOptions = {}): Promise<LiveCheckResult> {
  const config = withManualTurnControl(target.config);
  return runCheck('manual-turn-control', target.apiKey, async (open) => {
    const fixture = loadSpeechFixture(options.fixture ?? 'question-capital');
    const session = await open({ config });
    const turn = await speakTurn(session, config, fixture.pcm, options.timeoutMs ?? 30_000);
    return audioTurnOutcome(session, turn, fixture.text, options.minWordMatch ?? 0.6);
  }, target);
}

// ---------------------------------------------------------------------------
// (6) Patience
// ---------------------------------------------------------------------------

export interface PatienceOptions {
  /**
   * Server-VAD silence to test. Defaults to the config's own
   * `silenceDurationMs`; the check is skipped when neither is set.
   */
  silenceMs?: number;
  /** Mid-utterance gap of digital silence. Default 60% of `silenceMs`. */
  gapMs?: number;
  timeoutMs?: number;
}

/**
 * Patience: `silenceDurationMs` is honoured across a mid-utterance pause on
 * clean audio. Two halves of a sentence are streamed with a silent gap
 * shorter than the configured silence; the bot must stay quiet through the
 * gap, treat both halves as ONE turn, and not answer sooner than the
 * configured silence after the speech ends.
 *
 * Limitation: the gap is digital silence. A real room has noise, which can
 * retrigger server VAD; this check proves the setting reaches the server and
 * is obeyed, not that a noisy room behaves the same.
 */
export function checkPatience(target: LiveCheckTarget, options: PatienceOptions = {}): Promise<LiveCheckResult> {
  return runCheck('patience', target.apiKey, async (open) => {
    if (isManualTurnControl(target.config) && options.silenceMs === undefined) {
      return { status: 'skipped', detail: 'config uses manual turn control; the client decides when a turn ends' };
    }
    const silenceMs = options.silenceMs ?? configuredSilenceMs(target.config);
    if (silenceMs === undefined) {
      return {
        status: 'skipped',
        detail: 'config uses the server default silence (about 800 ms); pass patience.silenceMs to test a value',
      };
    }
    const config = options.silenceMs !== undefined ? withSilenceDurationMs(target.config, silenceMs) : target.config;
    const gapMs = options.gapMs ?? Math.max(400, Math.round(silenceMs * 0.6));
    const part1 = loadSpeechFixture('story-part-1');
    const part2 = loadSpeechFixture('story-part-2');
    const session = await open({ config });

    const since = session.mark();
    await session.sendAudioPcm16k(part1.pcm, { label: 'part-1' });
    const gapStart = session.mark();
    await session.sendSilence(gapMs);
    const gapEnd = session.mark();
    const audioInGap = session.trace.slice(gapStart, gapEnd).filter((e) => e.type === 'audio').length;
    const turnsInGap = session.trace.slice(gapStart, gapEnd).filter((e) => e.type === 'turnComplete').length;
    await session.sendAudioPcm16k(part2.pcm, { label: 'part-2' });
    const speechEndT = session.now();
    await session.waitForType('turnComplete', options.timeoutMs ?? silenceMs + 30_000, {
      since: gapEnd,
      streamSilence: true,
      description: 'the bot to answer after the second half',
    });
    if (session.events('inputTranscription', since).length === 0) {
      await session.waitForType('inputTranscription', 2_000, { since, streamSilence: true }).catch(() => undefined);
    }

    const heard = session.inputText(since).trim();
    const match = wordMatchRatio(`${part1.text} ${part2.text}`, heard);
    const firstAudioAfter = session.first('audio', gapEnd)?.t;
    const responseDelayMs = firstAudioAfter === undefined ? -1 : ms(speechEndT, firstAudioAfter);
    const turnCompletes = session.events('turnComplete', since).length;
    const metrics = {
      silenceMs,
      gapMs,
      botAudioEventsInGap: audioInGap,
      turnCompletesInGap: turnsInGap,
      turnCompletes,
      responseDelayAfterSpeechMs: responseDelayMs,
      wordMatch: Number(match.toFixed(2)),
      heard: clip(heard, 60),
    };
    if (audioInGap > 0 || turnsInGap > 0) {
      return {
        status: 'fail',
        detail: `the bot spoke during a ${gapMs} ms pause although silenceDurationMs is ${silenceMs}`,
        metrics,
      };
    }
    if (turnCompletes !== 1) {
      return { status: 'fail', detail: `expected one bot turn for the whole sentence, saw ${turnCompletes}`, metrics };
    }
    if (match < 0.6) {
      return {
        status: 'fail',
        detail: `both halves should be one transcribed turn; heard "${clip(heard, 60)}" (${(match * 100).toFixed(0)}% match)`,
        metrics,
      };
    }
    // Answering much sooner than the configured silence means it was ignored.
    if (responseDelayMs >= 0 && responseDelayMs < silenceMs * 0.7) {
      return {
        status: 'fail',
        detail: `the bot answered ${responseDelayMs} ms after speech ended, sooner than silenceDurationMs=${silenceMs}`,
        metrics,
      };
    }
    return {
      status: 'pass',
      detail: `stayed quiet through a ${gapMs} ms pause, one turn, answered ${responseDelayMs} ms after speech (silenceDurationMs=${silenceMs})`,
      metrics,
    };
  }, target);
}

// ---------------------------------------------------------------------------
// (7) Barge-in
// ---------------------------------------------------------------------------

export interface BargeInOptions {
  /** Text that makes the bot talk for a long time. */
  prompt?: string;
  /** How long the bot speaks before the user interrupts. Default 1500 ms. */
  speakForMs?: number;
  timeoutMs?: number;
}

/** Barge-in: speaking over the bot produces an `interrupted` event. */
export function checkBargeIn(target: LiveCheckTarget, options: BargeInOptions = {}): Promise<LiveCheckResult> {
  return runCheck('barge-in', target.apiKey, async (open): Promise<Outcome> => {
    const fixture = loadSpeechFixture('barge-in');
    const manual = isManualTurnControl(target.config);
    const session = await open();
    const since = session.mark();
    session.sendText(
      options.prompt ??
        '[Test cue. Count out loud from one to fifty, slowly, saying every number, without stopping.]',
    );
    await session.waitFor((e) => e.type === 'audio', options.timeoutMs ?? 30_000, {
      since,
      description: 'the bot to start speaking',
    });
    await new Promise((r) => setTimeout(r, options.speakForMs ?? 1_500));
    if (session.events('turnComplete', since).length > 0) {
      return {
        status: 'fail',
        detail: `the bot finished speaking before it could be interrupted (said "${clip(session.outputText(since), 50)}"); use a prompt with a longer answer`,
      };
    }
    const bargeMark = session.mark();
    const bargeAt = session.now();
    if (manual) session.activityStart();
    // Keep talking in the background while watching for the interruption.
    const speaking = session.sendAudioPcm16k(fixture.pcm, { label: 'barge-in' }).catch(() => undefined);
    let interruptedT: number;
    try {
      interruptedT = (await session.waitForType('interrupted', 8_000, { since: bargeMark })).t;
    } catch (err) {
      await speaking;
      if (err instanceof LiveWaitError && !err.closed) {
        return {
          status: 'fail',
          detail: 'no `interrupted` event within 8 s of the user speaking over the bot',
          metrics: { botAudioEventsDuringBargeIn: session.events('audio', bargeMark).length },
        };
      }
      throw err;
    }
    await speaking;
    if (manual) session.activityEnd();
    return {
      status: 'pass',
      detail: `interrupted ${ms(bargeAt, interruptedT)} ms after the user started speaking`,
      metrics: { bargeInToInterruptedMs: ms(bargeAt, interruptedT) },
    };
  }, target);
}

// ---------------------------------------------------------------------------
// (8) Session resumption
// ---------------------------------------------------------------------------

/**
 * Session resumption: capture a handle, reconnect with it, and the bot still
 * remembers what was said before the reconnect.
 */
export function checkSessionResumption(
  target: LiveCheckTarget,
  options: { codeWord?: string; timeoutMs?: number } = {},
): Promise<LiveCheckResult> {
  const codeWord = options.codeWord ?? 'marigold';
  const timeoutMs = options.timeoutMs ?? 30_000;
  return runCheck('session-resumption', target.apiKey, async (open) => {
    const base: LiveConnectConfig = { ...target.config, sessionResumption: {} };
    const first = await open({ config: base });
    const since = first.mark();
    first.sendText(`[Test cue. The code word is ${codeWord}. Remember it. Reply with just "Okay".]`);
    await first.waitForType('turnComplete', timeoutMs, { since });
    const turnDoneT = first.now();
    // The handle that covers the turn arrives after the turn completes.
    // A handle is normally issued right after setup and stays valid for the
    // session; give a fresher one a moment to arrive, then use the latest.
    if (!first.latestResumptionHandle()) {
      await first
        .waitFor((e) => e.type === 'sessionResumptionUpdate' && e.resumable && !!e.handle, 10_000, {
          description: 'a resumable session handle',
        })
        .catch(() => undefined);
    } else {
      await first
        .waitFor((e) => e.type === 'sessionResumptionUpdate' && e.resumable && !!e.handle && e.t >= turnDoneT - 50, 1_500, {
          since,
        })
        .catch(() => undefined);
    }
    const handle = first.latestResumptionHandle();
    if (!handle) {
      return { status: 'fail', detail: 'the server never issued a resumable session handle' };
    }
    const handleWaitMs = ms(turnDoneT, first.now());
    await first.close();

    const second = await open({ config: { ...target.config, sessionResumption: { handle } } });
    const resumedSince = second.mark();
    second.sendText('[Test cue. What is the code word you were asked to remember? Say only that word.]');
    await second.waitForType('turnComplete', timeoutMs, { since: resumedSince });
    const reply = second.outputText(resumedSince).trim();
    const metrics = {
      handleWaitMs,
      handlesIssued: first.events('sessionResumptionUpdate').filter((e) => e.resumable && e.handle).length,
      reply: clip(reply, 60),
    };
    if (wordMatchRatio(codeWord, reply) < 1) {
      return {
        status: 'fail',
        detail: `reconnected with the handle, but the bot did not recall "${codeWord}" (said "${clip(reply, 60)}")`,
        metrics,
      };
    }
    return { status: 'pass', detail: `context survived the reconnect: bot recalled "${codeWord}"`, metrics };
  }, target);
}

// ---------------------------------------------------------------------------
// (9) Context window compression
// ---------------------------------------------------------------------------

/** `contextWindowCompression` is accepted at setup and a turn runs with it. */
export function checkContextWindowCompression(target: LiveCheckTarget): Promise<LiveCheckResult> {
  return runCheck('context-compression', target.apiKey, async (open) => {
    const present = target.config.contextWindowCompression !== undefined;
    const config: LiveConnectConfig = present
      ? target.config
      : { ...target.config, contextWindowCompression: { slidingWindow: {} } };
    const session = await open({ config });
    const since = session.mark();
    session.sendText('[Connection test. Reply with one short sentence.]');
    await session.waitFor((e) => e.type === 'turnComplete' || e.type === 'toolCall', 30_000, { since });
    return {
      status: 'pass',
      detail: present
        ? 'contextWindowCompression (sliding window) accepted'
        : 'config has no contextWindowCompression; a sliding window was added for this check and accepted',
      metrics: { inProductionConfig: present },
    };
  }, target);
}

// ---------------------------------------------------------------------------
// (10) Provider-contract canaries
// ---------------------------------------------------------------------------

const THINKING_PROBES: ThinkingRequest[] = ['none', 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH'];

async function probeSetup(
  open: (o?: Partial<Parameters<typeof LiveTestSession.connect>[0]>) => Promise<LiveTestSession>,
  model: string,
  config: LiveConnectConfig,
  apiVersion: string | undefined,
): Promise<{ accepted: boolean; code?: number; reason: string; inconclusive: boolean }> {
  try {
    const session = await open({ model, config, apiVersion });
    await session.close();
    return { accepted: true, reason: '', inconclusive: false };
  } catch (err) {
    if (err instanceof LiveSetupError) {
      // 1007 = invalid setup payload: a real "the server rejects this config".
      return { accepted: false, code: err.code, reason: err.reason, inconclusive: err.code !== 1007 };
    }
    throw err;
  }
}

/**
 * Canary: the server's `thinkingConfig` contract for a model still matches
 * the registry. Every request (`none`, MINIMAL, LOW, MEDIUM, HIGH) is tried
 * at setup and compared with what `resolveThinkingConfig` predicts.
 *
 * Reports `contract-changed`, not `fail`, when they differ: sessions built
 * with `'auto'` may be unaffected, but the registry needs updating.
 */
export function canaryThinkingContract(
  apiKey: string,
  model: string,
  options: { apiVersion?: string } = {},
): Promise<LiveCheckResult> {
  return runCheck(`thinking-contract:${model}`, apiKey, async (open) => {
    if (!getLiveModelInfo(model)) {
      return { status: 'skipped', detail: `'${model}' is not in the registry; nothing to compare` };
    }
    const metrics: Record<string, string> = {};
    const changed: string[] = [];
    const inconclusive: string[] = [];
    for (const requested of THINKING_PROBES) {
      let predicted: 'accepted' | 'rejected';
      let thinkingConfig: LiveConnectConfig['thinkingConfig'];
      try {
        // For the prediction, send exactly what was asked (bypass 'auto').
        thinkingConfig = resolveThinkingConfig(model, requested);
        predicted = 'accepted';
      } catch {
        predicted = 'rejected';
        thinkingConfig = requested === 'none' ? undefined : { thinkingLevel: requested as never };
      }
      const actual = await probeSetup(
        open,
        model,
        { responseModalities: [Modality.AUDIO], ...(thinkingConfig ? { thinkingConfig } : {}) },
        options.apiVersion,
      );
      const label = String(requested);
      metrics[label] = actual.accepted ? 'accepted' : `rejected(${actual.code ?? 'no code'})`;
      if (actual.inconclusive) {
        inconclusive.push(`${label}: closed ${actual.code ?? 'without a code'} "${actual.reason}"`);
      } else if ((actual.accepted ? 'accepted' : 'rejected') !== predicted) {
        changed.push(
          `${label}: registry says ${predicted}, server ${actual.accepted ? 'accepted' : `rejected ("${actual.reason}")`}`,
        );
      }
    }
    if (changed.length) {
      return {
        status: 'contract-changed',
        detail: `PROVIDER CONTRACT CHANGED for ${model} thinkingConfig. ${changed.join('; ')}. Update src/services/liveModels.ts.`,
        metrics,
      };
    }
    if (inconclusive.length) {
      return { status: 'fail', detail: `could not measure the thinking contract: ${inconclusive.join('; ')}`, metrics };
    }
    return { status: 'pass', detail: `thinkingConfig contract matches the registry (${THINKING_PROBES.map((p) => `${p}=${metrics[String(p)]}`).join(', ')})`, metrics };
  });
}

/**
 * Canary: whether the model accepts a tool declared `behavior: BLOCKING`
 * still matches the registry (`non-blocking-only` models reject it at setup).
 */
export function canaryToolBehaviorContract(
  apiKey: string,
  model: string,
  options: { apiVersion?: string } = {},
): Promise<LiveCheckResult> {
  return runCheck(`tool-behavior-contract:${model}`, apiKey, async (open) => {
    const info = getLiveModelInfo(model);
    if (!info || info.toolExecution === 'unverified') {
      return { status: 'skipped', detail: `no tool-execution facts recorded for '${model}'` };
    }
    let thinkingConfig: LiveConnectConfig['thinkingConfig'];
    try {
      thinkingConfig = resolveThinkingConfig(model, 'auto');
    } catch {
      thinkingConfig = undefined;
    }
    const declaration = { ...BUILTIN_PROBE_TOOL, behavior: 'BLOCKING' } as FunctionDeclaration;
    const actual = await probeSetup(
      open,
      model,
      {
        responseModalities: [Modality.AUDIO],
        ...(thinkingConfig ? { thinkingConfig } : {}),
        tools: [{ functionDeclarations: [declaration] }],
      },
      options.apiVersion,
    );
    const predicted = info.toolExecution === 'non-blocking-only' ? 'rejected' : 'accepted';
    const got = actual.accepted ? 'accepted' : 'rejected';
    const metrics = { blockingDeclaration: actual.accepted ? 'accepted' : `rejected(${actual.code ?? 'no code'})` };
    if (actual.inconclusive) {
      return { status: 'fail', detail: `could not measure: closed ${actual.code ?? 'without a code'} "${actual.reason}"`, metrics };
    }
    if (got !== predicted) {
      return {
        status: 'contract-changed',
        detail: `PROVIDER CONTRACT CHANGED for ${model}: registry says a BLOCKING tool declaration is ${predicted}, server ${got}${actual.reason ? ` ("${actual.reason}")` : ''}. Update src/services/liveModels.ts.`,
        metrics,
      };
    }
    return { status: 'pass', detail: `BLOCKING tool declaration ${got}, as the registry says`, metrics };
  });
}

/** Minimal setup for a model-level canary: audio out, one probe tool. */
function canaryToolConfig(model: string): LiveConnectConfig {
  let thinkingConfig: LiveConnectConfig['thinkingConfig'];
  try {
    thinkingConfig = resolveThinkingConfig(model, 'auto');
  } catch {
    thinkingConfig = undefined;
  }
  return {
    systemInstruction: {
      parts: [{ text: 'You are a voice assistant in an automated test. Answer in one short sentence.' }],
    },
    responseModalities: [Modality.AUDIO],
    outputAudioTranscription: {},
    ...(thinkingConfig ? { thinkingConfig } : {}),
    tools: [{ functionDeclarations: [BUILTIN_PROBE_TOOL] }],
  };
}

/**
 * Canary: the ORDER of events around a tool call still matches the registry.
 *
 * `useSession` keeps its transcript, its speaking state and its end-of-session
 * handling correct under each model's ordering, and the offline replay tests
 * prove that against recorded traces. This canary notices when the provider
 * changes the ordering those recordings captured:
 *   - whether a `turnComplete` arrives between the `toolCall` and the spoken
 *     reply to the tool result (`toolCallEndsTurnEarly`);
 *   - whether calls are asynchronous (ids start `call_`) or blocking (`fc_`);
 *   - whether the model reports `interactionStatus` (`idleSignal`).
 */
export function canaryToolCallOrdering(
  apiKey: string,
  model: string,
  options: { apiVersion?: string; timeoutMs?: number } = {},
): Promise<LiveCheckResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return runCheck(`tool-call-ordering:${model}`, apiKey, async (open): Promise<Outcome> => {
    const info = getLiveModelInfo(model);
    if (!info || info.toolCallEndsTurnEarly === null) {
      return { status: 'skipped', detail: `no tool-call ordering recorded for '${model}'` };
    }
    const session = await open({ model, config: canaryToolConfig(model), apiVersion: options.apiVersion });
    const since = session.mark();
    session.sendText(BUILTIN_PROBE.prompt);
    const callEvent = await session.waitFor(
      (e) => e.type === 'toolCall' && e.calls.some((c) => c.name === BUILTIN_PROBE.expectTool),
      timeoutMs,
      { since, description: 'the probe tool call' },
    );
    const callIndex = session.trace.indexOf(callEvent);
    const call = (callEvent as { calls: LiveToolCall[] }).calls.find((c) => c.name === BUILTIN_PROBE.expectTool)!;
    // A tool that takes a moment, as a real one does.
    await new Promise((r) => setTimeout(r, 500));
    const responded = session.mark();
    session.respondToTool(call, BUILTIN_PROBE.result ?? 'ok');
    const replyAudio = await session.waitFor((e) => e.type === 'audio', timeoutMs, {
      since: responded,
      description: 'the spoken reply to the tool result',
    });
    const replyIndex = session.trace.indexOf(replyAudio);
    await session.waitForType('turnComplete', timeoutMs, { since: replyIndex });
    // Give a trailing interactionStatus a moment to arrive.
    await new Promise((r) => setTimeout(r, 300));

    const earlyTurnComplete = session.trace
      .slice(callIndex, replyIndex)
      .some((e) => e.type === 'turnComplete');
    const asyncCall = !call.id.startsWith('fc_');
    const statuses = session.events('interactionStatus', since).map((e) => e.status);
    const order = session.trace
      .slice(since)
      .filter((e) => ['audio', 'toolCall', 'sentToolResponse', 'generationComplete', 'turnComplete', 'interactionStatus'].includes(e.type))
      .map((e) => (e.type === 'interactionStatus' ? `status:${e.status}` : e.type === 'sentToolResponse' ? '<toolResponse>' : e.type))
      .filter((tag, i, all) => tag !== all[i - 1])
      .join(' > ');
    const metrics = {
      turnCompleteBetweenCallAndReply: earlyTurnComplete,
      asynchronousCall: asyncCall,
      interactionStatus: statuses.join(',') || 'none',
      spokeBeforeCall: session.trace.slice(since, callIndex).some((e) => e.type === 'audio'),
      order,
    };

    const changed: string[] = [];
    if (earlyTurnComplete !== info.toolCallEndsTurnEarly) {
      changed.push(
        `registry says a turnComplete ${info.toolCallEndsTurnEarly ? 'arrives' : 'does not arrive'} between the toolCall and the reply, but it ${earlyTurnComplete ? 'did' : 'did not'}`,
      );
    }
    const expectAsync = info.toolExecution === 'non-blocking-default' || info.toolExecution === 'non-blocking-only';
    if (info.toolExecution !== 'unverified' && asyncCall !== expectAsync) {
      changed.push(`registry says calls are ${expectAsync ? 'asynchronous' : 'blocking'}, but the call id was '${call.id.split('_')[0]}_…'`);
    }
    const expectStatus = info.idleSignal === 'interactionStatus';
    if (info.idleSignal !== 'unverified' && statuses.length > 0 !== expectStatus) {
      changed.push(`registry says the model ${expectStatus ? 'reports' : 'does not report'} interactionStatus, but it ${statuses.length ? 'did' : 'did not'}`);
    }
    if (expectStatus && statuses.length > 0 && statuses[statuses.length - 1] !== 'IDLE') {
      changed.push(`the last interactionStatus was '${statuses[statuses.length - 1]}', not IDLE, after the reply's turnComplete`);
    }
    if (changed.length) {
      return {
        status: 'contract-changed',
        detail: `PROVIDER CONTRACT CHANGED for ${model} tool-call ordering. ${changed.join('; ')}. Observed: ${order}. Update src/services/liveModels.ts and re-record the replay traces (scripts/capture-live-traces.mjs).`,
        metrics,
      };
    }
    return { status: 'pass', detail: `tool-call ordering matches the registry: ${order}`, metrics };
  });
}

/**
 * Canary: on a model whose calls are asynchronous by default, a tool response
 * sent with `scheduling: SILENT` is NOT followed by speech. `useSession`
 * relies on this to stop the model adding "The session has ended." after its
 * goodbye when it calls `endSession`.
 */
export function canarySilentToolResponse(
  apiKey: string,
  model: string,
  options: { apiVersion?: string; quietMs?: number; timeoutMs?: number } = {},
): Promise<LiveCheckResult> {
  const quietMs = options.quietMs ?? 4_000;
  return runCheck(`silent-tool-response:${model}`, apiKey, async (open): Promise<Outcome> => {
    const info = getLiveModelInfo(model);
    if (info?.toolExecution !== 'non-blocking-default') {
      return { status: 'skipped', detail: `useSession only sends scheduling SILENT to models with asynchronous-by-default calls; '${model}' is not one` };
    }
    const session = await open({ model, config: canaryToolConfig(model), apiVersion: options.apiVersion });
    const since = session.mark();
    session.sendText(BUILTIN_PROBE.prompt);
    const callEvent = await session.waitFor(
      (e) => e.type === 'toolCall' && e.calls.some((c) => c.name === BUILTIN_PROBE.expectTool),
      options.timeoutMs ?? 30_000,
      { since, description: 'the probe tool call' },
    );
    const call = (callEvent as { calls: LiveToolCall[] }).calls.find((c) => c.name === BUILTIN_PROBE.expectTool)!;
    const responded = session.mark();
    session.respondToTool(call, BUILTIN_PROBE.result ?? 'ok', { scheduling: FunctionResponseScheduling.SILENT });
    await new Promise((r) => setTimeout(r, quietMs));
    if (session.closed) {
      return {
        status: 'contract-changed',
        detail: `PROVIDER CONTRACT CHANGED for ${model}: a tool response with scheduling SILENT closed the session (${session.closed.code ?? 'no code'} "${session.closed.reason}"). useSession sends this when the bot calls endSession after saying goodbye.`,
        metrics: { closeCode: session.closed.code ?? 'none' },
      };
    }
    const audioAfter = session.audioBytes(responded);
    const metrics = { quietMs, audioSecondsAfterResponse: Number((audioAfter / 48_000).toFixed(2)), said: clip(session.outputText(responded), 60) };
    if (audioAfter > 0) {
      return {
        status: 'contract-changed',
        detail: `PROVIDER CONTRACT CHANGED for ${model}: the model spoke ("${clip(session.outputText(responded), 60)}") after a tool response sent with scheduling SILENT. useSession relies on SILENT to keep the model quiet after its goodbye.`,
        metrics,
      };
    }
    return { status: 'pass', detail: `no speech in the ${quietMs} ms after a SILENT tool response`, metrics };
  });
}

// ---------------------------------------------------------------------------
// (11) Model listed
// ---------------------------------------------------------------------------

async function listBidiModels(apiKey: string): Promise<string[]> {
  const ai = new GoogleGenAI({ apiKey });
  const pager = await ai.models.list({ config: { pageSize: 200 } });
  const ids: string[] = [];
  for await (const model of pager) {
    if (model.name && (model.supportedActions ?? []).includes('bidiGenerateContent')) {
      ids.push(model.name.replace(/^models\//, ''));
    }
  }
  return ids;
}

/** The model appears in `models.list` and supports `bidiGenerateContent`. */
export function checkModelListed(apiKey: string, model: string): Promise<LiveCheckResult> {
  return runCheck('model-listed', apiKey, async () => {
    const bidi = await listBidiModels(apiKey);
    const id = model.replace(/^models\//, '');
    const info = getLiveModelInfo(id);
    const metrics = { bidiModelsListed: bidi.length, registryStatus: info?.status ?? 'unknown' };
    if (!bidi.includes(id)) {
      return {
        status: 'fail',
        detail: `'${id}' is not listed with bidiGenerateContent support (listed: ${bidi.join(', ')})`,
        metrics,
      };
    }
    return { status: 'pass', detail: `'${id}' is listed with bidiGenerateContent`, metrics };
  });
}

/**
 * Live-capable ids that are not dialogue models or are aliases of registry
 * entries; the freshness canary ignores them.
 */
const NON_DIALOGUE_LIVE_MODELS: readonly RegExp[] = [
  /transcribe/,
  /translate/,
  /robotics/,
  /native-audio-latest$/,
  /native-audio-preview-09-2025$/,
];

/**
 * Canary: is a Live model listed that the registry has never heard of? A
 * `warn` here usually means the provider shipped a newer Live model and
 * `DEFAULT_LIVE_MODEL` deserves a look.
 */
export function canaryRegistryFreshness(apiKey: string): Promise<LiveCheckResult> {
  return runCheck('registry-freshness', apiKey, async () => {
    const bidi = await listBidiModels(apiKey);
    const unknown = bidi.filter(
      (id) => !getLiveModelInfo(id) && !NON_DIALOGUE_LIVE_MODELS.some((re) => re.test(id)),
    );
    const gone = Object.values(LIVE_MODELS)
      .filter((m) => m.status !== 'shutdown' && !bidi.includes(m.id))
      .map((m) => m.id);
    const metrics = { bidiModelsListed: bidi.length, unknown: unknown.join(','), noLongerListed: gone.join(',') };
    if (unknown.length || gone.length) {
      return {
        status: 'warn',
        detail:
          (unknown.length ? `Live models the registry does not know: ${unknown.join(', ')}. ` : '') +
          (gone.length ? `Registry models no longer listed: ${gone.join(', ')}. ` : '') +
          'Review src/services/liveModels.ts against the provider docs.',
        metrics,
      };
    }
    return { status: 'pass', detail: 'every listed dialogue Live model is in the registry', metrics };
  });
}

// ---------------------------------------------------------------------------
// (12) Ephemeral-token path
// ---------------------------------------------------------------------------

export interface EphemeralTokenOptions {
  /** API version the broker mints on. Default `'v1alpha'`, as the README shows. */
  mintApiVersion?: string;
  /** API version the client connects on. Default: the target's, else `LIVE_API_VERSION`. */
  connectApiVersion?: string;
  timeoutMs?: number;
}

/**
 * Mint a single-use ephemeral Live token the way a broker does. Server-side
 * only: this needs the long-lived key.
 */
export async function mintEphemeralLiveToken(
  apiKey: string,
  options: { apiVersion?: string; ttlMs?: number; newSessionWindowMs?: number } = {},
): Promise<{ token: string; expireTime: string }> {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: options.apiVersion ?? 'v1alpha' } });
  const now = Date.now();
  const expireTime = new Date(now + (options.ttlMs ?? 30 * 60_000)).toISOString();
  const token = await ai.authTokens.create({
    config: {
      uses: 1,
      expireTime,
      newSessionExpireTime: new Date(now + (options.newSessionWindowMs ?? 60_000)).toISOString(),
    },
  });
  if (!token?.name) throw new Error('authTokens.create returned no token');
  return { token: token.name, expireTime };
}

/**
 * The production auth path: a broker mints an ephemeral token with
 * `authTokens.create`, and the client opens the Live session with that token
 * on the hook's pinned API version. Setup must be accepted and a turn must run.
 */
export function checkEphemeralToken(target: LiveCheckTarget, options: EphemeralTokenOptions = {}): Promise<LiveCheckResult> {
  const mintVersion = options.mintApiVersion ?? 'v1alpha';
  const connectVersion = options.connectApiVersion ?? target.apiVersion ?? LIVE_API_VERSION;
  return runCheck(`ephemeral-token:mint-${mintVersion}/connect-${connectVersion}`, target.apiKey, async (open) => {
    const mintStarted = Date.now();
    const { token } = await mintEphemeralLiveToken(target.apiKey, { apiVersion: mintVersion });
    const mintMs = Date.now() - mintStarted;
    const session = await open({ ephemeralToken: token, apiVersion: connectVersion });
    const since = session.mark();
    session.sendText('[Connection test. Reply with one short sentence.]');
    await session.waitFor((e) => e.type === 'turnComplete' || e.type === 'toolCall', options.timeoutMs ?? 30_000, { since });
    return {
      status: 'pass',
      detail: `token minted on ${mintVersion}, session opened on ${connectVersion}, first turn ran`,
      metrics: { mintMs, mintApiVersion: mintVersion, connectApiVersion: connectVersion },
    };
  }, target);
}

// ---------------------------------------------------------------------------
// (13) Latency
// ---------------------------------------------------------------------------

export interface LatencyOptions {
  fixture?: SpeechFixtureId;
  /** Spoken turns to time. Default 3. */
  trials?: number;
  /**
   * Soft budget for the median, in ms: over it is a `warn`. Default 2000 ms
   * plus, under server VAD, the silence the server must wait out
   * (`silenceDurationMs`, or about 800 ms when unset).
   */
  softBudgetMs?: number;
  /** Hard cap for the median: over it is a `fail`. Default soft budget + 8000 ms. */
  hardCapMs?: number;
  timeoutMs?: number;
}

/**
 * Latency from the end of the user's speech to the first byte of bot audio,
 * under the config's own turn-taking mode. Under server VAD this includes the
 * end-of-speech silence the server waits out. Reports min / median / max.
 */
export function checkLatency(target: LiveCheckTarget, options: LatencyOptions = {}): Promise<LiveCheckResult> {
  return runCheck('latency', target.apiKey, async (open) => {
    const manual = isManualTurnControl(target.config);
    const waited = manual ? 0 : configuredSilenceMs(target.config) ?? 800;
    const soft = options.softBudgetMs ?? 2_000 + waited;
    const hard = options.hardCapMs ?? soft + 8_000;
    const trials = Math.max(1, options.trials ?? 3);
    const fixture = loadSpeechFixture(options.fixture ?? 'question-capital');
    const session = await open();
    const samples: number[] = [];
    for (let i = 0; i < trials; i++) {
      const turn = await speakTurn(session, target.config, fixture.pcm, options.timeoutMs ?? waited + 30_000);
      if (turn.firstAudioT === undefined) {
        return { status: 'fail', detail: `trial ${i + 1}: the bot did not answer`, metrics: { trials: i } };
      }
      samples.push(ms(turn.speechEndT, turn.firstAudioT));
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor((sorted.length - 1) / 2)];
    const metrics = {
      medianMs: median,
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1],
      trials,
      softBudgetMs: soft,
      hardCapMs: hard,
      turnTaking: manual ? 'manual' : `server-vad(silence=${configuredSilenceMs(target.config) ?? 'default'})`,
    };
    const summary = `end of speech to first bot audio: median ${median} ms (min ${sorted[0]}, max ${sorted[sorted.length - 1]}, n=${trials})`;
    if (median > hard) return { status: 'fail', detail: `${summary}, over the ${hard} ms hard cap`, metrics };
    if (median > soft) return { status: 'warn', detail: `${summary}, over the ${soft} ms soft budget`, metrics };
    return { status: 'pass', detail: summary, metrics };
  }, target);
}
