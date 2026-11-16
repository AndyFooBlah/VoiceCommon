#!/usr/bin/env node
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
 * Record real Gemini Live event traces for the offline replay tests
 * (src/__tests__/hooks/useSession.replay.test.ts).
 *
 * Each scenario opens a real Live session with the config `useSession` would
 * send (via buildLiveConnectConfig), drives one short scripted exchange, and
 * writes every raw server message, with its arrival time, to
 * src/__tests__/fixtures/live-traces/<scenario>.<model>.json.
 *
 * What is and is not in a trace:
 *   - Content is synthetic: scripted prompts, the committed synthetic speech
 *     fixtures, canned tool results, and the model's replies to them.
 *   - Audio payloads are reduced to byte counts. No audio is stored.
 *   - Session-resumption handles are masked. No key or token is ever written:
 *     the key is read from the environment and only handed to the SDK.
 *
 * Run (after `npm run build:lib`, which this script imports from dist/):
 *   GEMINI_API_KEY=... node scripts/capture-live-traces.mjs            # all
 *   GEMINI_API_KEY=... node scripts/capture-live-traces.mjs tool-reply # one scenario
 *
 * The `greeting` recordings for gemini-3.8-live and the 3.1 preview were
 * re-recorded until they opened with the one-sample (2-byte) audio chunk the
 * provider sends at the start of most replies (13 of the first 19 recordings
 * had it), because that chunk is what the greeting-mute test is about.
 *
 * Re-recording replaces the fixtures with a fresh sample of provider
 * behaviour. Model wording varies run to run; the replay tests assert on
 * structure, not wording. If a re-recorded trace changes the ORDER of events,
 * that is a provider change: the live suite's tool-call-ordering canary
 * reports the same thing as "contract changed".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'src', '__tests__', 'fixtures', 'live-traces');
const kit = await import(pathToFileURL(path.join(ROOT, 'dist', 'testing.js')).href);

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error('Set GEMINI_API_KEY in the environment (it is never printed or stored).');
  process.exit(2);
}
const redact = kit.makeRedactor([key]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIVE = 'gemini-3.8-live';
const EXTENDED = 'gemini-3.8-live-extended-thinking';
const LEGACY = 'gemini-3.1-flash-live-preview';

const WEATHER_TOOL = {
  name: 'getWeather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'OBJECT',
    properties: { city: { type: 'STRING', description: 'City name, e.g. "Paris".' } },
    required: ['city'],
  },
};
const WEATHER_RESULT = 'It is 18 degrees Celsius and sunny in Paris.';

const BASE_INSTRUCTION =
  'You are a voice assistant in an automated test. Answer in one short sentence. ' +
  'For any question about the weather you must call the getWeather tool and then report its result.';

// The session-ending guidance VoiceCommon's own buildSessionInstruction gives.
const END_INSTRUCTION =
  'You are a helpful voice assistant. Keep answers to one short sentence.\n' +
  "ENDING THE SESSION:\n- When the user signals they are done (e.g. \"goodbye\", \"that's all\"), " +
  "say a brief closing word then call 'endSession'.\n- Do not call 'endSession' on a brief pause.";

/**
 * @typedef {{ name: string, models: string[], instruction: string,
 *   run: (ctx: { session: any, config: any, note: (kind: string, extra?: object) => void }) => Promise<void> }} Scenario
 */

/** Wait for the next toolCall naming `tool` after `since`. */
async function waitForCall(session, tool, since, timeoutMs = 30_000) {
  const event = await session.waitFor(
    (e) => e.type === 'toolCall' && e.calls.some((c) => c.name === tool),
    timeoutMs,
    { since, description: `a ${tool} call` },
  );
  return event.calls.find((c) => c.name === tool);
}

