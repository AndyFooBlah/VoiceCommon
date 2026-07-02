# Technical Design Document: VoiceCommon

## 1. System Architecture

VoiceCommon is a single-page React application (Vite + TypeScript) backed by Firebase. The frontend handles the entire session lifecycle — audio capture, Gemini Live streaming, transcript sync — without a custom backend. Firebase Cloud Functions provide an extensible hook for server-side post-session processing.

```
┌──────────────────────────────────────────────┐
│                  Browser                      │
│                                               │
│  React SPA (Vite + TypeScript + Tailwind)     │
│  ├── useSession hook                          │
│  │   ├── AudioWorklet (PCM → Gemini Live)     │
│  │   ├── AudioContext (bot audio playback)    │
│  │   └── MediaRecorder (mixed audio archive)  │
│  └── Firebase SDK                             │
│      ├── Auth                                 │
│      ├── Firestore                            │
│      └── Storage                             │
└──────────┬───────────────┬────────────────────┘
           │               │
    ┌──────┴──────┐  ┌──────┴──────┐
    │  Gemini     │  │  Firebase   │
    │  Live API   │  │  (Auth +    │
    │  (Google)   │  │  Firestore  │
    └─────────────┘  │  + Storage) │
                     └──────┬──────┘
                            │ Firestore trigger
                     ┌──────┴──────────────┐
                     │  Cloud Functions    │
                     │  onSessionCompleted │
                     └─────────────────────┘
```

---

## 2. Data Model

### Firestore

#### `users/{uid}`
Created on first login.

```typescript
{
  email: string;
  displayName: string;
  createdAt: Timestamp;
  timezone?: string;         // IANA timezone, set from browser
}
```

#### `sessions/{sessionId}`
One document per voice session.

```typescript
{
  userId: string;            // Firebase UID of the session owner
  startTime: Timestamp;
  endTime: Timestamp | null;
  audioUrl: string;          // GCS download URL (empty until upload completes)
  status: 'active' | 'completed' | 'interrupted';
  durationSeconds: number;
}
```

#### `sessions/{sessionId}/transcript/entries`
Single document holding the full transcript array for the session.

```typescript
{
  entries: TranscriptEntry[];
}
```

Each `TranscriptEntry`:

```typescript
{
  role: 'user' | 'bot' | 'tool';
  text: string;
  timestamp: Timestamp;
  messageIndex?: number;       // 0-based position
  toolName?: string;           // present when role === 'tool'
  toolArgs?: Record<string, unknown>;
  toolResult?: string;         // truncated to 500 chars
}
```

### Cloud Storage

```
sessions/{userId}/{sessionId}.webm    # Mixed session audio (WebM/Opus 128kbps)
```

---

## 3. Session Lifecycle

### 3.1 Start

1. `useSession.startSession()` is called.
2. A new Firestore session document is created with `status: 'active'`.
3. `useAudioMixer.startMixer()` initializes the microphone stream and MediaRecorder.
4. `AudioContext` is created for bot audio playback (24kHz).
5. `GoogleGenAI.live.connect()` opens a WebSocket to the Gemini Live API with the session's system instruction and tool declarations.
6. An `AudioWorkletNode` (pcm-processor.js) starts streaming 16kHz PCM chunks from the microphone to Gemini via `sendRealtimeInput`.

### 3.2 During

