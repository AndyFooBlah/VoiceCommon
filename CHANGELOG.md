# Changelog

All notable changes to `@andyfooblah/voice-common`. Entries before 0.14.0 were
reconstructed from git history; where interim work shipped without a version
bump it is folded into the next released version.

## 0.16.1 (2026-11-15)

A patch for how `useSession` keeps its record and its state around tool calls
and at the end of a session. No export, option or signature from 0.16.0 is
changed or removed; apps on `^0.16.0` pick this up with no code change.
Tracking issue: #65.

The fixes were found, and are now guarded, by replaying real event traces
recorded from the Live API through the hook offline (see TESTING.md, "Replay
tests").

### Fixed

- **The goodbye is no longer cut off when the bot ends the session.**
  `onSessionEndRequest` used to fire the moment the `endSession` tool call
  arrived, while the closing words were still queued for playback. An app
  that calls `stopSession()` from that callback (CarBot and weatherbot-app
  do) lost 1.3 to 1.8 s of a 1.8 s goodbye, on the speakers and in the
  recording, on `gemini-3.8-live` and on the 3.1 preview alike. The hook now
  acknowledges the call at once and calls `onSessionEndRequest` only when the
  closing audio has finished playing (300 ms after the queue empties, capped
  at 12 s). An app that already waits by itself (LegacyBot polls
  `isBotSpeaking`) is unaffected.
- **No extra sentence after the goodbye on `gemini-3.8-live`.** Function
  calls on that model are asynchronous, so answering `endSession` made the
  model speak again ("The session has ended."). When the bot has already
  said goodbye the hook now answers with `scheduling: SILENT`, which the
  model takes without speaking.
- **The greeting echo mute is no longer released at the start of the
  greeting.** The provider opens most replies with a one-sample audio chunk.
  The hook treated that chunk finishing as the bot having stopped speaking:
  it reported `onBotSpeaking(false)` and re-enabled microphone input about
  20 ms into the greeting, which is what the mute exists to prevent. The bot
  now counts as silent only when playback has drained AND the provider has
  said the reply is fully generated (`generationComplete`, `turnComplete` or
  `interrupted`). `onBotSpeaking` no longer flickers at the start of a reply
  or in a gap between chunks. If no such signal and no further audio arrives
  for 1.5 s after playback drains, the reply is treated as over.
- **Transcript order around a tool call.** What the bot says before calling
  a tool ("One moment, let me check.") is now persisted as its own entry
  when the call is issued. Before, on the 3.1 preview it was glued to the
  answer in one entry written after the tool entry ("One moment, let me
  check.It is 18 degrees…"), and on `gemini-3.8-live` a fast tool's entry was
  written ahead of the sentence that preceded it. The record now reads in
  the order things happened: bot, tool, bot.
- **Tool results are not sent for calls the server cancelled.** The hook now
  honours `toolCallCancellation` by call id. It previously inferred
  cancellation only from its own turn counter, which the early
  `turnComplete` of an asynchronous call advances.

### Verified unchanged (now covered by tests)

- The early `turnComplete` that `gemini-3.8-live` sends right after a
  `toolCall` adds no transcript entry, does not touch `onBotSpeaking`, the
  microphone or the recorder, and does not stop the tool result being sent.
- One bot entry holds the whole spoken reply to a tool result; nothing is
  dropped or duplicated; rendered messages match persisted entries.
- When the user speaks while a tool is pending and the bot is silent,
  `gemini-3.8-live` keeps the call open and the hook sends the result.

### Added

- `UseSessionOptions.onInteractionStatus(status)`. On
  `gemini-3.8-live-extended-thinking`, `turnComplete` does not mean idle: the
  model speaks a filler sentence, sends `turnComplete`, and only then calls
  the tool. It reports `interactionStatus` (`IN_PROGRESS`, then `IDLE`)
  instead. The hook now tracks it: the callback reports each change, the
  greeting mute and the end-of-session wait both hold until `IDLE`, and the
  filler and the answer are separate transcript entries.
- Registry: `LiveModelInfo.idleSignal` (`'turnComplete'` or
  `'interactionStatus'`) and `LiveModelInfo.toolCallEndsTurnEarly`.
- Testing kit: `canaryToolCallOrdering` and `canarySilentToolResponse` (check
  names `tool-call-ordering` and `silent-tool-response`), and
  `LiveTestSessionOptions.captureRawMessages` / `session.rawMessages` for
  recording replayable traces. `LiveTestSession` now also reads
  `interactionStatus` from inside `serverContent`, where the provider sends it.
- `scripts/capture-live-traces.mjs` and 19 recorded traces under
  `src/__tests__/fixtures/live-traces/` (synthetic content, audio reduced to
  byte counts, no credentials).

### Tests and CI

- Offline: 297 to 393 tests. 68 of them replay the recorded traces through
  the hook on a virtual clock; 13 of those fail against the 0.16.0 hook.
- Live: 42 to 48 tests (the two new canaries, per model).
- CI now runs `npm run lint`. Publishing remains gated on the offline suite
  only, never on the live suite.

## 0.16.0 (2026-11-15)

The default Live model is now `gemini-3.8-live`, the thinking level defaults to
`'auto'`, and the package ships a real test kit for the Live API. Tracking
issue: #64.

### Migrating from 0.15.x

- **If you pass `liveModel` and `thinkingLevel` explicitly** (every known app
  does: `liveModel: 'gemini-3.8-live', thinkingLevel: 'none'`), nothing
  changes. You may now delete both options and get the same session.
- **If you relied on the defaults**, your sessions move from
  `gemini-3.1-flash-live-preview` + `MINIMAL` to `gemini-3.8-live` with no
  `thinkingConfig`. To stay on the legacy model, pass
  `liveModel: 'gemini-3.1-flash-live-preview'` (`'auto'` sends MINIMAL to it,
  as before). The provider labels that model legacy and names
  `gemini-3.8-live` as its replacement.
- **`DEFAULT_LIVE_MODEL` changed value.** Code that compares against the old
  id, or greps a bundle for it, needs updating.
- **A model/thinking mismatch now fails before connecting.** An explicit
  `thinkingLevel` the registry knows the model rejects (for example `MINIMAL`
  on `gemini-3.8-live`) used to open a socket that the server closed with
  1007. It now fails the session start with a `LiveConfigError` naming the
  model, the value and the fix. Model ids the registry does not know are
  never blocked; an explicit level is passed through untouched.
- **`VoiceSimulator` is removed** from `@andyfooblah/voice-common/testing`. It
  was a stub whose `simulate()` returned mock data. The entry now exports the
  live conformance kit described below.

### Model registry and safe defaults

- New `src/services/liveModels.ts` (pure; no React, DOM or Firebase):
  `LIVE_MODELS`, `DEFAULT_LIVE_MODEL`, `getLiveModelInfo`,
  `resolveThinkingConfig(model, requested)`, `assertLiveModelUsable`,
  `LiveConfigError`. Each entry records status (current / legacy / shutdown),
  release and shutdown dates, the thinking contract, and how the model runs
  tool calls.
- `thinkingLevel` accepts `'auto'` and defaults to it: omitted for
  `gemini-3.8-live`, LOW for `gemini-3.8-live-extended-thinking`, MINIMAL for
  the legacy 3.1 preview, omitted for unknown ids.
- New `buildLiveConnectConfig(params)` in `src/services/liveConnectConfig.ts`
  (pure). `useSession` calls it for every connect and reconnect, and the test
  kit calls the same function, so tests exercise the setup message production
  sends. It also rejects, before connecting, a model the registry marks shut
  down and a `behavior: BLOCKING` tool on a model that only runs tools
  asynchronously.
- `useSession` no longer hangs when the server rejects a setup. The SDK's
  `live.connect()` resolves only after `setupComplete`; on a rejected setup
  the server closes the socket and that promise never settles, which left the
  session stuck in CONNECTING and then trying to resume a session that never
  existed. The start now fails with the server's close code and reason.
- New `UseSessionOptions.liveApiVersion` (default `LIVE_API_VERSION`,
  `'v1alpha'`). See "Ephemeral tokens and the API version" below.
- A session on a legacy model logs one warning at connect naming the
  replacement.

### Provider contract, measured against the live API on 2026-11-15

| Model | `thinkingConfig` | Tool calls |
|---|---|---|
| `gemini-3.8-live` | rejected for every level (1007 "Thinking level is not supported for this model.") | asynchronous by default; `behavior: BLOCKING` accepted |
| `gemini-3.8-live-extended-thinking` | required (omitted: 1007 "Thinking level must be specified for this model."); MINIMAL rejected; LOW / MEDIUM / HIGH accepted | asynchronous only; a `BLOCKING` declaration is rejected at setup (1007) |
| `gemini-3.1-flash-live-preview` (legacy) | optional: omitted and every level accepted | blocking |

Two things differ from what 0.15.0 recorded:

- The 3.1 preview does **not** require a thinking level; omitting it works.
- On `gemini-3.8-live`, function calls are asynchronous unless a declaration
  says otherwise. The turn that issues a call ends at once: `turnComplete`
  arrives right after the `toolCall`, **before** the spoken reply to the tool
  result, which then arrives as a further turn. On the 3.1 preview there is
  one `turnComplete`, after the reply.

### Ephemeral tokens and the API version

Closes the September audit item about the `v1alpha` pin. Measured with
`@google/genai` 2.11.0 and 2.32.0: a token minted by `authTokens.create` on
`v1alpha` or on `v1beta` opens a Live session on either version; all four
combinations pass. The provider's ephemeral-token guide now says "only with the
`v1beta` version", while the SDK (2.11.0, 2.32.0 and 3.3.0 alike) logs
"ephemeral token support is in v1alpha only" for anything else. The pin stays
on `v1alpha`, the version the SDK asks for; `liveApiVersion` is the escape
hatch, and the live suite checks all four combinations on every run so a
change on either side is caught.

### Live conformance kit: `@andyfooblah/voice-common/testing`

A headless Node kit (`@google/genai` only; no React, DOM or Firebase) for
testing an app's real Live configuration against the real API. See
[TESTING.md](TESTING.md).

- `LiveTestSession`: connects with an API key or an ephemeral token, records
  a typed event trace, and offers `sendText`, `sendAudioPcm16k`,
  `activityStart` / `activityEnd`, `respondToTool`, `waitFor`, `close`.
- Six committed speech fixtures (synthetic voices, 16 kHz mono WAV, under
  200 KB each) in `fixtures/speech/`, generated once by
  `scripts/gen-speech-fixtures.mjs`.
- Named checks, each returning `{ name, pass, status, detail, metrics }`:
  setup, text turn, audio turn, tool declarations accepted, tool round trip,
  manual turn control, patience, barge-in, session resumption, context
  compression, model listed, ephemeral-token path, latency, and three
  provider-contract canaries that report "contract changed" rather than a
  plain failure.
- `runLiveConformance(profile, { apiKey, checks })`, with
  `formatLiveConformanceReport` and `assertLiveConformance`, so an app's live
  test is about twenty lines.
- Keys and tokens are never logged or stored, and are redacted from errors.

### Tests

- Offline (in `npm test`, no network, no key): table-driven registry and
  builder tests, hook tests proving `useSession` sends the builder's output,
  kit tests against a scripted fake SDK, fixture integrity, and a guard that
  fails if a retired model id returns to shipping source.
- Live (`npm run test:live`, self-skipping without `GEMINI_API_KEY`): the full
  check list for the default model, the turn-taking presets, and the canaries.
- `.github/workflows/live-contract.yml`: manual and weekly; skips cleanly
  unless the `LIVE_TEST_GEMINI_API_KEY` secret exists. Off by default.

## 0.15.0 (2026-09-18)

Adds two `UseSessionOptions` fields so each app can choose its own Gemini Live
model. **Both default to the previous behaviour, so upgrading from 0.14.x
changes nothing until you opt in.**

- `liveModel?: string` — the Live model id. Defaults to the newly exported
  `DEFAULT_LIVE_MODEL`, still `gemini-3.1-flash-live-preview`.
- `thinkingLevel?: ThinkingLevel | 'none'` — sent as
  `thinkingConfig.thinkingLevel`, or `'none'` to omit `thinkingConfig`
  entirely. Defaults to `MINIMAL`.

**Why both are needed together.** The Live models disagree about
`thinkingConfig`, and a mismatch closes the WebSocket at setup with code
`1007`, which presents as a connection failure rather than a config error.
Measured against the live API on 2026-09-18:

| Model | `thinkingConfig` |
|---|---|
| `gemini-3.1-flash-live-preview` | required; `MINIMAL` accepted |
| `gemini-3.8-live` | **rejected** — `1007 Thinking level is not supported for this model` |
| `gemini-3.8-live-extended-thinking` | **required**, but `MINIMAL` rejected; use `LOW`/`MEDIUM`/`HIGH` |

So moving to `gemini-3.8-live` means passing `thinkingLevel: 'none'` as well as
`liveModel`. Changing only the id will break every session.

`gemini-3.8-live` (stable, released 2026-09-15) is priced identically to the
3.1 preview. Measured latency from end-of-turn to first speech, three trials:
3.1 preview with `MINIMAL` 0.75-0.78s; `gemini-3.8-live` 0.76-0.94s;
`gemini-3.8-live-extended-thinking` with `HIGH` 0.95-1.13s. Manual turn control
(`activityStart`/`activityEnd`), server `silenceDurationMs`, and function
calling all behave the same on 3.8-live. Input transcription still arrives as a
single event at end of turn, so nothing there improves.

Consumers on 0.15.0: LegacyBot, CarBot, weatherbot-app — all now on
`gemini-3.8-live` with `thinkingLevel: 'none'`.

## 0.14.1 (2026-09-10)

Metadata/housekeeping release — no changes to the session pipeline or the
published JavaScript:

- `LICENSE` is now the verbatim Apache-2.0 text (GitHub previously reported
  `NOASSERTION`); `package.json` gains `license`, `repository`, `homepage`,
  `bugs` (#28)
- `.env` / `.env.*` are gitignored (only `.env.example` is tracked) and the
  README no longer suggests putting Gemini credentials in `.env` — Gemini access
  is via `tokenProvider` only (#27)
- Removed `prototypes/latency_comparator/` (a copy of LegacyBot's prototype that
  carried 49 dependabot alerts and browser-side API keys); the last commit
  containing it is tagged `prototype/latency-comparator` (#29)
- Fixed the package name in the shipped JSDoc: `@andyfooblah/knowledgecommon` →
  `@andyfooblah/knowledge-common` (`lib.ts`, `services/gemini.ts`)
- `publish.yml` now publishes via npm Trusted Publishing (OIDC) with provenance
  — no `NPM_TOKEN`; triggers on `v*` tags and published GitHub Releases and
  refuses a tag that does not match `package.json`. Annotated tags `v0.5.0` …
  `v0.14.0` were back-filled on the commits that bumped those versions (#30)

## 0.14.0 (2026-07-09)

Pre-publication cleanup release — no functional changes to the session pipeline:

- Removed dead AI-Studio-era root files (`App.tsx`, `index.tsx`, `components/`) that contained the browser-side API key anti-pattern, plus stale scripts (`test-wikipedia-rag.ts`, `migrate-to-families.ts`)
- Rebranded the demo shell from LegacyBot to VoiceCommon (title, manifest, logos, file headers)
- Rewrote SECURITY.md for the library; fixed stale README/docstring claims (pre-0.10.0 reconnect behavior, removed `geminiApiKey` examples); added this CHANGELOG
- Dependency hygiene: framework packages (`react`, `react-dom`, `firebase`, `@google/genai`) are now peerDependencies with pinned devDependencies for local dev; `@andyfooblah/knowledge-common` moved to devDependencies (used only by the demo app, not the published library)
- Content-bearing session logs (speech previews, tool result bodies) are now gated behind a new `debug?: boolean` config flag (default false)
- Latency-comparator prototype servers now bind 127.0.0.1 and carry explicit local-dev-only warnings
- `VoiceSimulator` is now clearly marked as an unimplemented experimental stub

## 0.13.0

- Stream the user's input transcription into one growing bubble per turn (single transcript entry per user turn instead of one per chunk)

## 0.12.0

- Fix the "double greeting" at its source: mic audio is muted (not forwarded to Gemini) until the opening greeting finishes playing, so speaker echo can't retrigger it

## 0.11.1

- Suppress mid-turn session restart that could cause a double greeting

## 0.11.0

- Robust reconnection via Gemini session-resumption handles with continuous recording — the recorder is never restarted across reconnects, producing one continuous audio file

## 0.10.0

- **Critical recording-integrity fix:** halt the session on disconnect or recorder failure instead of the previous lossy auto-reconnect, which could overwrite the opening minutes of a recording

## 0.9.1

- Client-side VAD hysteresis so background-noise blips don't restart the end-of-turn silence wait

## 0.9.0

- `manualTurnControl` option: client-side energy VAD drives turn boundaries (server VAD disabled) for patient turn-taking on native-audio models

## 0.8.0

- `endOfSpeechSensitivity` option (`'HIGH' | 'LOW'`) for server-VAD end-of-speech eagerness

## 0.7.x

- `endOfSpeechSilenceMs` option (configurable end-of-speech silence); 0.7.1 logs the resolved VAD `silenceDurationMs` at connect
- Interim: tools override on `startSession`, per-turn timing logs, tool duration/size metrics, `additionalSessionData`

## 0.6.2

- Flush the in-progress bot turn before ending the session so the closing reply lands in the transcript

## 0.6.1

- Pin the `v1alpha` API version for ephemeral-token Live sessions

## 0.6.0

- **Breaking:** removed the `geminiApiKey` config field entirely — a server-side-brokered ephemeral-token `tokenProvider` is now mandatory, with ESLint + post-build bundle-scan guards against key leaks
- Experimental `VoiceSimulator` testing stub added

## 0.5.x (unlabeled interim releases)

- Security hardening (storage ownership checks, scrubbed error logs), `archiveAudio` override, session telemetry metrics, transcript-duplication fix, useSession test suite, CI sibling checkout of KnowledgeCommon

## 0.4.1

- `speechConfig` option, `overrideAutoGreetText` parameter on `startSession()`, `onSessionEnd` callback, `sessionsCollection` option, `endSession` tool acknowledgement fix

## 0.4.0

- Session reliability fixes; `sessionsCollection` + `onSessionEnd` added; knowledge tools moved out to `@andyfooblah/knowledge-common`

## 0.3.0

- Renamed package to `@andyfooblah/voice-common`

## Pre-0.3.0

- Extracted from a voice-first interview application into a standalone, generic voice AI framework (Gemini Live sessions, Firebase auth, transcript + audio archival, auto-greet, tool dispatch)
