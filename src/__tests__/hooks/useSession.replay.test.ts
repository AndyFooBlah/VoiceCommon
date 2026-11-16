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
 * Replays REAL Gemini Live event traces through useSession's message handler.
 *
 * The traces in src/__tests__/fixtures/live-traces/ were recorded from the
 * live API by scripts/capture-live-traces.mjs (synthetic content, audio
 * reduced to byte counts, no credentials). Each is fed to the hook at its
 * recorded timing on a virtual clock that also drives a fake playback
 * AudioContext, so what the hook persists, renders, sends, plays and records
 * can be checked against what the provider really does, offline.
 *
 * Why this exists: the Live models order events differently around tool
 * calls. On gemini-3.8-live a `turnComplete` arrives right after a
 * `toolCall`, before the spoken reply to the tool result; on the 3.1 preview
 * there is one `turnComplete`, after the reply; extended-thinking speaks a
 * filler sentence, sends `turnComplete`, and only then issues the call.
 * The hook must keep a correct record under all three.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useSession } from '../../hooks/useSession';
import { LIVE_MODELS } from '../../services/liveModels';
import {
  createFakePlayback,
  listTraceFixtures,
  loadTrace,
  replayTrace,
} from './replayHarness';
import type { LiveTraceFixture, ReplayOptions, ReplayResult, TraceClientEvent } from './replayHarness';

// ---------------------------------------------------------------------------
// Mocks (the hook's collaborators; the hook itself is real)
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  callbacks: { current: {} as Record<string, (...a: any[]) => any> },
  liveSession: { close: vi.fn(), sendRealtimeInput: vi.fn(), sendToolResponse: vi.fn() },
  playback: { current: null as any },
  mixer: { start: vi.fn(), stop: vi.fn(), flush: vi.fn() },
  worklet: { current: null as any },
  storage: {
    createSession: vi.fn(),
    finalizeSession: vi.fn(),
    archiveAudioToGCS: vi.fn(),
    syncTranscriptToFirestore: vi.fn(),
  },
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return {
    ...actual,
    GoogleGenAI: vi.fn(function () {
      return {
        live: {
          connect: vi.fn(async (args: any) => {
            h.callbacks.current = args.callbacks;
            return h.liveSession;
          }),
        },
      };
    }),
  };
});
vi.mock('../../hooks/useAudioMixer', () => ({
  useAudioMixer: () => ({
    get stream() { return { getTracks: () => [], getAudioTracks: () => [] }; },
    get playbackContext() { return h.playback.current.context; },
    get inputContext() {
      return {
        sampleRate: 16000,
        createMediaStreamSource: () => ({ connect: () => undefined, disconnect: () => undefined }),
        audioWorklet: { addModule: async () => undefined },
      };
    },
    get mixedDest() { return h.playback.current.recorderDest; },
    start: h.mixer.start,
    stop: h.mixer.stop,
    flush: h.mixer.flush,
  }),
}));
vi.mock('../../services/storage', () => h.storage);
vi.mock('../../services/config', () => ({
  getConfig: vi.fn(() => ({ tokenProvider: vi.fn(), firebase: {} })),
  initializeVoiceCommon: vi.fn(),
  isDebugEnabled: vi.fn(() => false),
  mintLiveToken: vi.fn().mockResolvedValue({ token: 'test-ephemeral-token', expireTime: '2099-01-01T00:00:00.000Z' }),
}));
vi.stubGlobal(
  'AudioWorkletNode',
  vi.fn().mockImplementation(function (this: any) {
    this.port = { onmessage: null };
    this.connect = () => undefined;
    this.disconnect = () => undefined;
    h.worklet.current = this;
  }),
);
vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  h.storage.createSession.mockResolvedValue('session-1');
  h.storage.finalizeSession.mockResolvedValue(undefined);
  h.storage.archiveAudioToGCS.mockResolvedValue('https://example.test/a.webm');
  h.storage.syncTranscriptToFirestore.mockResolvedValue(undefined);
  h.mixer.start.mockResolvedValue(undefined);
  h.mixer.stop.mockResolvedValue(new Blob(['a']));
  h.mixer.flush.mockReturnValue(null);
  h.worklet.current = null;
  h.playback.current = createFakePlayback();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LIVE = 'gemini-3.8-live';