**User speech:**
- The AudioWorklet captures microphone samples and sends PCM16 at 16kHz to Gemini.
- **Greeting echo mute:** when a session auto-greets, mic audio is *not* forwarded to Gemini until the opening greeting has finished playing (`micSendEnabledRef`, released in the bot-audio `onended` drain, with a `GREETING_MUTE_MAX_MS` safety cap). Speaker→mic echo of the greeting would otherwise trip the server VAD and make the native-audio model restart its greeting (the "double greeting"). The mute applies only on the initial greeting connect, not on resume. Archival recording is unaffected — the mixer captures the mic on a separate audio graph.
- Gemini returns input transcription events. These arrive in many small chunks, which are **accumulated into a single user turn** — one live-updating message bubble (so the storyteller's words stream in as they speak) and, when the turn seals, one consolidated transcript entry. A user turn seals when the bot begins responding (its first audio or output-transcription chunk), on barge-in, or on stop. This mirrors the bot-turn accumulation (`appendBotChunk`/`sealBotTurn`) with `appendUserChunk`/`sealUserTurn`.
- Turn-taking has two modes:
  - **Server VAD (default):** Gemini's automatic activity detection (`realtimeInputConfig.automaticActivityDetection`). Start-of-speech sensitivity is HIGH (quick to yield when the user starts). `endOfSpeechSensitivity` is configurable (`'HIGH'` default, `'LOW'` = less eager to end the user's turn). `endOfSpeechSilenceMs` maps to `silenceDurationMs`. Note: the native-audio model (`gemini-3.1-flash-live-preview`) largely ignores large `silenceDurationMs` values, so server VAD cannot enforce a multi-second patient wait.
  - **Manual turn control (`manualTurnControl: true`):** disables server VAD (`automaticActivityDetection.disabled`) and drives turn boundaries from a client-side energy VAD in the mic frame handler. It sends `activityStart` on sustained speech and holds `activityEnd` until `endOfSpeechSilenceMs` of continuous silence, so the bot waits patiently through pauses. An adaptive noise floor plus a re-trigger threshold (`VAD_RETRIGGER_MS`) keep transient background-noise blips from restarting the wait. Barge-in is preserved with a stricter threshold while the bot is speaking; the mic requests `echoCancellation`/`noiseSuppression`/`autoGainControl` so bot playback doesn't trip detection.
  - All of these options are held in refs so mid-session changes apply on the next (re)connect. The resolved config is logged at connect (`[Session] VAD: …`).

**Bot response:**
- Gemini returns `inlineData` audio parts (PCM at 24kHz) which are scheduled on the AudioContext for continuous playback.
- Gemini returns text parts which accumulate into a bot turn until `turnComplete`.
- On `turnComplete`, the bot turn is flushed to the Firestore transcript.

**Tool calls:**
- Gemini emits `toolCall` events with function name and arguments.
- The `onToolCall` callback dispatches to the appropriate tool implementation.
- The result is sent back via `sendToolResponse`.
- The tool call is recorded in the transcript.

**Session end tool:**
- Gemini may call `endSession` when the user signals they want to stop.
- This triggers `onSessionEndRequest`, which calls `stopSession()`.

### 3.3 Stop

1. Gemini Live WebSocket is closed.
2. AudioContext is closed.
3. `useAudioMixer.stopMixer()` stops the MediaRecorder and returns the audio blob.
4. The audio blob is uploaded to `sessions/{userId}/{sessionId}.webm` in Cloud Storage.
5. The session document is updated: `status: 'completed'`, `endTime`, `durationSeconds`, `audioUrl`.
6. The `onSessionCompleted` Cloud Function fires and runs any configured post-processing.

### 3.4 Reconnection & error handling

The Live API caps a **connection at ~10 min** and an **audio session at ~15 min** (without compression), so long interviews *will* be disconnected. The session must survive that without losing the conversation or the recording.

