# Testing VoiceCommon

VoiceCommon is tested at three levels. Only the first runs in normal CI.

| Level | Command | Network / key | What it proves |
|---|---|---|---|
| Offline tests | `npm test` | none | The registry, the connect-config builder, the hook and the kit behave as specified |
| Live suite | `npm run test:live` | real Gemini Live API, `GEMINI_API_KEY` | The config VoiceCommon sends is accepted and works against the real service, today |
| Live contract canary | `.github/workflows/live-contract.yml` | same, weekly in CI, **off by default** | The provider has not changed the contract the registry records |

The same kit that drives the live suite is published as
`@andyfooblah/voice-common/testing`, so each app can run the checks against
its own production configuration. See [How an app adopts the kit](#how-an-app-adopts-the-kit).

---

## 1. Offline tests (`npm test`)

No network and no key. They run on every push and pull request.

| File | Covers |
|---|---|
| `src/__tests__/services/liveModels.test.ts` | Table-driven: every known Live model x every thinking request (`auto`, `none`, MINIMAL, LOW, MEDIUM, HIGH) gives an exact `thinkingConfig` or an exact, actionable `LiveConfigError`. Unknown ids pass through. Registry invariants. |
| `src/__tests__/services/liveConnectConfig.test.ts` | `buildLiveConnectConfig`: the exact default config, server VAD vs manual turn control, silence, sensitivity, `speechConfig`, resumption handle present and absent, tools including the injected `endSession`, and the errors it raises before connecting. |
| `src/__tests__/hooks/useSession.test.ts` | The hook passes exactly the builder's output to `live.connect` for the default and for a customised session; the default model and `'auto'` thinking; a rejected combination fails before a token is minted; a setup the server rejects fails the start instead of hanging; the API-version pin. |
| `src/__tests__/testing/liveKit.test.ts` | `LiveTestSession`, the checks and `runLiveConformance` against a scripted fake SDK: trace recording, rejected setup, timeouts, redaction, the "contract changed" verdict. |
| `src/__tests__/testing/kitPure.test.ts` | Redaction, fuzzy text matching, PCM/WAV helpers, and the integrity of every committed speech fixture (checksum, format, size). |
| `src/__tests__/noRetiredModels.test.ts` | Guard: scans shipping source for model ids. A legacy or shut-down id outside the registry, or an id nobody has verified, fails the build with file and line. |

`npm run build:lib` adds two build-time guards: `scripts/check-bundle-for-secrets.mjs`
(no key-shaped string in `dist/`) and `scripts/check-testing-entry.mjs`
(the built testing entry imports only `@google/genai` and `node:` built-ins,
loads in plain Node, and finds its fixtures).

---

## 2. The live conformance kit

```ts
import { runLiveConformance, LiveTestSession, loadSpeechFixture } from '@andyfooblah/voice-common/testing';
```

**Node only.** The entry imports `@google/genai` and Node built-ins. It does
not import React, the DOM or Firebase, and it must never be imported by
browser code: it takes a long-lived API key at runtime.

### `runLiveConformance(profile, options)`

```ts
const report = await runLiveConformance(
  {
    name: 'my-app',
    model: 'gemini-3.8-live',            // default: DEFAULT_LIVE_MODEL
    thinkingLevel: 'auto',               // default
    systemInstruction: realInstruction,  // the app's real one
    tools: realTools,                    // the app's real declarations (without endSession)
    speechConfig,                        // optional
    endOfSpeechSensitivity: 'LOW',       // turn-taking, as passed to useSession
    endOfSpeechSilenceMs: 2500,
    manualTurnControl: false,
  },
  {
    apiKey: process.env.GEMINI_API_KEY!,
    checks: ['setup', 'text-turn', 'audio-turn'],  // default: DEFAULT_LIVE_CHECKS
    toolProbe: { prompt: 'What is the weather in Paris?', expectTool: 'getWeather', result: 'Sunny.' },
  },
);
console.log(formatLiveConformanceReport(report));
assertLiveConformance(report);   // throws, with the report, unless report.ok
```

The profile is turned into a connect config by `buildLiveConnectConfig`, the
function `useSession` calls, so the test sends what production sends. For a
code path that calls `ai.live.connect` directly, pass that path's exact config
as `profile.connectConfig` instead.

Every check returns:

```ts
interface LiveCheckResult {
  name: string;
  pass: boolean;        // true for pass, warn and skipped
  status: 'pass' | 'warn' | 'skipped' | 'fail' | 'contract-changed';
  detail: string;       // one actionable line; on failure includes the close code and reason
  metrics: Record<string, number | string | boolean>;
  durationMs: number;
  trace?: string[];     // only when it did not pass: a compact event trace
}
```

### The checks

Each is also exported as a function (`checkSetupAccepted(target)` and so on)
taking `{ apiKey, model, config }`.

| Name | Function | Passes when |
|---|---|---|
| `setup` | `checkSetupAccepted` | The socket reaches `setupComplete` with the production config. A failure reports the close code and reason: this is where a rejected thinking level, voice or tool schema shows up. |
| `text-turn` | `checkTextTurn` | A text cue (sent as `useSession` sends its opening cue) yields bot audio, a non-empty output transcription and `turnComplete`. |
| `audio-turn` | `checkAudioTurn` | A spoken fixture under the profile's server VAD is transcribed (word match against the fixture text, default 60%) and answered. Skipped for a manual-turn-control profile. |
| `tool-declarations` | `checkToolDeclarationsAccepted` | The full tool list is accepted at setup and a first turn runs with it. Schema rejections are a real failure class. |
| `tool-round-trip` | `checkToolRoundTrip` | A prompt triggers the named tool, the test answers it, and the bot speaks again. With no `toolProbe`, a built-in probe tool is added to the app's declarations. |
| `manual-turn-control` | `checkManualTurnControl` | With automatic VAD disabled, `activityStart` + audio + `activityEnd` yields a reply. Always run with VAD disabled, so an app knows its fallback works. |
| `patience` | `checkPatience` | `silenceDurationMs` is honoured: two halves of a sentence with a silent gap (60% of the silence) are one turn, the bot is silent through the gap, and it does not answer sooner than the configured silence. Skipped when the profile leaves silence at the server default; pass `patience: { silenceMs }` to test a value. |
| `barge-in` | `checkBargeIn` | Speaking over the bot produces an `interrupted` event. |
| `session-resumption` | `checkSessionResumption` | A handle is captured, the session reconnects with it, and the bot still recalls a code word from before the reconnect. |
| `context-compression` | `checkContextWindowCompression` | `contextWindowCompression` (sliding window) is accepted and a turn runs. |
| `model-listed` | `checkModelListed` | `models.list` includes the model with `bidiGenerateContent`. |
| `ephemeral-token` | `checkEphemeralToken` | The production auth path: mint with `authTokens.create` (as the README broker does), connect with the token on the hook's API version, run a turn. |
| `latency` | `checkLatency` | End of user speech to first bot audio, median of three turns. Over the soft budget is a `warn`; only over the hard cap is a `fail`. |
| `thinking-contract` | `canaryThinkingContract` | Canary. For each of `none`, MINIMAL, LOW, MEDIUM, HIGH the server accepts or rejects setup exactly as the registry predicts. |
| `tool-behavior-contract` | `canaryToolBehaviorContract` | Canary. A `behavior: BLOCKING` tool declaration is accepted or rejected as the registry predicts. |
| `registry-freshness` | `canaryRegistryFreshness` | Canary. No dialogue Live model is listed that the registry does not know (a `warn` usually means a newer model shipped). |

`DEFAULT_LIVE_CHECKS` is everything above the three canaries. The canaries are
model-level rather than app-level, so they run only when named; this repo's
live suite runs them.

**"Contract changed" is not "failed".** When a canary flips, the result is
`status: 'contract-changed'` with a detail that begins `PROVIDER CONTRACT
CHANGED` and says what the registry expected and what the server did.
Sessions may still work. The action is to review `src/services/liveModels.ts`
against the provider docs, not to debug the app.

### `LiveTestSession`

For a test the named checks do not cover:

```ts
const session = await LiveTestSession.connect({ apiKey, model, config });   // or { ephemeralToken, ... }
const since = session.mark();
await session.sendAudioPcm16k(loadSpeechFixture('goodbye').pcm);            // paced like a microphone
const call = await session.waitForType('toolCall', 20_000, { since, streamSilence: true });
session.respondToTool(call.calls[0], 'ok');
await session.waitForType('turnComplete', 20_000, { since });
console.log(session.outputText(since), session.audioBytes(since));
await session.close();
```

- `connect` resolves at `setupComplete` and throws `LiveSetupError` (with
  `code` and `reason`) if the server closes first.
- `trace` holds every event in order: `open`, `setupComplete`, `audio`
  (byte counts), `inputTranscription`, `outputTranscription`, `toolCall`,
  `toolCallCancellation`, `generationComplete`, `turnComplete`, `interrupted`,
  `interactionStatus`, `goAway`, `sessionResumptionUpdate`, `usage`, `error`,
  `close` (code and reason), plus a `sent…` event for everything the test sent.
- Helpers: `sendText`, `sendClientText`, `sendAudioPcm16k`, `sendSilence`,
  `activityStart`, `activityEnd`, `audioStreamEnd`, `respondToTool`,
  `waitFor(predicate, timeoutMs, { since, streamSilence })`, `waitForType`,
  `mark`, `events`, `first`, `audioBytes`, `inputText`, `outputText`,
  `latestResumptionHandle`, `close`. `formatLiveTrace(session.trace)` renders
  a trace for a log.
- Under server VAD, keep the microphone "open" while waiting for a reply:
  `streamSilence: true`. The server needs the audio stream to continue in
  order to notice the speech has ended.

### Speech fixtures

`fixtures/speech/` holds six short utterances as 16 kHz mono 16-bit WAV, each
under 200 KB, with `manifest.json` (text, voice, duration, SHA-256).

| Id | Text | Used by |
|---|---|---|
| `question-capital` | "What is the capital of France?" | audio turn, manual turn control, latency |
| `story-part-1`, `story-part-2` | The two halves of one sentence | patience (a silent gap is inserted between them) |
| `distinct-words` | "The seven yellow apples are in the garden by the window." | transcription accuracy |
| `barge-in` | Five seconds of continuous speech | barge-in |
| `goodbye` | "Okay, that's everything I needed today. Thank you, goodbye." | for apps testing their end-of-session tool |

**Provenance.** Every voice is synthetic: the files were generated once, on
2026-11-15, by `scripts/gen-speech-fixtures.mjs` using the Gemini TTS model
`gemini-3.8-flash-tts` (prebuilt voices Kore and Charon), resampled from
24 kHz to 16 kHz and trimmed of leading and trailing silence. No recording of
a real person is involved. Tests never synthesize at runtime. The TTS model is
not deterministic, so regenerating produces different audio; only do it to add
or replace a fixture (`GEMINI_API_KEY=... node scripts/gen-speech-fixtures.mjs --only <id> --force`)
and commit the WAV and the manifest together.

Use your own audio with `loadWavPcm16k(path)` (16 kHz mono 16-bit PCM WAV).

### Keys and tokens

- The kit takes the key as an argument. It never reads it from a file, never
  logs it, and never stores it in a trace, a result or a report.
- Every string that could carry SDK or server text (errors, close reasons,
  details, traces) is passed through a redactor that removes the literal key
  or token and anything shaped like a Google API key, an ephemeral token, or a
  `key=` / `access_token=` query parameter.
- Read the key into the process environment at run time. Do not write it to a
  file, and do not give it a `VITE_` prefix: anything with that prefix is
  built into a browser bundle.

---

## 3. The live suite in this repo (`npm run test:live`)

```bash
# The key lives only in this process's environment.
GEMINI_API_KEY="$(gcloud secrets versions access latest --secret=GEMINI_API_KEY --project=<project>)" \
  npm run test:live

# Optional: a results table.
LIVE_RESULTS_FILE=/tmp/live.jsonl GEMINI_API_KEY=... npm run test:live
node scripts/summarize-live-results.mjs /tmp/live.jsonl
```

Without `GEMINI_API_KEY` every live test is skipped and the command exits
green. The files are `src/__tests__/live/*.live.test.ts`, run by
`vitest.live.config.ts` (Node environment, one file at a time, one retry) and
excluded from `npm test`.

| File | Runs |
|---|---|
| `defaultModel.live.test.ts` | Checks 1 to 13 for `DEFAULT_LIVE_MODEL` with the config `useSession` builds by default. |
| `turnTakingMatrix.live.test.ts` | Spoken turn, patience, barge-in and latency for three presets: server VAD with defaults (CarBot, weatherbot-app), LOW end sensitivity with a 2500 ms silence (LegacyBot), and manual turn control. |
| `contractCanaries.live.test.ts` | The thinking and tool-behaviour canaries for every measured model in the registry; the registry-freshness canary; proof that `thinkingLevel: 'auto'` gives a working session with a tool round trip on `gemini-3.8-live-extended-thinking` and on the legacy 3.1 preview; the four mint/connect API-version combinations for ephemeral tokens. |

### What the provider does today

Measured by this suite on 2026-11-15. These are observations, recorded so a
change is noticed, not guarantees.

- **Thinking.** `gemini-3.8-live` rejects every thinking level;
  `gemini-3.8-live-extended-thinking` requires one and rejects MINIMAL; the
  legacy `gemini-3.1-flash-live-preview` accepts any level and also accepts
  none. Rejections are a close with code 1007 during setup.
- **Tool calls on `gemini-3.8-live` are asynchronous by default.** The turn
  that issues a call ends at once: `generationComplete` and `turnComplete`
  arrive right after the `toolCall`, before the spoken reply to the tool
  result. The reply is a further turn. Call ids start `call_`. On the legacy
  3.1 preview calls block, ids start `fc_`, and there is one `turnComplete`
  after the reply. `gemini-3.8-live-extended-thinking` speaks a filler
  sentence before the tool call and rejects a `behavior: BLOCKING`
  declaration at setup.
- **Server VAD honours `silenceDurationMs` on clean audio.** With 2500 ms and
  3000 ms the bot stayed silent through a pause of 60% of that length, treated
  both halves as one turn, and answered about 400 to 1000 ms after the silence
  elapsed. The pause in the test is digital silence; a real room has noise
  that can retrigger VAD, so manual turn control remains the robust choice for
  a noisy room.
- **Input transcription arrives once, after the turn ends**, not word by word.
- **Latency**, end of speech to first bot audio: about 1.1 s under default
  server VAD (which includes the server's own end-of-speech wait), about
  0.6 to 0.75 s after `activityEnd` under manual turn control.
- **Barge-in** is reported about 0.2 s after the user starts speaking under
  server VAD, under 0.1 s under manual turn control.
- **Ephemeral tokens** minted on `v1alpha` or `v1beta` connect on either.
- **`ai.live.connect()` never settles when setup is rejected.** The SDK
  promise resolves only after `setupComplete`; a rejection arrives as a close
  event. `LiveTestSession.connect` and `useSession` both race the two.

---

## 4. The live contract canary (CI)

`.github/workflows/live-contract.yml` runs `npm run test:live` on
`workflow_dispatch` and every Monday at 14:23 UTC.

- **Off by default.** The first step checks for the repository secret
  `LIVE_TEST_GEMINI_API_KEY`. Without it the job ends green with a notice and
  nothing is sent to the API. Enabling it is the owner's decision; the
  one-time command is in the README under "Live contract canary".
- Dependencies are installed with `npm ci --ignore-scripts` before the key is
  in scope. The job that holds the key has read-only permissions; a separate
  job, which runs no repository code, has `issues: write`.
- On failure it opens one issue titled "Live contract canary is failing",
  assigned to the owner, or comments on the open one. A later pass comments
  and closes it. The job summary carries the full results table.
- Actions are pinned by commit SHA.

---

## How an app adopts the kit

1. **Depend on `@andyfooblah/voice-common` 0.16.0 or later** (already a
   dependency) and on `@google/genai` 2.x. Type-checking the tests needs
   `@types/node`.
2. **Keep the Live configuration in one place** the app and the test both
   import: the model id, the instruction builder, the tool declarations, the
   voice, the turn-taking options.
3. **Add a live test that is not part of `npm test`.** Name it
   `*.live.test.ts`, exclude that pattern from the normal vitest config, and
   add a second config or script that includes it and runs in Node:

   ```ts
   // vitest.live.config.ts
   import { defineConfig } from 'vitest/config';
   export default defineConfig({
     test: { environment: 'node', include: ['src/**/*.live.test.ts'], fileParallelism: false, testTimeout: 600_000 },
   });
   ```

   ```json
   { "scripts": { "test:live": "vitest run --config vitest.live.config.ts" } }
   ```

4. **Write the test** (the README has a complete twenty-line example): build a
   `LiveAppProfile` from the shared configuration, call `runLiveConformance`,
   print `formatLiveConformanceReport(report)`, call
   `assertLiveConformance(report)`. Skip the whole block when
   `GEMINI_API_KEY` is absent.
5. **Give `tool-round-trip` a real probe**: a prompt that should trigger one
   of the app's own tools, and a canned result. That proves the app's schema
   and instruction work together, which the built-in probe cannot.
6. **Cover every Live code path.** An app with a second path that calls
   `ai.live.connect` directly should run a second `runLiveConformance` with
   that path's config as `profile.connectConfig`.
7. **Run it with the key from the secret manager**, as in section 3. Never put
   the key in a file or a `VITE_` variable.

The app does not need the three provider-contract canaries; this repo runs
them.

---

## Costs

A full run of this repo's live suite (42 tests) opens about 60 short sessions
and takes about four minutes: roughly two minutes of audio in and two to three
minutes of audio out. At the `gemini-3.8-live` prices checked on 2026-11-15 ($0.005 per minute
of audio in, $0.018 per minute of audio out) that is **well under $0.25 per
run**; a weekly canary is a few dollars a year. An app's default
`runLiveConformance` (13 checks) is about a third of that. Generating all six
fixtures cost about one cent, once.

---

## Limitations

- The kit talks to the Live API directly. It does not exercise the browser
  audio pipeline: the microphone, the AudioWorklet, playback scheduling, the
  recorder, or the hook's client-side energy VAD. Those are covered offline
  with mocks, and by using the app.
- Fixture audio is clean, synthetic speech with digital silence. It shows
  that settings reach the server and are obeyed. It does not reproduce room
  noise, echo, accents or hesitant speakers.
- Model output is not deterministic. Checks assert on structure (events,
  fuzzy word matches, a recalled code word), and the live suite retries a
  failed test once. A real break fails twice.
- Latency numbers depend on the network between the test machine and the API.
