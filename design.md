# Technical Design Document: LegacyBot

## 1. System Architecture
LegacyBot is built as a modern React SPA utilizing the Google Gemini Live API for real-time multimodal interaction. It uses Firebase for authentication and persistence, with Google Cloud Storage for audio archival.

### 1.1 Core Components
- **Frontend**: React 19+, TypeScript, Tailwind CSS, Vite.
- **AI Core**: `@google/genai` (Gemini 2.5 Flash Native Audio).
- **Auth**: Firebase Authentication (Google and Email/Password sign-in).
- **Persistence**:
  - **Firestore**: Stores Dossiers, session metadata, question states, and live transcript chunks.
  - **GCS**: Stores archived session audio (WebM/Opus at 128 kbps).
- **Audio Pipeline**: Browser `AudioContext` handles PCM streaming to the Gemini API and mixes bot/user audio into a `MediaRecorder` stream for archival.

### 1.2 High-Level Data Flow
```
Archivist (Auth) → Select Dossier → Start Session → Gemini Live API
                                                        ↕
                                          Storyteller ←→ Voice I/O
                                                        ↓
                                          Mixed Audio → GCS (WebM/Opus 128kbps)
                                          Transcripts → Firestore (real-time)
                                          Question State → Firestore (via function calling)
```

## 2. Data Model (Firestore)

### 2.1 Collections

```
users/{uid}
  - email: string
  - displayName: string
  - createdAt: timestamp

users/{uid}/dossiers/{dossierId}
  - storytellerName: string (required)
  - storytellerContext: string (free-text bio/background)
  - historicalContext: string
  - familyTree: FamilyMember[]
  - selectedVoice: string
  - personality: PersonalityMode
  - createdAt: timestamp
  - updatedAt: timestamp

users/{uid}/dossiers/{dossierId}/questions/{questionId}
  - text: string
  - status: 'Unasked' | 'InProgress' | 'Completed'
  - findings: string
  - order: number
  - createdAt: timestamp
  - updatedAt: timestamp

users/{uid}/dossiers/{dossierId}/sessions/{sessionId}
  - startTime: timestamp
  - endTime: timestamp | null
  - audioUrl: string (GCS path)
  - status: 'active' | 'completed' | 'interrupted'
  - durationSeconds: number

users/{uid}/dossiers/{dossierId}/sessions/{sessionId}/transcript
  - (single document with array of entries, appended in real-time)
  - entries: { role: 'user' | 'bot', text: string, timestamp: timestamp }[]
```

### 2.2 GCS Structure
```
gs://legacybot-archives/{uid}/{dossierId}/{sessionId}.webm
```

### 2.3 Security Rules
```
// Firestore
match /users/{uid}/{document=**} {
  allow read, write: if request.auth != null && request.auth.uid == uid;
}

// GCS — enforced via IAM + Firebase Storage Security Rules
// Only the owning uid can read/write their archive path.
```

## 3. Implementation Details

### 3.1 Authentication Flow
1. User lands on login screen (Google sign-in button + email/password form).
2. On successful auth, Firebase SDK provides `uid`.
3. App loads the user's Dossier list from `users/{uid}/dossiers`.
4. User selects or creates a Dossier, then proceeds to the session view.
5. All Firestore/GCS operations are scoped to the authenticated `uid`.

### 3.2 The Interviewer Engine (Function Calling)
The AI is given a specialized tool: `updateQuestionStatus(id, status, findings)`.
- As the storyteller speaks, the model periodically calls this function to update the local and remote state of the Dossier.
- This creates a closed-loop system where the bot "knows" what it has already learned and what it still needs to ask.
- The system instruction includes the Storyteller's name so the bot can address them personally during the warm-up and throughout the session.

### 3.3 Audio Archiving Mixer
To satisfy the "capture both sides" requirement, the app uses an internal audio destination:
1. **User Node**: Created from `getUserMedia`.
2. **Bot Node**: Created from the API's decoded `AudioBuffer`.
3. **Mixed Destination**: Both nodes connect to a `MediaStreamDestination`.
4. **MediaRecorder**: Records the mixed stream as WebM/Opus at 128 kbps. On `stop()`, the blob is uploaded to GCS.
5. **Partial Recovery**: The `MediaRecorder` uses `timeslice` to emit data chunks periodically (~10s intervals). Chunks are buffered locally and flushed to GCS on stop or on connection error, ensuring partial sessions are never lost.

### 3.4 Real-time Transcript Sync
Transcripts are appended to a Firestore document array in real-time. This ensures that even if a tab crashes, the conversation up to that second is preserved. Each entry includes a role label and timestamp for later review.

### 3.5 Session History & Review
- **Session List View**: Queries `users/{uid}/dossiers/{dossierId}/sessions` ordered by `startTime` descending.
- **Transcript Viewer**: Renders the transcript entries with speaker labels, styled as a conversation view (similar to the live transcript but read-only).
- **Audio Player**: Streams the session's WebM file from GCS via a signed URL or Firebase Storage download URL. Uses a standard HTML5 `<audio>` element with playback controls.
- **Question Dashboard**: Aggregates question states from the Dossier's questions subcollection, showing progress across all sessions.