const EXTENDED = 'gemini-3.8-live-extended-thinking';
const LEGACY = 'gemini-3.1-flash-live-preview';

function replay(scenario: string, model: string, options: ReplayOptions = {}): Promise<ReplayResult> {
  return replayTrace(
    loadTrace(scenario, model),
    {
      useSession,
      callbacks: h.callbacks,
      liveSession: h.liveSession,
      playback: h.playback.current,
      syncTranscript: h.storage.syncTranscriptToFirestore,
      mixer: h.mixer,
      worklet: h.worklet,
    },
    options,
  );
}

const squash = (text: string) => text.replace(/\s+/g, '');

/** Everything the bot said in the trace, per the provider's own output transcription. */
function spokenInTrace(trace: LiveTraceFixture, untilMs = Infinity): string {
  return trace.events
    .filter((e) => e.from === 'server' && e.t <= untilMs)
    .map((e: any) => e.message.serverContent?.outputTranscription?.text ?? '')
    .join('');
}

/** Server events of the trace as short tags, for asserting on the provider's ordering. */
function serverOrder(trace: LiveTraceFixture): string[] {
  const tags: string[] = [];
  const push = (tag: string) => {
    if (tags[tags.length - 1] !== tag) tags.push(tag);
  };
  for (const e of trace.events) {
    if (e.from === 'client') {
      if (e.kind === 'toolResponded') push('<toolResponse>');
      continue;
    }
    const m = e.message;
    if (m.serverContent?.modelTurn?.parts?.some((p: any) => p.inlineData)) push('audio');
    if (m.toolCallCancellation) push('toolCallCancellation');
    if (m.serverContent?.interrupted) push('interrupted');
    if (m.toolCall) push('toolCall');
    if (m.serverContent?.generationComplete) push('generationComplete');
    if (m.serverContent?.turnComplete) push('turnComplete');
    const status = m.interactionStatus ?? m.serverContent?.interactionStatus;
    if (status) push(`status:${status}`);
  }
  return tags;
}

function clientEvent(trace: LiveTraceFixture, kind: string): TraceClientEvent {
  const event = trace.events.find((e) => e.from === 'client' && e.kind === kind);
  if (!event) throw new Error(`trace has no client event '${kind}'`);
  return event as TraceClientEvent;
}

/** Invariants that must hold for every replay, whatever the scenario. */
function expectSoundRecord(result: ReplayResult): void {
  expect(result.errors).toEqual([]);
  // Transcript indices are 0..n-1 in order: nothing reordered, nothing skipped.
  expect(result.transcript.map((e) => e.messageIndex)).toEqual(result.transcript.map((_, i) => i));
  // Entries were persisted in time order.
  const times = result.transcript.map((e) => e.atMs);
  expect(times).toEqual([...times].sort((a, b) => a - b));
  // No empty and no doubled entries.
  for (const entry of result.transcript) expect(entry.text.trim()).not.toBe('');
  const botTexts = result.transcript.filter((e) => e.role === 'bot').map((e) => e.text);
  expect(new Set(botTexts).size).toBe(botTexts.length);
  // What is rendered matches what is persisted, turn for turn.
  expect(result.messages.map((m) => `${m.role}:${squash(m.text)}`)).toEqual(
    result.transcript.map((e) => `${e.role}:${squash(e.text)}`),
  );
  // Every chunk of bot audio went to the speakers AND to the recorder.
  expect(result.everyChunkReachedRecorder).toBe(true);
}

/** onBotSpeaking must be true exactly while bot audio is sounding. */
function expectSpeakingTracksAudio(result: ReplayResult): void {
  const { chunks } = h.playback.current as ReturnType<typeof createFakePlayback>;
  const base = result.audioDrainedAtMs - h.playback.current.drainedAtMs();
  // Strictly alternating, starting with "speaking".
  result.botSpeaking.forEach((s, i) => expect(s.speaking).toBe(i % 2 === 0));
  for (const change of result.botSpeaking.filter((s) => !s.speaking)) {
    // Never reported silent while a chunk is still sounding.
    const sounding = chunks.filter(
      (c) => base + c.startAt * 1000 + 1 < change.atMs && change.atMs < base + c.endAt * 1000 - 1,
    );
    expect(sounding).toEqual([]);
  }
  if (chunks.length > 0) {
    expect(result.botSpeaking.length % 2).toBe(0); // ends silent
    const last = result.botSpeaking[result.botSpeaking.length - 1];
    expect(Math.abs(last.atMs - result.audioDrainedAtMs)).toBeLessThanOrEqual(60);
  }
}