/** Wait until nothing has arrived for `quietMs` (or `maxMs` passes). */
async function waitForQuiet(session, quietMs, maxMs, streamSilence = false) {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const mark = session.mark();
    try {
      await session.waitFor(() => true, quietMs, { since: mark, streamSilence });
    } catch {
      return; // quiet (timed out) or closed
    }
    if (Date.now() > deadline) return;
  }
}

/** @type {Scenario[]} */
const SCENARIOS = [
  {
    // The opening greeting, cued the way useSession's autoGreetText cues it.
    name: 'greeting',
    models: [LIVE, LEGACY, EXTENDED],
    instruction: 'You are a friendly voice assistant in an automated test.',
    async run({ session, note }) {
      const since = session.mark();
      session.sendText('[Session started. Please greet the user in one short sentence.]');
      note('sentText');
      await session.waitForType('turnComplete', 30_000, { since });
      await waitForQuiet(session, 1_500, 6_000);
    },
  },
  {
    // A tool call, a tool that takes 400 ms, and the spoken reply.
    name: 'tool-reply',
    models: [LIVE, LEGACY, EXTENDED],
    instruction: BASE_INSTRUCTION,
    async run({ session, note }) {
      const since = session.mark();
      session.sendText('What is the weather in Paris right now?');
      note('sentText');
      const call = await waitForCall(session, 'getWeather', since);
      note('toolDispatched', { id: call.id, name: call.name });
      await sleep(400);
      session.respondToTool(call, WEATHER_RESULT);
      note('toolResponded', { id: call.id, name: call.name, result: WEATHER_RESULT });
      const reply = await session.waitFor((e) => e.type === 'audio', 30_000, { since: session.mark() });
      await session.waitForType('turnComplete', 30_000, { since: session.trace.indexOf(reply) });
      await waitForQuiet(session, 1_500, 6_000);
    },
  },
  {
    // The model speaks a filler sentence, calls a slow tool, then answers.
    name: 'filler-tool-reply',
    models: [LIVE, LEGACY],
    instruction:
      BASE_INSTRUCTION +
      ' Before you call getWeather, first say out loud exactly: "One moment, let me check." Then call the tool.',
    async run({ session, note }) {
      const since = session.mark();
      session.sendText('What is the weather in Paris right now?');
      note('sentText');
      const call = await waitForCall(session, 'getWeather', since);
      note('toolDispatched', { id: call.id, name: call.name });
      await sleep(2_500);
      session.respondToTool(call, WEATHER_RESULT);
      note('toolResponded', { id: call.id, name: call.name, result: WEATHER_RESULT });
      const reply = await session.waitFor((e) => e.type === 'audio', 30_000, { since: session.mark() });
      await session.waitForType('turnComplete', 30_000, { since: session.trace.indexOf(reply) });
      await waitForQuiet(session, 1_500, 6_000);
    },
  },
  {
    // As above, but the tool answers almost at once, while the filler
    // sentence is still playing: does the reply overlap the first turn's end?
    name: 'filler-fast-tool-reply',
    models: [LIVE, LEGACY],
    instruction:
      BASE_INSTRUCTION +
      ' Before you call getWeather, first say out loud exactly: "One moment, let me check." Then call the tool.',
    async run({ session, note }) {
      const since = session.mark();
      session.sendText('What is the weather in Paris right now?');
      note('sentText');
      const call = await waitForCall(session, 'getWeather', since);
      note('toolDispatched', { id: call.id, name: call.name });
      await sleep(50);
      session.respondToTool(call, WEATHER_RESULT);
      note('toolResponded', { id: call.id, name: call.name, result: WEATHER_RESULT });
      const reply = await session.waitFor((e) => e.type === 'audio', 30_000, { since: session.mark() });
      await session.waitForType('turnComplete', 30_000, { since: session.trace.indexOf(reply) });
      await waitForQuiet(session, 2_500, 8_000);
    },
  },
  {
    // The user says goodbye; the model closes and calls endSession. The test
    // answers the call at once with { result: 'ok' }, exactly as useSession does.
    name: 'goodbye-end-session',
    models: [LIVE, LEGACY, EXTENDED],
    instruction: END_INSTRUCTION,
    async run({ session, note }) {
      const since = session.mark();
      await session.sendAudioPcm16k(kit.loadSpeechFixture('goodbye').pcm, { label: 'goodbye' });
      note('speechEnded');
      const event = await session.waitFor(
        (e) => e.type === 'toolCall' && e.calls.some((c) => c.name === 'endSession'),
        30_000,
        { since, streamSilence: true, description: 'an endSession call' },
      );
      const call = event.calls.find((c) => c.name === 'endSession');
      session.respondToTool(call, 'ok');
      note('toolResponded', { id: call.id, name: call.name, result: 'ok' });
      await waitForQuiet(session, 4_000, 15_000, true);
    },
  },
  {
    // As above, but the endSession call is answered with scheduling SILENT,
    // which is what useSession sends on gemini-3.8-live once the bot has
    // already said its goodbye: the model must not speak again.
    name: 'goodbye-end-session-silent',
    models: [LIVE],
    instruction: END_INSTRUCTION,
    async run({ session, note }) {
      const since = session.mark();
      await session.sendAudioPcm16k(kit.loadSpeechFixture('goodbye').pcm, { label: 'goodbye' });
      note('speechEnded');
      const event = await session.waitFor(
        (e) => e.type === 'toolCall' && e.calls.some((c) => c.name === 'endSession'),
        30_000,
        { since, streamSilence: true, description: 'an endSession call' },
      );
      const call = event.calls.find((c) => c.name === 'endSession');
      session.respondToTool(call, 'ok', { scheduling: 'SILENT' });
      note('toolResponded', { id: call.id, name: call.name, result: 'ok', scheduling: 'SILENT' });
      await waitForQuiet(session, 6_000, 20_000, true);
    },
  },
  {
    // The user speaks over a pending tool. The tool result is NOT sent here:
    // whether to send it is the hook's decision, which the replay test checks.
    name: 'barge-in-during-tool',
    models: [LIVE, LEGACY],
    instruction: BASE_INSTRUCTION,
    async run({ session, note }) {
      const since = session.mark();
      session.sendText('What is the weather in Paris right now?');
      note('sentText');
      const call = await waitForCall(session, 'getWeather', since);
      note('toolDispatched', { id: call.id, name: call.name });
      await sleep(1_000);
      note('bargeInStarted');
      await session.sendAudioPcm16k(kit.loadSpeechFixture('question-capital').pcm, { label: 'barge-in' });
      note('speechEnded');
      await waitForQuiet(session, 4_000, 15_000, true);
      note('toolWouldFinish', { id: call.id, name: call.name, result: WEATHER_RESULT });
    },
  },
  {
    // As above, but the late tool result IS sent, to record what the server
    // does with an answer that arrives after the user moved on.
    name: 'barge-in-during-tool-late-response',
    models: [LIVE, LEGACY],
    instruction: BASE_INSTRUCTION,
    async run({ session, note }) {
      const since = session.mark();
      session.sendText('What is the weather in Paris right now?');
      note('sentText');
      const call = await waitForCall(session, 'getWeather', since);
      note('toolDispatched', { id: call.id, name: call.name });
      await sleep(1_000);
      note('bargeInStarted');
      await session.sendAudioPcm16k(kit.loadSpeechFixture('question-capital').pcm, { label: 'barge-in' });
      note('speechEnded');
      await waitForQuiet(session, 4_000, 15_000, true);
      session.respondToTool(call, WEATHER_RESULT);
      note('toolResponded', { id: call.id, name: call.name, result: WEATHER_RESULT });
      await waitForQuiet(session, 4_000, 15_000, true);
    },
  },
  {
    // The model is speaking its filler sentence, with the tool still pending,
    // when the user talks over it. The late tool result is then sent, to
    // record whether the server cancelled the call and what it does with it.
    name: 'barge-in-over-filler-during-tool',
    models: [LIVE],
    instruction:
      BASE_INSTRUCTION +
      ' Before you call getWeather, first say out loud exactly: "One moment please, let me look that up for you right now." Then call the tool.',
    async run({ session, note }) {
      const since = session.mark();
      session.sendText('What is the weather in Paris right now?');
      note('sentText');
      // Talk over the filler as soon as it starts playing.
      await session.waitFor((e) => e.type === 'audio', 30_000, { since });
      await sleep(400);
      note('bargeInStarted');
      const speaking = session.sendAudioPcm16k(kit.loadSpeechFixture('question-capital').pcm, { label: 'barge-in' });
      const call = await waitForCall(session, 'getWeather', since, 8_000).catch(() => null);
      if (call) note('toolDispatched', { id: call.id, name: call.name });
      await speaking;
      note('speechEnded');
      await waitForQuiet(session, 4_000, 15_000, true);
      if (call) {
        session.respondToTool(call, WEATHER_RESULT);
        note('toolResponded', { id: call.id, name: call.name, result: WEATHER_RESULT });
        await waitForQuiet(session, 4_000, 15_000, true);
      }
    },
  },
];

function sdkVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@google', 'genai', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

async function capture(scenario, model) {
  const config = kit.buildLiveConnectConfig({
    model,
    systemInstruction: scenario.instruction,
    tools: [WEATHER_TOOL],
  });
  const session = await kit.LiveTestSession.connect({ apiKey: key, model, config, captureRawMessages: true });
  /** @type {{t: number, kind: string}[]} */
  const client = [];
  const note = (kind, extra = {}) => client.push({ t: session.now(), kind, ...extra });
  let failure = null;
  try {
    await scenario.run({ session, config, note });
  } catch (err) {
    failure = redact(err);
  } finally {
    await session.close();
  }
  if (failure) throw new Error(`${scenario.name} on ${model}: ${failure}`);

  // One timeline: server messages and the client's own actions, by time.
  const events = [
    ...session.rawMessages.map((m) => ({ t: m.t, from: 'server', message: m.message })),
    ...client.map((c) => ({ ...c, from: 'client' })),
  ].sort((a, b) => a.t - b.t);

  const trace = {
    meta: {
      scenario: scenario.name,
      model,
      capturedAt: new Date().toISOString(),
      sdk: `@google/genai ${sdkVersion()}`,
      generator: 'scripts/capture-live-traces.mjs',
      note: 'Real provider event trace. Synthetic content; audio payloads reduced to byte counts; resumption handles masked; no credentials.',
      thinkingLevel: config.thinkingConfig?.thinkingLevel ?? null,
      turnTaking: 'server VAD, defaults',
    },
    events,
  };
  const text = redact(JSON.stringify(trace, null, 1));
  const file = path.join(OUT_DIR, `${scenario.name}.${model}.json`);
  fs.writeFileSync(file, text + '\n');
  const summary = kit
    .formatLiveTrace(session.trace, 200)
    .filter((l) => !/sessionResumptionUpdate|^\+\d+ms open/.test(l))
    .map((l) => `    ${l}`)
    .join('\n');
  console.log(`\n${scenario.name} / ${model}  ->  ${path.relative(ROOT, file)} (${(text.length / 1024).toFixed(1)} KB)`);
  console.log(summary);
  for (const c of client) console.log(`    [client +${c.t}ms] ${c.kind}`);
}

const only = process.argv.slice(2);
fs.mkdirSync(OUT_DIR, { recursive: true });
let failed = 0;
for (const scenario of SCENARIOS) {
  if (only.length && !only.includes(scenario.name)) continue;
  for (const model of scenario.models) {
    try {
      await capture(scenario, model);
    } catch (err) {
      failed += 1;
      console.error(`FAILED ${redact(err?.message ?? err)}`);
    }
  }
}
process.exit(failed ? 1 : 0);
