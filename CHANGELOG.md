# Changelog

All notable changes to `@andyfooblah/voice-common`. Entries before 0.14.0 were
reconstructed from git history; where interim work shipped without a version
bump it is folded into the next released version.

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