### 3.6 Error Recovery & Reconnection
- On Gemini API disconnect (`onclose`/`onerror`), the app:
  1. Flushes all buffered audio chunks to GCS (partial session archive).
  2. Syncs the latest transcript state to Firestore.
  3. Updates the session status to `'interrupted'`.
  4. Displays a reassuring, non-technical message to the Storyteller.
  5. Offers a "Reconnect" button that starts a new Gemini session but continues appending to the same Firestore session document.
- **Connectivity check**: Before starting a session, the app performs a lightweight connectivity probe and warns the Archivist if latency is high.

## 4. App Structure (Proposed)

```
src/
├── components/
│   ├── auth/
│   │   └── LoginScreen.tsx
│   ├── dossier/
│   │   ├── DossierList.tsx          # Select/create Dossiers
│   │   ├── DossierEditor.tsx        # Edit Dossier details, family tree, questions
│   │   └── StorytellerProfile.tsx   # Name + free-text context
│   ├── session/
│   │   ├── SessionView.tsx          # Live session (Start button, visualizer, transcript)
│   │   ├── Visualizer.tsx           # Waveform animation
│   │   └── TranscriptFeed.tsx       # Real-time message bubbles
│   ├── history/
│   │   ├── SessionList.tsx          # Browse past sessions
│   │   ├── TranscriptViewer.tsx     # Read-only transcript playback
│   │   ├── AudioPlayer.tsx          # Audio playback controls
│   │   └── QuestionDashboard.tsx    # Cross-session question progress
│   └── shared/
│       ├── Layout.tsx               # App shell, nav, auth guard
│       └── ErrorBoundary.tsx
├── services/
│   ├── firebase.ts                  # Firebase app init, auth, Firestore, Storage
│   ├── gemini.ts                    # Gemini Live API session management
│   ├── audioUtils.ts                # PCM encoding/decoding, mixer setup
│   └── storage.ts                   # GCS upload, Firestore CRUD for sessions/transcripts
├── hooks/
│   ├── useAuth.ts                   # Auth state, login/logout
│   ├── useDossier.ts               # Dossier CRUD, question management
│   ├── useSession.ts               # Live session lifecycle
│   └── useAudioMixer.ts            # Audio pipeline setup/teardown
├── types.ts
├── App.tsx                          # Router + auth guard
└── index.tsx
```

## 5. Testing Strategy

### 5.1 Tooling
- **Test runner**: Vitest (fast, Vite-native, ESM-compatible)
- **Component testing**: React Testing Library (`@testing-library/react`)
- **DOM environment**: jsdom (via `vitest` config)
- **Browser API mocks**: Custom mocks for `AudioContext`, `MediaRecorder`, `getUserMedia` (see `src/__mocks__/`)
- **Firebase mocks**: `firebase/firestore`, `firebase/auth`, and `firebase/storage` are mocked at the module level so unit tests never hit a real backend
- **E2E** (future): Playwright with mock microphone input

### 5.2 Test Structure

```
src/__tests__/
├── services/
│   ├── audioUtils.test.ts         # encode/decode roundtrips, PCM conversion edge cases
│   ├── gemini.test.ts             # System instruction generation
│   ├── storage.test.ts            # Firestore/GCS operations (mocked)
│   └── firebase.test.ts           # Config validation
├── hooks/
│   ├── useAuth.test.ts            # Auth state, sign-in flows, profile creation
│   ├── useDossier.test.ts         # CRUD, debouncing, cleanup
│   ├── useSession.test.ts         # Session lifecycle, error recovery
│   └── useAudioMixer.test.ts      # Mixer init, stop, flush, cleanup
├── components/
│   ├── auth/LoginScreen.test.tsx
│   ├── dossier/DossierList.test.tsx
│   ├── session/SessionView.test.tsx
│   ├── session/TranscriptFeed.test.tsx
│   ├── history/QuestionDashboard.test.tsx
│   └── shared/ErrorBoundary.test.tsx
└── integration/
    ├── auth-flow.test.ts          # Login → Dossier list → select → session
    └── session-lifecycle.test.ts  # Start → record → transcript → stop → review
```

### 5.3 Test Priorities

Tests are organized into three priority tiers based on risk and impact:

**Priority 1 — Core logic and data integrity (must-have for v1)**