// ---------------------------------------------------------------------------
// The fixtures themselves
// ---------------------------------------------------------------------------

describe('recorded live traces', () => {
  const files = listTraceFixtures();

  it('cover the three models and every scenario the replay tests use', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        `tool-reply.${LIVE}.json`,
        `tool-reply.${LEGACY}.json`,
        `tool-reply.${EXTENDED}.json`,
        `filler-tool-reply.${LIVE}.json`,
        `filler-tool-reply.${LEGACY}.json`,
        `filler-fast-tool-reply.${LIVE}.json`,
        `filler-fast-tool-reply.${LEGACY}.json`,
        `goodbye-end-session.${LIVE}.json`,
        `goodbye-end-session-silent.${LIVE}.json`,
        `goodbye-end-session.${LEGACY}.json`,
        `goodbye-end-session.${EXTENDED}.json`,
        `barge-in-during-tool.${LIVE}.json`,
        `barge-in-during-tool.${LEGACY}.json`,
        `barge-in-over-filler-during-tool.${LIVE}.json`,
        `greeting.${LIVE}.json`,
        `greeting.${LEGACY}.json`,
        `greeting.${EXTENDED}.json`,
      ]),
    );
  });

  it.each(files)('%s holds no credential, no audio and no resumption handle', (file) => {
    const [scenario, ...rest] = file.replace(/\.json$/, '').split('.');
    const trace = loadTrace(scenario, rest.join('.'));
    const text = JSON.stringify(trace);
    expect(text).not.toMatch(/AIza[A-Za-z0-9_-]{20,}/);
    expect(text).not.toMatch(/auth_tokens\//);
    // Audio is a byte count only.
    expect(text).not.toMatch(/"data"\s*:/);
    // Handles are masked.
    for (const m of text.matchAll(/"newHandle":"([^"]*)"/g)) expect(m[1]).toBe('HANDLE-MASKED');
    expect(trace.meta.model in LIVE_MODELS).toBe(true);
    expect(trace.meta.generator).toBe('scripts/capture-live-traces.mjs');
    expect(trace.events.length).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------
// What the provider does (asserted on the recordings, no hook involved)
// ---------------------------------------------------------------------------

describe('provider event order around a tool call, as recorded', () => {
  it(`${LIVE}: the calling turn completes BEFORE the tool response; the reply is a further turn`, () => {
    expect(serverOrder(loadTrace('tool-reply', LIVE))).toEqual([
      'toolCall', 'generationComplete', 'turnComplete', '<toolResponse>', 'audio', 'generationComplete', 'turnComplete',
    ]);
  });

  it(`${LEGACY}: one turnComplete, after the reply`, () => {
    expect(serverOrder(loadTrace('tool-reply', LEGACY))).toEqual([
      'toolCall', '<toolResponse>', 'audio', 'generationComplete', 'turnComplete',
    ]);
  });

  it(`${EXTENDED}: filler speech and turnComplete come before the call; interactionStatus says when it is really done`, () => {
    expect(serverOrder(loadTrace('tool-reply', EXTENDED))).toEqual([
      'audio', 'generationComplete', 'turnComplete', 'status:IN_PROGRESS',
      'toolCall', '<toolResponse>', 'audio', 'generationComplete', 'turnComplete', 'status:IDLE',
    ]);
  });

  it(`${LIVE}: an ordinary answer to endSession makes the model speak again; a SILENT one does not`, () => {
    const ordinary = serverOrder(loadTrace('goodbye-end-session', LIVE));
    const silent = serverOrder(loadTrace('goodbye-end-session-silent', LIVE));
    const afterResponse = (order: string[]) => order.slice(order.indexOf('<toolResponse>') + 1);
    expect(afterResponse(ordinary)).toContain('audio');
    expect(afterResponse(silent)).not.toContain('audio');
  });

  it('the server cancels a pending call when bot speech is interrupted, on both generations', () => {
    expect(serverOrder(loadTrace('barge-in-during-tool', LEGACY))).toEqual(
      expect.arrayContaining(['toolCallCancellation', 'interrupted']),
    );
    expect(serverOrder(loadTrace('barge-in-over-filler-during-tool', LIVE))).toEqual(
      expect.arrayContaining(['toolCallCancellation', 'interrupted']),
    );
  });

  it(`${LIVE}: a call stays open when the user speaks while the bot is silent`, () => {
    const order = serverOrder(loadTrace('barge-in-during-tool', LIVE));
    expect(order).not.toContain('toolCallCancellation');
    expect(order).not.toContain('interrupted');
  });
});

// ---------------------------------------------------------------------------
// Transcript: one coherent entry per spoken reply, tool entries in order
// ---------------------------------------------------------------------------

describe('transcript across a tool call', () => {
  it.each([LIVE, LEGACY])('%s: tool entry, then ONE bot entry holding the whole reply', async (model) => {
    const trace = loadTrace('tool-reply', model);
    const result = await replay('tool-reply', model);
    expectSoundRecord(result);

    expect(result.transcript.map((e) => e.role)).toEqual(['tool', 'bot']);
    const [tool, bot] = result.transcript;
    expect(tool).toMatchObject({ toolName: 'getWeather', toolResult: 'It is 18 degrees Celsius and sunny in Paris.' });
    // Nothing dropped, nothing duplicated: the entry is exactly what was spoken.
    expect(squash(bot.text)).toBe(squash(spokenInTrace(trace)));
    expect(bot.text).toMatch(/18 degrees/);
    // The tool entry is stamped when the tool finished; the reply when its turn completed.
    expect(tool.atMs).toBe(clientEvent(trace, 'toolResponded').t);
    expect(bot.atMs).toBeGreaterThan(tool.atMs);

    // Exactly one answer to the call, with the call's own id, when the tool finished.
    expect(result.toolResponses).toHaveLength(1);
    expect(result.toolResponses[0].atMs).toBe(clientEvent(trace, 'toolResponded').t);
    expect(result.toolResponses[0].payload.functionResponses).toEqual([
      { id: clientEvent(trace, 'toolResponded').id, name: 'getWeather', response: { result: 'It is 18 degrees Celsius and sunny in Paris.' } },
    ]);
  });

  it(`${LIVE}: the early turnComplete after the toolCall adds no entry and disturbs nothing`, async () => {
    const trace = loadTrace('tool-reply', LIVE);
    const toolResponded = clientEvent(trace, 'toolResponded').t;
    // Stop just before the tool finishes: the early turnComplete has arrived.
    const result = await replay('tool-reply', LIVE, { untilMs: toolResponded - 1, tailMs: 0 });
    expect(result.transcript).toEqual([]);
    expect(result.messages).toEqual([]);
    expect(result.botSpeaking).toEqual([]);
    expect(result.micOpen).toEqual([{ open: true, atMs: expect.any(Number) }]);
    expect(result.toolCallsSeen).toHaveLength(1);
    expect(result.toolResponses).toEqual([]);
  });

  it.each([
    ['filler-tool-reply', LIVE],
    ['filler-tool-reply', LEGACY],
    ['filler-fast-tool-reply', LIVE],
    ['filler-fast-tool-reply', LEGACY],
  ])('%s on %s: what was said before the call, then the tool, then the answer', async (scenario, model) => {
    const trace = loadTrace(scenario, model);
    const result = await replay(scenario, model);
    expectSoundRecord(result);

    // Three entries in the order things happened. Before 0.16.1 the 3.1
    // preview gave [tool, "One moment, let me check.It is 18 degrees…"] and a
    // fast tool on gemini-3.8-live gave [tool, filler, answer].
    expect(result.transcript.map((e) => e.role)).toEqual(['bot', 'tool', 'bot']);
    const [filler, tool, answer] = result.transcript;
    expect(filler.text).toBe('One moment, let me check.');
    expect(tool.toolName).toBe('getWeather');
    expect(answer.text).toMatch(/18 degrees/);
    expect(answer.text).not.toMatch(/One moment/);
    expect(squash(filler.text + answer.text)).toBe(squash(spokenInTrace(trace)));
    // The filler is persisted when the call is issued, not after the tool ran.
    expect(filler.atMs).toBe(clientEvent(trace, 'toolDispatched').t);
    expect(tool.atMs).toBe(clientEvent(trace, 'toolResponded').t);
    expect(result.toolResponses).toHaveLength(1);
  });

  it(`${EXTENDED}: the filler and the answer are two entries around the tool`, async () => {
    const trace = loadTrace('tool-reply', EXTENDED);
    const result = await replay('tool-reply', EXTENDED);
    expectSoundRecord(result);
    expect(result.transcript.map((e) => e.role)).toEqual(['bot', 'tool', 'bot']);
    expect(result.transcript[2].text).toMatch(/18 degrees/);
    expect(squash(result.transcript[0].text + result.transcript[2].text)).toBe(squash(spokenInTrace(trace)));
    expect(result.toolResponses).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Speaking state, greeting mute, recorder
// ---------------------------------------------------------------------------

describe('speaking state and recorder across every trace', () => {
  const cases = listTraceFixtures()
    .map((f) => f.replace(/\.json$/, ''))
    .map((f) => [f.slice(0, f.indexOf('.')), f.slice(f.indexOf('.') + 1)] as const)
    // Traces whose tail is the model reacting to the capture script's own
    // late tool response are replayed up to that point in their own tests.
    .filter(([scenario]) => !scenario.includes('late-response') && scenario !== 'barge-in-over-filler-during-tool');

  it.each(cases)('%s on %s: onBotSpeaking follows the audio; the recorder is never touched', async (scenario, model) => {
    const result = await replay(scenario, model);
    expect(result.errors).toEqual([]);
    expectSpeakingTracksAudio(result);
    expect(result.everyChunkReachedRecorder).toBe(true);
    // No trace event may stop, restart or flush the recorder.
    expect(result.recorderStopCalls).toBe(0);
    expect(result.recorderFlushCalls).toBe(0);
    expect(h.mixer.start).toHaveBeenCalledTimes(1);
    // Without a barge-in, nothing that was scheduled is cut off.
    if (!scenario.startsWith('barge-in')) expect(result.audioCutS).toBe(0);
  });

  it.each([LIVE, LEGACY, EXTENDED])(
    '%s: the greeting mute holds the microphone until the greeting has finished PLAYING',
    async (model) => {
      const result = await replay('greeting', model, {
        hookOptions: { autoGreetText: '[Session started. Please greet the user in one short sentence.]' },
      });
      expectSoundRecord(result);
      expect(result.transcript.map((e) => e.role)).toEqual(['bot']);
      // Closed from the start, opened exactly once, when the audio drained.
      // (The 3.8-live and 3.1 recordings open with the one-sample audio chunk
      // the provider sends at the start of most replies; before 0.16.1 the
      // hook took that chunk ending for the end of the greeting and opened
      // the microphone about 20 ms into it.)
      expect(result.micOpen.map((m) => m.open)).toEqual([false, true]);
      const opened = result.micOpen[1].atMs;
      expect(opened).toBeGreaterThanOrEqual(result.audioDrainedAtMs - 25);
      expect(opened).toBeLessThanOrEqual(result.audioDrainedAtMs + 100);
      expect(result.audioScheduledS).toBeGreaterThan(1);
    },
  );

  it.each([LIVE, LEGACY])('%s: with no greeting, the microphone stays open through a tool call', async (model) => {
    const result = await replay('filler-tool-reply', model);
    expect(result.micOpen).toEqual([{ open: true, atMs: expect.any(Number) }]);
  });
});

// ---------------------------------------------------------------------------
// Barge-in while a tool is pending
// ---------------------------------------------------------------------------

describe('barge-in while a tool is pending', () => {
  it(`${LEGACY}: the server cancels the call, so its result is NOT sent`, async () => {
    const result = await replay('barge-in-during-tool', LEGACY);
    expectSoundRecord(result);
    expect(result.toolCallsSeen).toHaveLength(1);
    expect(result.toolResponses).toEqual([]);
    // The record still shows the user's new question, its answer, and the tool that ran.
    expect(result.transcript.map((e) => e.role)).toEqual(['user', 'bot', 'tool']);
    expect(result.transcript[1].text).toMatch(/Paris/);
  });

  it(`${LIVE}: the bot was silent, the server kept the call open, so its result IS sent`, async () => {
    const trace = loadTrace('barge-in-during-tool', LIVE);
    const result = await replay('barge-in-during-tool', LIVE);
    expectSoundRecord(result);
    expect(result.toolResponses).toHaveLength(1);
    expect(result.toolResponses[0].payload.functionResponses[0].id).toBe(clientEvent(trace, 'toolDispatched').id);
    expect(result.transcript.map((e) => e.role)).toEqual(['user', 'bot', 'tool']);
  });

  it(`${LIVE}: the user talked over the filler, the server cancelled the call, so its result is NOT sent`, async () => {
    const trace = loadTrace('barge-in-over-filler-during-tool', LIVE);
    // Replay up to the moment the tool finishes. (The recording goes on to
    // show the model speaking the stale result, because the capture script
    // sent it: that is the behaviour the hook must not cause.)
    const finishes = clientEvent(trace, 'toolResponded').t;
    const result = await replay('barge-in-over-filler-during-tool', LIVE, { untilMs: finishes, tailMs: 500 });
    expect(result.errors).toEqual([]);
    expect(result.toolCallsSeen).toHaveLength(1);
    expect(result.toolResponses).toEqual([]);
    expect(result.transcript.map((e) => e.role)).toEqual(['bot', 'user', 'bot', 'tool']);
    expect(result.transcript[0].text).toMatch(/^One moment please/);
    expect(result.transcript[2].text).toMatch(/Paris/);
    // The barge-in cut the filler's audio, and the bot was reported silent at once.
    expect(result.audioCutS).toBeGreaterThan(0);
    const cancelledAt = trace.events.find((e: any) => e.from === 'server' && e.message.toolCallCancellation)!.t;
    expect(result.botSpeaking[1]).toEqual({ speaking: false, atMs: cancelledAt });

    // And the stale result, had it been sent, is spoken: the recording shows it.
    expect(spokenInTrace(trace).slice(spokenInTrace(trace, finishes).length)).toMatch(/18 degrees/);
  });
});

// ---------------------------------------------------------------------------
// endSession: the session ends only after the goodbye has finished playing
// ---------------------------------------------------------------------------

describe('endSession', () => {
  const cases: Array<[scenario: string, model: string, scheduling: string | undefined]> = [
    ['goodbye-end-session-silent', LIVE, 'SILENT'],
    ['goodbye-end-session', LEGACY, undefined],
    ['goodbye-end-session', EXTENDED, undefined],
  ];

  it.each(cases)(
    '%s on %s: an app that stops straight away still hears and records the whole goodbye',
    async (scenario, model, scheduling) => {
      const trace = loadTrace(scenario, model);
      // CarBot and weatherbot-app call stopSession() directly from onSessionEndRequest.
      const result = await replay(scenario, model, { stopOnEndRequest: true });
      expect(result.errors).toEqual([]);

      // The hook answers the call itself, at once, exactly once.
      const called = trace.events.find((e: any) => e.from === 'server' && e.message.toolCall)!;
      expect(result.toolResponses).toHaveLength(1);
      expect(result.toolResponses[0].atMs).toBe(called.t);
      const response = result.toolResponses[0].payload.functionResponses[0];
      expect(response).toMatchObject({ name: 'endSession', response: { result: 'ok' } });
      expect(response.scheduling).toBe(scheduling);
      expect(result.toolCallsSeen).toEqual([]); // never dispatched to the app's onToolCall

      // The app was asked to end the session only after the audio had drained...
      expect(result.endRequestedAtMs).not.toBeNull();
      expect(result.endRequestedAtMs!).toBeGreaterThanOrEqual(result.audioDrainedAtMs);
      expect(result.endRequestedAtMs!).toBeLessThanOrEqual(result.audioDrainedAtMs + 600);
      // ...so stopping at that moment cut nothing off. (Before 0.16.1 the
      // request came with the tool call and 1.3 to 1.8 s of goodbye was lost.)
      expect(result.stoppedAtMs).toBe(result.endRequestedAtMs);
      expect(result.audioCutS).toBe(0);
      expect(result.audioScheduledS).toBeGreaterThan(1.5);
      expect(result.recorderStopCalls).toBe(1);

      // The goodbye is in the record, after the user's sign-off.
      expect(result.transcript[0]).toMatchObject({ role: 'user' });
      expect(result.transcript[0].text).toMatch(/[Gg]oodbye/);
      expect(result.transcript.slice(1).every((e) => e.role === 'bot')).toBe(true);
      expect(squash(result.transcript.slice(1).map((e) => e.text).join(''))).toBe(squash(spokenInTrace(trace)));
    },
  );

  it(`${EXTENDED}: waits for interactionStatus IDLE, not just for the first goodbye`, async () => {
    const trace = loadTrace('goodbye-end-session', EXTENDED);
    const result = await replay('goodbye-end-session', EXTENDED, { stopOnEndRequest: true });
    const idleAt = trace.events.find((e: any) => e.from === 'server' && e.message.serverContent?.interactionStatus === 'IDLE')!.t;
    expect(result.interactionStatuses).toEqual([
      { status: 'IN_PROGRESS', atMs: expect.any(Number) },
      { status: 'IDLE', atMs: idleAt },
    ]);
    expect(result.endRequestedAtMs!).toBeGreaterThanOrEqual(idleAt);
    // Both closing utterances were heard and recorded as separate entries.
    expect(result.transcript.filter((e) => e.role === 'bot')).toHaveLength(2);
  });

  it(`${LIVE}: answers with SILENT because the goodbye was already spoken`, async () => {
    // This recording was made with an ordinary response, so the model goes
    // on to say "The session has ended." The hook asks for SILENT instead.
    const result = await replay('goodbye-end-session', LIVE);
    expect(result.toolResponses[0].payload.functionResponses[0].scheduling).toBe('SILENT');
  });

  it('an app that does not stop is asked exactly once', async () => {
    const result = await replay('goodbye-end-session-silent', LIVE, { tailMs: 15_000 });
    expect(result.endRequestedAtMs).not.toBeNull();
    expect(result.stoppedAtMs).toBeNull();
    expect(result.recorderStopCalls).toBe(0);
    expect(result.toolResponses).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// interactionStatus
// ---------------------------------------------------------------------------

describe('interactionStatus', () => {
  it(`${EXTENDED}: reported to the app; IN_PROGRESS spans the filler's turnComplete and the tool`, async () => {
    const trace = loadTrace('tool-reply', EXTENDED);
    const result = await replay('tool-reply', EXTENDED);
    expect(result.interactionStatuses.map((s) => s.status)).toEqual(['IN_PROGRESS', 'IDLE']);
    const [inProgress, idle] = result.interactionStatuses;
    // Still IN_PROGRESS when the tool was called and when it was answered.
    expect(inProgress.atMs).toBeLessThan(clientEvent(trace, 'toolDispatched').t);
    expect(idle.atMs).toBeGreaterThan(clientEvent(trace, 'toolResponded').t);
    // IDLE arrives with the final turnComplete, as the answer finishes playing.
    expect(Math.abs(idle.atMs - result.audioDrainedAtMs)).toBeLessThan(400);
  });

  it.each([LIVE, LEGACY])('%s: never reports a status', async (model) => {
    const result = await replay('tool-reply', model);
    expect(result.interactionStatuses).toEqual([]);
  });

  it('the registry records which models signal idle through interactionStatus', () => {
    expect(LIVE_MODELS[EXTENDED].idleSignal).toBe('interactionStatus');
    expect(LIVE_MODELS[LIVE].idleSignal).toBe('turnComplete');
    expect(LIVE_MODELS[LEGACY].idleSignal).toBe('turnComplete');
  });
});
