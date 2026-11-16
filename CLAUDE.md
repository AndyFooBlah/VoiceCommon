# VoiceCommon — Claude Code Instructions

## 🔑 Sensitive API keys — read first

**VoiceCommon is a library and never holds a Gemini API key.** The only sanctioned auth path is the consumer-supplied `tokenProvider` callback:

```ts
initializeVoiceCommon({
  firebase: { ... },
  tokenProvider: async () => {
    const result = await myMintGeminiLiveTokenCallable();
    return result; // { token: string, expireTime: string }
  },
});
```

`tokenProvider` is **required** by `VoiceCommonConfig` (the previous `geminiApiKey` field was deleted in 0.6.0). `useSession`'s `connectGemini` calls it once per Live session and passes the returned ephemeral token as the `apiKey` to `GoogleGenAI` — the long-lived key never reaches the browser, in this library or any consumer's bundle.

**Do not** add a `geminiApiKey?: string` "convenience" field "just for local dev". The whole point of dropping it was that the easier path always wins, and developers who reach for it ship keys to production. Local dev that needs Gemini Live must implement a `tokenProvider`. The demo (`src/index.tsx`) ships a placeholder that throws an explanatory error so a missing broker fails loudly at session start.

**Two automated guards stop accidental regressions:**

1. **ESLint** (`eslint.config.js`) — `no-restricted-syntax` errors on any read of `import.meta.env.VITE_GEMINI_*`, `VITE_GOOGLE_MAPS_*`, or `VITE_*_(SECRET|TOKEN)` inside `src/**`. The demo entry point is exempted only for `VITE_FIREBASE_*`.
2. **Post-build bundle scan** (`scripts/check-bundle-for-secrets.mjs`, run as part of `npm run build:lib`) — greps the published `dist/` for known secret shapes and **fails on any match** (no allowlist — libraries must never ship a key, not even Firebase config; consumers supply that at runtime).

If either guard fires, **fix the leak**; do not weaken the rule.

**The one place a long-lived key is accepted is the Node-only test kit**, `@andyfooblah/voice-common/testing` (`src/testing/`). It is test code that runs in a Node process, never in a browser, and it takes the key as a runtime argument from the caller's environment (`process.env.GEMINI_API_KEY`). It must never log or persist the key, and it redacts it from every error and trace (`src/testing/redact.ts`). Do not import `src/testing/` from the browser library, and do not import React, the DOM or Firebase into it: `scripts/check-testing-entry.mjs` (part of `build:lib`) fails the build if the testing entry pulls in anything but `@google/genai` and `node:` built-ins.

## Live models

- `src/services/liveModels.ts` is the only place a Gemini Live model id is recorded. `DEFAULT_LIVE_MODEL` lives there. Before changing it, verify the id against the provider docs (they now live at https://aistudio.google.com/docs/models and `/docs/deprecations`; every page is available as Markdown by appending `.md`) and run `npm run test:live`.
- `src/services/liveConnectConfig.ts` (`buildLiveConnectConfig`) builds the config passed to `ai.live.connect`. `useSession` and the test kit both call it. Do not build a Live config anywhere else.
- `src/__tests__/noRetiredModels.test.ts` fails if a legacy or shut-down id appears outside the registry.
- A change to the registry, the builder or the hook's connect path is not done until `npm run test:live` passes against the real API (see TESTING.md for how to supply the key at run time).
- `useSession`'s message handling is tested by replaying REAL recorded traces (`src/__tests__/fixtures/live-traces/`, replayed by `src/__tests__/hooks/useSession.replay.test.ts`). Do not hand-edit a trace or write one by hand to make a test pass: re-record with `scripts/capture-live-traces.mjs`. If a fresh recording changes the ORDER of events, the provider changed; update the registry and the hook, not the assertion.
- `turnComplete` does not mean "the bot has finished answering" (see `toolCallEndsTurnEarly` and `idleSignal` in the registry). Nothing in the hook may assume it does.

## After any material change

Before considering a task complete, ensure all of the following are done:

1. **Tests** — verify tests exist for the changed behavior and all tests pass:
   ```bash
   npm test -- --run
   ```
2. **Docs** — update `design.md` if architecture, data model, or data flow changed
3. **Commit** — commit all changed files with a descriptive message
4. **Push** — push to `origin/main`

## Dev commands

```bash
npm test -- --run          # run all offline tests once
npm run test:watch         # watch mode
npm run test:live          # LIVE suite against the real Gemini Live API; skips without GEMINI_API_KEY
npx tsc --noEmit           # type-check only
npm run lint               # lint (runs ESLint against the TS 6 API; see scripts/eslint-ts6-shim.cjs)
npm run build:lib          # library build + bundle secret scan + testing-entry check

firebase deploy --only functions
firebase deploy --only firestore:rules,storage
```

## Architecture notes

### Flat session data model
Sessions are stored at `sessions/{sessionId}` — a flat top-level collection keyed on the Firestore-generated session ID. Access control is by `userId` field. Transcripts are stored as a subcollection at `sessions/{sessionId}/transcript/entries`.

### Audio archival path
Session audio is stored in Cloud Storage at `sessions/{userId}/{sessionId}.webm`. Storage rules enforce that only the owning user can read or write.

### Tool integrations
Knowledge tools (weather, maps, jokes, Wikipedia, date/time) live in the sibling `@andyfooblah/knowledge-common` package, not in this repo. VoiceCommon itself ships no built-in tools (`allTools` in `src/services/gemini.ts` is an empty legacy export); consumers pass `FunctionDeclaration`s via `useSession`'s `tools` option and dispatch them in `onToolCall`. The `endSession` tool is always injected automatically.

### ESLint config
Flat config (`eslint.config.js`). Notable intentional rule overrides:
- `no-console: 'off'` — used throughout for logging
- `react-hooks/set-state-in-effect: 'off'` — intentional pattern in this codebase
- `@typescript-eslint/no-explicit-any: 'off'` — scoped to test/mock files only

### License headers
All source files carry an Apache 2.0 header (Copyright 2026 Andrew Brook). Add the header to any new `.ts`, `.tsx`, or `.js` file:
```
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
```