| Area | What to test | Why it matters |
|------|-------------|----------------|
| `audioUtils` | encode/decode roundtrips, large arrays, invalid input, PCM-to-Float32 conversion boundaries | Audio corruption is unrecoverable under the "never delete" policy |
| `gemini.ts` | `buildSystemInstruction` output with various Dossier states (empty name, empty questions, special characters, large question sets) | Malformed instructions break the interview experience |
| `storage.ts` | `createSession`, `finalizeSession`, `syncTranscriptToFirestore` with mocked Firestore | Data loss is the worst failure mode for an archival app |
| `useAuth` | Sign-in flows, auto-registration only on `user-not-found` (not wrong password), profile creation, sign-out | Auth bugs can lock users out or create phantom accounts |
| `useDossier` | Debounce behavior, cleanup on unmount, CRUD operations, question reordering | Dossier data is the Archivist's primary work product |
| `ErrorBoundary` | Catches render errors, shows friendly message, logs to console | Storytellers must never see a white screen |

**Priority 2 — User flows and component behavior**

| Area | What to test | Why it matters |
|------|-------------|----------------|
| `LoginScreen` | Form validation, error display, loading states, both sign-in paths | First thing every user sees |
| `DossierList` | Empty state, create form, delete confirmation, navigation | Core Archivist workflow |
| `SessionView` | Start/stop button states, error dialog, reconnect flow | Storyteller-facing; must be bulletproof |
| `TranscriptFeed` | Message rendering, user vs bot styling, empty state, auto-scroll | Real-time feedback during sessions |
| `QuestionDashboard` | Progress bar, status counts, findings display, empty state | Archivist reviews progress here |
| `useAudioMixer` | Start/stop/flush lifecycle, MediaRecorder config, track cleanup | Mic and recording failures lose audio |

**Priority 3 — Edge cases and E2E**

| Area | What to test | Why it matters |
|------|-------------|----------------|
| `useSession` | Full lifecycle with mocked Gemini, function calling, interruption handling, partial flush, concurrent audio chunks | Most complex hook; hardest to test but highest risk |
| `SessionList` | Date formatting, status badges, empty state, Firestore ordering | Review experience |
| `TranscriptViewer` | Transcript loading, speaker labels, audio player integration | Review experience |
| `Layout` | Auth guard, nav visibility on session routes, sign-out | App shell correctness |
| E2E (Playwright) | Full flow: login → create dossier → start session → speak → stop → review transcript | Confidence before release |

### 5.4 Mocking Strategy

**Firebase**: All Firestore/Auth/Storage imports are mocked at the module level via Vitest's `vi.mock()`. Tests use in-memory state to simulate reads and writes. This keeps tests fast and avoids needing a Firebase emulator for unit tests.

**Browser APIs**: `AudioContext`, `MediaRecorder`, `getUserMedia`, and `MediaStreamDestination` are mocked in `src/__mocks__/webAudioApi.ts`. The mocks track calls and state changes so tests can verify the audio pipeline without real hardware.

**Gemini API**: `@google/genai` is mocked to provide controllable `onopen`, `onmessage`, `onerror`, and `onclose` callbacks. Tests simulate function calls, audio data, transcription events, and connection drops.

### 5.5 Known Issues Found During Review

The following issues were identified during code review and should be verified by tests:

1. **`useAuth` — wrong-password auto-registration (FIXED)**: `auth/invalid-credential` was incorrectly triggering account creation. Fixed to only auto-register on `auth/user-not-found`.

2. **`useDossier` — debounce timer leak (FIXED)**: Debounce timer was not cleared on component unmount, causing async Firestore writes after the component was gone.

3. **`firebase.ts` — missing config validation (FIXED)**: No validation that required environment variables were present. Now fails fast with a clear error message.

4. **`syncTranscriptToFirestore` — full overwrite on every sync**: Uses `setDoc(..., { merge: false })` which overwrites the entire transcript document on each call. Concurrent syncs could theoretically lose entries. Acceptable for v1 since turns are sequential, but should be monitored.

5. **`useSession` — orphaned sessions on start failure**: If `mixer.start()` succeeds but the Gemini connection fails, a Firestore session document is created but never finalized. A cleanup step should mark it as `interrupted`.

6. **`encode()` — potential RangeError on large arrays**: The byte-to-char loop may hit string length limits on very large audio buffers. Should be tested with realistic buffer sizes.

## 6. Future Roadmap

### 6.1 Pre-session Connectivity Check (Issue #18)
- Lightweight latency probe before starting a Gemini session
- Warn the Archivist if round-trip time exceeds 500ms
- Dismissible — does not block session start

### 6.2 Deployment & CI/CD
- **Hosting**: Firebase Hosting for global low-latency delivery.
- **CI/CD**: GitHub Actions to trigger builds on `main` branch.
- **Environment**: Use GitHub Secrets for `API_KEY` management, but prefer Firebase App Check in production to protect the Gemini endpoint.

### 6.3 Scalability & Search
- **Vector Search**: Future implementation of **Vertex AI Vector Search** on the stored transcripts. This would allow an Archivist to ask: "Find the part where Grandpa talks about his first boat."
- **TTS Summarization**: Post-session batch processing to generate a "Chapterized" version of the session for easier navigation.

### 6.4 Sharing & Collaboration
- Allow an Archivist to invite other family members to view (read-only) a Storyteller's archive.
- Shared Dossier editing for collaborative question planning.