**Session resumption (the reconnect mechanism).** `connect` enables `sessionResumption: {}` and `contextWindowCompression: { slidingWindow: {} }`. The server issues `sessionResumptionUpdate` messages with a `newHandle`, which we store. On an **unexpected disconnect** (an `onclose` that isn't an intentional stop), `resumeConnection` reconnects with `sessionResumption: { handle }` — resuming the **same** session with full context (no re-greeting). Context-window compression lets the session run past the 15-min cap.

**Continuous recording — the critical invariant.** On resume we re-establish only the Gemini WebSocket and the mic→PCM input worklet. We deliberately **do NOT stop or restart the mixer**, so the archival `MediaRecorder` runs continuously for the whole interview and produces **one file, uploaded once** at the end.

> Historical note: an earlier auto-reconnect flushed/cleared the recorder, uploaded a partial blob, and restarted the mixer; the post-reconnect segment was then uploaded to the *same* storage path, **overwriting** the first — silently losing the opening minutes. The PCM worklet's `addModule` is now registered once per AudioContext (the input context persists across resumes), keeping recording continuous.

**Halt conditions (recording integrity).** An interview must never continue unrecorded. The session halts — finalizing the complete recording once, then `connectionStatus = ERROR` with a user-facing `error` — if resumption fails `MAX_RESUME_FAILURES` (3) times in a row, or if the `MediaRecorder` fails to enter the recording state at start or emits `onerror` mid-session (`useAudioMixer.start(onRecordingError)`).

---

## 4. Audio Pipeline

### Microphone capture

```
Microphone → MediaStream → AudioContext (16kHz)
           → AudioWorkletNode (pcm-processor.js)
           → postMessage Float32Array chunks
           → encode() → Int16Array
           → Gemini Live sendRealtimeInput
```

### Bot playback

```
Gemini Live inlineData PCM → Int16Array → Float32Array
                           → AudioBuffer (24kHz)
                           → AudioBufferSourceNode
                           → scheduled on AudioContext
```

Audio chunks are scheduled sequentially using a `scheduleTime` cursor. If the lookahead exceeds 30 seconds (runaway loop), the cursor is reset and the current chunk is dropped.

### Mixed recording (archival)

`useAudioMixer` routes both the microphone stream and the bot audio through a Web Audio mixing graph into a `MediaRecorder`. The result is a single WebM/Opus file capturing the full conversation.

---

## 5. Security

### Firestore rules

- `users/{uid}`: read/write only by the owning user (UID match)
- `sessions/{sessionId}`: create requires `userId == request.auth.uid`; read/update requires the document's `userId` to match the caller
- `sessions/{sessionId}/transcript/entries`: access mirrors the parent session

### Storage rules

- `sessions/{userId}/{allPaths}`: read/write only by `request.auth.uid == userId`

### Gemini API key handling

VoiceCommon **never** accepts a long-lived Gemini API key. The only sanctioned auth path is `tokenProvider`:

```ts
initializeVoiceCommon({
  firebase: { /* ... */ },
  tokenProvider: async () => {
    // Call your own Cloud Function (which holds GEMINI_API_KEY in Secret
    // Manager and uses ai.authTokens.create to mint a single-use token).
    const result = await myMintGeminiLiveTokenCallable();
    return result; // { token: string, expireTime: string }
  },
});
```

`tokenProvider` is required by `VoiceCommonConfig` and called once per Live session opening. `useSession` uses the returned ephemeral token as the `apiKey` passed to `GoogleGenAI`; the long-lived key never reaches the browser.

The earlier `geminiApiKey?: string` field has been **removed** in 0.6.0 — even as a "local dev only" fallback it allowed key-bundling-by-accident, which is the exact incident pattern that triggered this redesign in the first place. Local dev that needs Gemini Live must implement a `tokenProvider`; the demo app in `src/index.tsx` ships a placeholder that throws an explanatory error so a missing broker fails loudly at session start instead of silently shipping a key.

---

## 6. Built-in Tools

Each tool in `src/services/tools/` exports:
- A `FunctionDeclaration` for registration with the Gemini Live API
- An async implementation function

| Module | Tool name | External API |
|--------|-----------|-------------|
| `weather.ts` | `getWeather` | Google Maps Weather API |
| `maps.ts` | `searchPlace` | Google Maps Geocoding API |
| `maps.ts` | `getDistanceBetweenPlaces` | Google Maps Geocoding API |
| `jokes.ts` | `getJoke` | JokeAPI (jokeapi.dev) |
| `wikipedia.ts` | `searchWikipedia` | Wikipedia REST API |

All tools return plain strings. The AI uses these strings to compose natural voice responses rather than reading them verbatim.

---

## 7. Extending VoiceCommon

### Custom system instruction

`buildSessionInstruction(options)` in `src/services/gemini.ts` returns a generic instruction string. Applications can:
- Pass custom `assistantName` and `appContext` to `buildSessionInstruction`
- Replace `buildSessionInstruction` entirely with their own function
- Inject any string as `systemInstruction` in `useSession`

### Custom tools

Pass additional `FunctionDeclaration` objects in the `tools` array to `useSession`, and handle their calls in `onToolCall`. The built-in `allTools` array can be spread alongside custom tools.

### Post-session processing

Edit `functions/src/index.ts` → `onSessionCompleted` to add server-side logic triggered after each session completes.
