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
- Gemini returns input transcription events which are added to the live transcript.

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

### 3.4 Error handling

If the Gemini connection drops unexpectedly, the session is finalized with `status: 'interrupted'`. Any transcript entries recorded before the disconnect are preserved.

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
