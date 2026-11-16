# VoiceCommon

`@andyfooblah/voice-common` — a reusable framework for building voice AI web applications powered by Google Gemini Live and Firebase. See [CHANGELOG.md](CHANGELOG.md) for the current version and release history.

> **Origin:** VoiceCommon was started as a way to extract reusable common functionality from [LegacyBot](https://github.com/AndyFooBlah/LegacyBot), a voice-first life story preservation app. The patterns for real-time voice sessions, transcript archival, audio recording, and AI tool integrations have been generalized here into a clean framework that any voice AI app can build on.

Knowledge tools (weather, maps, jokes, Wikipedia, date/time) are provided separately by [`@andyfooblah/knowledge-common`](https://github.com/AndyFooBlah/KnowledgeCommon).

---

## What VoiceCommon provides

- **Gemini Live integration** — real-time bidirectional voice sessions with Google's Gemini Live API, including PCM audio streaming, bot audio playback scheduling, and connection lifecycle management
- **Firebase authentication** — Google OAuth and email/password sign-in, with user profile creation in Firestore
- **Session archival** — automatic recording of mixed user+bot audio to Cloud Storage (WebM/Opus), real-time transcript sync to Firestore
- **Session resumption with continuous recording** — on unexpected disconnect (the Live API's ~10-min connection resets, transient errors), the session is resumed via Gemini session-resumption handles with full conversation context (no re-greeting). The archival recorder is never restarted, so the recording stays one continuous file. If resumption fails 3 times in a row — or the recorder itself fails — the session halts and finalizes the recording captured so far rather than continuing unrecorded (see `design.md` §3.4)
- **Repetition detection** — detects near-duplicate bot turns and sends a recovery prompt to break the loop
- **Live model registry with safe defaults** — sessions default to the current Live model (`gemini-3.8-live`), and a model/thinking-level combination the provider is known to reject fails with a clear error before connecting instead of a dead WebSocket
- **Live conformance kit** — a headless Node test kit (`@andyfooblah/voice-common/testing`) that checks an app's real Live configuration against the real Gemini Live API. See [TESTING.md](TESTING.md)
- **Example application** — a working 3-page app (login, session history, new session) demonstrating the full framework

---

## Example app pages

| Route | Page | Description |
|-------|------|-------------|
| `/` | → `/sessions` | Redirect |
| `/sessions` | Session History | List of past voice sessions with status and duration |
| `/sessions/new` | New Session | Live voice session with real-time transcript and waveform |
| `/sessions/:id` | Transcript Viewer | Past session transcript and audio playback |

---

## Getting started

### Prerequisites

- Node.js 22+
- A Firebase project (Firestore, Authentication, Cloud Storage enabled)
- A Google Gemini API key from [Google AI Studio](https://aistudio.google.com) — held **server-side only**, behind your token broker (see below)
- (Optional) A Google Maps API key for weather and location tools

### 1. Clone and install

```bash
git clone https://github.com/AndyFooBlah/VoiceCommon.git voicecommon
cd voicecommon
npm install
```

All dependencies — including [`@andyfooblah/knowledge-common`](https://github.com/AndyFooBlah/KnowledgeCommon) — resolve from npmjs.org; no sibling checkouts or tokens required.

> **Iterating on KnowledgeCommon locally?** Check it out anywhere, run `npm link` in it, then `npm link @andyfooblah/knowledge-common` here to use your local copy instead of the published version.

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your Firebase web-app config (apiKey, projectId, …) only.
# There is NO Gemini key in .env: Gemini access goes through the `tokenProvider`
# you pass to useSession — a server-side broker that mints short-lived Gemini
# Live tokens. `.env` and `.env.*` are gitignored (only .env.example is tracked).
```

### 3. Set up Firebase

```bash
cp .firebaserc.example .firebaserc
# Edit .firebaserc with your Firebase project ID
firebase deploy --only firestore:rules,storage
```

### 4. Run the dev server

```bash
npm run dev
```

---

## Building your own app on VoiceCommon

### Installation

```bash
npm install @andyfooblah/voice-common
```

### Initialization

Call `initializeVoiceCommon` once at app startup before mounting React:

```typescript
import { initializeVoiceCommon } from '@andyfooblah/voice-common';

initializeVoiceCommon({
  firebase: {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  },
  // Required. VoiceCommon never accepts a long-lived Gemini API key —
  // the long-lived key would end up in your bundle, which is the exact
  // failure mode this library is designed to prevent. Implement
  // tokenProvider as a thin wrapper around your own server-side broker
  // (e.g. a Firebase Cloud Function that holds GEMINI_API_KEY in Secret
  // Manager and returns a single-use ephemeral token via Gemini's
  // authTokens.create API). It's invoked once per Live session opening.
  tokenProvider: async () => {
    const result = await myMintGeminiLiveTokenCallable();
    return result.data; // { token: string, expireTime: string }
  },
});
```

> **Note:** the `geminiApiKey?: string` field that earlier versions
> accepted was deleted in 0.6.0. Even as a "local dev" fallback it
> caused keys to ship in consumers' bundles by accident — the same
> incident pattern that motivated the broker design in the first
> place. See `design.md` §5 for the full rationale and `CLAUDE.md`
> for the type-system + ESLint + post-build-scan guards that enforce
> this at compile and build time.

### The token broker

`tokenProvider` calls a server-side function of yours that holds `GEMINI_API_KEY` and mints a single-use ephemeral token. A minimal broker (for example a Firebase callable):

```typescript
import { GoogleGenAI } from '@google/genai';

// Server side only. GEMINI_API_KEY comes from Secret Manager.
export async function mintGeminiLiveToken(apiKey: string) {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
  const now = Date.now();
  const expireTime = new Date(now + 30 * 60_000).toISOString();
  const token = await ai.authTokens.create({
    config: {
      uses: 1,                                                    // one Live session
      expireTime,                                                 // session lifetime
      newSessionExpireTime: new Date(now + 60_000).toISOString(), // window to connect
    },
  });
  return { token: token.name!, expireTime }; // GeminiLiveToken
}
```

`useSession` opens the Live WebSocket with that token on API version `v1alpha` (`LIVE_API_VERSION`). A token minted on `v1alpha` or `v1beta` connects on either version: all four combinations are checked by the live suite. The provider's guide now shows `v1beta` while the SDK still asks for `v1alpha` for ephemeral tokens; if that ever needs to change in your app before a library release, pass `liveApiVersion` to `useSession`.

### Choosing a Live model

By default a session uses `DEFAULT_LIVE_MODEL` (`gemini-3.8-live`) and `thinkingLevel: 'auto'`, which sends the right `thinkingConfig` for the model. Most apps should pass neither option.

```typescript
import { ThinkingLevel } from '@google/genai';
import { useSession } from '@andyfooblah/voice-common';

useSession({ userId, systemInstruction });                          // gemini-3.8-live
useSession({ userId, systemInstruction,
             liveModel: 'gemini-3.8-live-extended-thinking' });     // 'auto' sends LOW
useSession({ userId, systemInstruction,
             liveModel: 'gemini-3.8-live-extended-thinking',
             thinkingLevel: ThinkingLevel.HIGH });                  // explicit level
```

The Live models disagree about `thinkingConfig`, and the provider reports a mismatch by closing the WebSocket with code 1007 during setup, which looks like a connection fault:

| Model | Status | `thinkingConfig` | `'auto'` sends |
|---|---|---|---|
| `gemini-3.8-live` | current, default | rejected (every level) | nothing |
| `gemini-3.8-live-extended-thinking` | current | required; MINIMAL rejected | LOW |
| `gemini-3.1-flash-live-preview` | legacy (replacement: `gemini-3.8-live`) | optional | MINIMAL |

`LIVE_MODELS` is the registry behind this table (`src/services/liveModels.ts`). An explicit `thinkingLevel` the registry knows the model rejects fails the session start with a `LiveConfigError` that names the model, the value and the fix, before any connection is made. A model id the registry does not know is never blocked: `'auto'` omits the field and an explicit level is passed through.

#### What the models do differently around tool calls

The hook keeps one behaviour for your app across these; the differences matter only if you read raw Live events yourself.

| | `gemini-3.8-live` | `gemini-3.8-live-extended-thinking` | `gemini-3.1-flash-live-preview` |
|---|---|---|---|
| Tool calls | asynchronous by default | asynchronous only | blocking |
| `turnComplete` after a `toolCall` | arrives at once, **before** the spoken reply; the reply is a further turn | not between call and reply (a filler sentence and its `turnComplete` come before the call) | once, after the reply |
| "Finished answering" signal | `turnComplete` | `interactionStatus: IDLE` | `turnComplete` |

**What you get in the transcript.** One entry per thing that happened, in order: what the bot said before a tool call (if anything), the tool entry (written when the tool finishes, with its duration), then one bot entry holding the whole spoken answer. A filler sentence and the answer are deliberately two entries with the tool between them, not merged: that is the order they were spoken in. A tool entry is still written for a tool whose result was not sent because the user interrupted.

**Extended thinking.** `gemini-3.8-live-extended-thinking` is supported for: session setup with `'auto'` thinking, transcripts (the filler and the answer are separate entries), tool calls (a `behavior: BLOCKING` declaration is refused before connecting), ending the session and the greeting mute (both wait for `IDLE`), and `onInteractionStatus`. The hook has no "thinking" state of its own beyond that callback, and no app in this family runs on this model yet; its behaviour is checked by the live suite and by replayed recordings, not by production use.

If your app has a code path that calls `ai.live.connect` directly, build its config with `buildLiveConnectConfig(params)` (exported from the main entry and from `/testing`) so it gets the same validation and stays covered by your live test.

### Testing your app against the real Live API

The `/testing` entry is a Node-only kit: it imports `@google/genai` and Node built-ins, never React or Firebase. A whole-app live test is about twenty lines:

```typescript
// @vitest-environment node
// tests/live/conformance.live.test.ts — excluded from the normal `npm test`
import { describe, it } from 'vitest';
import {
  runLiveConformance, assertLiveConformance, formatLiveConformanceReport,
} from '@andyfooblah/voice-common/testing';
import { LIVE_MODEL, buildInstruction, appTools } from '../../src/services/gemini';

const apiKey = process.env.GEMINI_API_KEY;

describe.skipIf(!apiKey)('live conformance', () => {
  it('the production Live configuration works against the real API', async () => {
    const report = await runLiveConformance(
      { name: 'my-app', model: LIVE_MODEL, systemInstruction: buildInstruction(), tools: appTools },
      { apiKey: apiKey!, toolProbe: { prompt: 'What is the weather in Paris?', expectTool: 'getWeather', result: 'Sunny, 18 C.' } },
    );
    console.log(formatLiveConformanceReport(report));
    assertLiveConformance(report);
  }, 600_000);
});
```

[TESTING.md](TESTING.md) describes every check, the speech fixtures, costs, and how to keep the key out of the browser bundle and out of logs.

### Custom system instruction

Replace the default assistant with your own by calling `buildSessionInstruction` with your own `assistantName` and `appContext`:

```typescript
import { buildSessionInstruction } from '@andyfooblah/voice-common';

const instruction = buildSessionInstruction({
  assistantName: 'Nova',
  appContext: 'You are a customer service agent for Acme Corp...',
  currentDateTime: new Date().toLocaleString(),
});
```

Or skip `buildSessionInstruction` entirely and pass your own string directly to `useSession`.

### Custom tools

Add tools alongside knowledge tools, or replace them:

```typescript
import { useSession } from '@andyfooblah/voice-common';
import { allKnowledgeTools } from '@andyfooblah/knowledge-common';
import type { FunctionDeclaration } from '@google/genai';

const myTool: FunctionDeclaration = {
  name: 'lookupOrder',
  description: 'Look up a customer order by order number.',
  parameters: { ... },
};

const { startSession, stopSession, messages } = useSession({
  userId: user.uid,
  systemInstruction: myInstruction,
  tools: [...allKnowledgeTools, myTool],
  onToolCall: async (name, args) => {
    if (name === 'lookupOrder') return lookupOrder(args.orderNumber);
    return 'Unknown tool.';
  },
});
```

Note: the `endSession` tool is always injected automatically by VoiceCommon — do not declare it yourself.

### Post-session processing

The `onSessionCompleted` Cloud Function in `functions/src/index.ts` fires whenever a session transitions to `completed`. Add your own server-side logic there — transcript analysis, notifications, summaries, webhooks, etc.

---

## `useSession` API reference

```typescript
import { useSession } from '@andyfooblah/voice-common';
```

### `UseSessionOptions`

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `userId` | `string` | Yes | Firebase Auth UID of the session owner |
| `systemInstruction` | `string` | Yes | Full system instruction string for Gemini |
| `tools` | `FunctionDeclaration[]` | No | Tool declarations to register with Gemini |
| `onToolCall` | `(name, args) => Promise<string>` | No | Called when Gemini invokes a tool; return value is sent as the tool result |
| `onSessionEndRequest` | `() => void` | No | Called when the bot has invoked the built-in `endSession` tool **and its goodbye has finished playing** (since 0.16.1; capped at 12 s). It is safe to call `stopSession()` straight from it |
| `onSessionEnd` | `() => void` | No | Called after the session is fully finalized (audio uploaded, Firestore updated). Use for post-session analysis or state cleanup |
| `onBotSpeaking` | `(speaking: boolean) => void` | No | Called when bot audio starts or stops (for UI feedback). `false` means playback has drained and the reply is fully generated, so it does not flicker between audio chunks |
| `onInteractionStatus` | `(status: string) => void` | No | Called when the model reports `interactionStatus` (`'IN_PROGRESS'` / `'IDLE'`). Only `gemini-3.8-live-extended-thinking` does. Use it for a "thinking" indicator |
| `autoGreetText` | `string` | No | Text sent via `sendRealtimeInput` immediately after connecting so the bot takes the first turn. Use bracket notation for system cues, e.g. `"[Session started. Please greet the family.]"` |
| `speechConfig` | `SpeechConfig` | No | Voice configuration for the Gemini model (e.g. prebuilt voice name). Passed directly to the Gemini Live `speechConfig` field |
| `endOfSpeechSilenceMs` | `number` | No | How long a pause the user may take before their turn ends. In server-VAD mode maps to `automaticActivityDetection.silenceDurationMs`; in manual mode it's the client-side end-of-turn silence. |
| `endOfSpeechSensitivity` | `'HIGH' \| 'LOW'` | No | Server-VAD end-of-speech eagerness. `'HIGH'` (default) ends turns quickly; `'LOW'` waits through longer pauses. Ignored in manual mode. |
| `manualTurnControl` | `boolean` | No | When true, disable server VAD and drive turn boundaries with a client-side energy VAD (patient, and robust to room noise retriggering server VAD). Default false. |
| `liveModel` | `string` | No | Gemini Live model id. Default `DEFAULT_LIVE_MODEL` (`'gemini-3.8-live'`). See "Choosing a Live model" |
| `thinkingLevel` | `ThinkingLevel \| 'none' \| 'auto'` | No | Default `'auto'`: derived from the model. `'none'` omits `thinkingConfig`. An explicit level the model is known to reject fails the start with a `LiveConfigError` |
| `liveApiVersion` | `string` | No | API version for the Live WebSocket. Default `LIVE_API_VERSION` (`'v1alpha'`) |
| `sessionsCollection` | `string` | No | Firestore collection path for session documents. Default: `'sessions'`. For nested/scoped sessions, use a path like `'families/{familyId}/dossiers/{dossierId}/sessions'` |

### `UseSessionReturn`

| Property | Type | Description |
|----------|------|-------------|
| `messages` | `Message[]` | Live transcript messages for the current session |
| `connectionStatus` | `ConnectionStatus` | `DISCONNECTED \| CONNECTING \| CONNECTED \| ERROR` |
| `startSession(overrideInstruction?, overrideAutoGreetText?)` | `() => Promise<void>` | Start a new session. Optional overrides bypass stale-closure issues when instruction or greet text is built just before calling |
| `stopSession` | `() => Promise<void>` | Stop the session, upload audio, finalize Firestore document, call `onSessionEnd` |
| `isRecording` | `boolean` | True while a session is active |
| `sessionId` | `string \| null` | Firestore session document ID for the current session |
| `error` | `string \| null` | Human-readable error message if status is `ERROR` |

### `sessionsCollection` example

An app with family-scoped data might use nested session paths:

```typescript
useSession({
  userId: user.uid,
  systemInstruction,
  sessionsCollection: `families/${familyId}/dossiers/${dossierId}/sessions`,
  // ...
});
```

All VoiceCommon storage calls (create, finalize, transcript sync) use this prefix automatically.

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

---

## Releasing

Releases are published to npmjs.org by `.github/workflows/publish.yml` using
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) —
no npm token is stored in the repo or in GitHub secrets, and every publish
carries provenance.

**One-time setup on npmjs.com (package owner only):**

1. Sign in to <https://www.npmjs.com/> and open
   <https://www.npmjs.com/package/@andyfooblah/voice-common/access>
   (Package → *Settings* → *Trusted Publishing*).
2. Under *Trusted Publisher*, choose **GitHub Actions** and enter:
   - Organization or user: `AndyFooBlah`
   - Repository: `VoiceCommon`
   - Workflow filename: `publish.yml`
   - Environment name: *(leave blank)*
3. Save. From then on any run of `publish.yml` from this repo can publish;
   nothing else can (no token exists to leak).

If the very first tagged run failed with `ENEEDAUTH`/`E404` before this was
configured, re-run that workflow run from the Actions tab after step 3.

**Cutting a release:**

```bash
# 1. bump "version" in package.json, add a CHANGELOG.md entry, commit + push
# 2. publish a GitHub Release; this creates the vX.Y.Z tag and is the ONLY
#    thing that triggers the workflow (a bare `git push --tags` does not)
gh release create vX.Y.Z --generate-notes
# 3. confirm
npm view @andyfooblah/voice-common version
```

The workflow refuses a release whose tag does not match `package.json`, and
skips the publish step (green, not red) when that version is already on npm,
so re-running a release is safe. Every released version has a matching
annotated `vX.Y.Z` tag (back-filled for 0.5.0–0.14.0).

---

## Live contract canary

`.github/workflows/live-contract.yml` runs `npm run test:live` against the real Gemini Live API, on demand (`workflow_dispatch`) and every Monday. It checks the default model's full conformance list, the turn-taking presets, and whether each model in the registry still accepts and rejects what the registry says. A failure opens one issue assigned to the repository owner (or comments on the open one); a later pass closes it.

**It is off by default.** It is a paid-API test, so the workflow skips cleanly (green, with a notice) until the repository secret `LIVE_TEST_GEMINI_API_KEY` exists. A run costs a few US cents. To turn it on, once:

```bash
# Use a key created for this purpose, ideally restricted to the Generative
# Language API, so it can be rotated or revoked on its own.
gh secret set LIVE_TEST_GEMINI_API_KEY --repo AndyFooBlah/VoiceCommon
# paste the key at the prompt; it is never echoed
gh workflow run live-contract.yml --repo AndyFooBlah/VoiceCommon
```

To turn it off again: `gh secret delete LIVE_TEST_GEMINI_API_KEY --repo AndyFooBlah/VoiceCommon`.

Run the same suite locally with `GEMINI_API_KEY=... npm run test:live`. See [TESTING.md](TESTING.md).

---

## Project structure

```
src/
├── services/
│   ├── firebase.ts          # Firebase app initialization
│   ├── gemini.ts            # Gemini Live session instruction builder + tool registry
│   ├── liveModels.ts        # Live model registry, DEFAULT_LIVE_MODEL, resolveThinkingConfig (pure)
│   ├── liveConnectConfig.ts # buildLiveConnectConfig: the config passed to live.connect (pure)
│   ├── storage.ts           # Firestore + GCS session/transcript persistence
│   └── audioUtils.ts        # PCM encoding, decoding, resampling
├── hooks/
│   ├── useAuth.ts           # Firebase auth state + sign-in/sign-out
│   ├── useSession.ts        # Live session lifecycle (start, stream, stop, archive)
│   └── useAudioMixer.ts     # Microphone + bot audio mixing for archival
├── components/
│   ├── auth/
│   │   └── LoginScreen.tsx  # Login page (Google + email/password)
│   ├── session/
│   │   ├── SessionView.tsx  # New session page
│   │   ├── TranscriptFeed.tsx  # Real-time transcript display
│   │   └── Visualizer.tsx   # Animated waveform
│   ├── history/
│   │   ├── SessionList.tsx  # Session history page
│   │   ├── TranscriptViewer.tsx  # Past session detail
│   │   └── AudioPlayer.tsx  # Audio playback with seek bar
│   └── shared/
│       ├── Layout.tsx       # App shell with nav and auth guard
│       ├── ErrorBoundary.tsx
│       └── Logo.tsx
├── testing/                 # '@andyfooblah/voice-common/testing': Node-only live conformance kit
│   ├── LiveTestSession.ts   # Headless Live client with a typed event trace
│   ├── checks.ts            # Named conformance checks and provider-contract canaries
│   ├── conformance.ts       # runLiveConformance(profile, options)
│   └── fixtures.ts          # Loader for fixtures/speech/*.wav
├── __tests__/
│   └── live/                # *.live.test.ts — real API, `npm run test:live` only
├── types.ts                 # Core TypeScript interfaces
└── App.tsx                  # Router

fixtures/
└── speech/                  # Committed synthetic speech (16 kHz WAV) + manifest.json

scripts/
├── gen-speech-fixtures.mjs  # One-off generator for fixtures/speech (Gemini TTS)
├── check-bundle-for-secrets.mjs
├── check-testing-entry.mjs  # Proves dist/testing.js loads in plain Node
└── summarize-live-results.mjs

functions/
└── src/
    └── index.ts             # Cloud Functions (onSessionCompleted hook)

public/
└── pcm-processor.js         # AudioWorklet for low-latency PCM streaming
```

---

## Firestore data model

#### `users/{uid}`

| Field | Type | Description |
|-------|------|-------------|
| `email` | `string` | User's email address |
| `displayName` | `string` | Display name from auth provider |
| `createdAt` | `Timestamp` | Account creation time |
| `timezone` | `string?` | IANA timezone (e.g. `"America/Los_Angeles"`), set from browser |

#### `sessions/{sessionId}`

| Field | Type | Description |
|-------|------|-------------|
| `userId` | `string` | Firebase UID of the session owner |
| `startTime` | `Timestamp` | When the session started |
| `endTime` | `Timestamp \| null` | When the session ended; null while active |
| `audioUrl` | `string` | GCS download URL for the archived audio (empty until upload completes) |
| `status` | `"active" \| "completed" \| "interrupted"` | Session lifecycle state |
| `durationSeconds` | `number` | Total session duration |

#### `sessions/{sessionId}/transcript/entries`

A single document with an `entries` array, written in full on each sync:

```
{ entries: TranscriptEntry[] }
```

Each `TranscriptEntry`:

| Field | Type | Description |
|-------|------|-------------|
| `role` | `"user" \| "bot" \| "tool"` | Who produced this turn |
| `text` | `string` | Transcript text, or `[toolName]` for tool turns |
| `timestamp` | `Timestamp` | When this turn was recorded |
| `messageIndex` | `number?` | 0-based position in the session |
| `toolName` | `string?` | Present when `role === "tool"` |
| `toolArgs` | `Record<string, unknown>?` | Arguments passed to the tool |
| `toolResult` | `string?` | Truncated tool result (≤ 500 chars) |

## Cloud Storage layout

```
sessions/{userId}/{sessionId}.webm    # Session audio (mixed, WebM/Opus 128kbps)
```

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS v4 |
| AI | Google Gemini Live API (`@google/genai`) |
| Auth | Firebase Authentication |
| Database | Cloud Firestore |
| Storage | Firebase Cloud Storage |
| Backend | Firebase Cloud Functions v2 (Node.js 22) |
| Testing | Vitest, React Testing Library; live conformance kit for the Gemini Live API |
| CI | GitHub Actions |

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
