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

## 5. Future Roadmap

### 5.1 Testing Strategy
- **Unit Testing**: Vitest for utility functions (audio encoding/decoding, Dossier state transitions).
- **Integration Testing**: Playwright with "Mock Mic" input to verify the Gemini connection lifecycle.
- **Acoustic Testing**: Automated checks to ensure the Mixed Stream contains both audio channels and appropriate volume levels.

### 5.2 Deployment & CI/CD
- **Hosting**: Firebase Hosting for global low-latency delivery.
- **CI/CD**: GitHub Actions to trigger builds on `main` branch.
- **Environment**: Use GitHub Secrets for `API_KEY` management, but prefer Firebase App Check in production to protect the Gemini endpoint.

### 5.3 Scalability & Search
- **Vector Search**: Future implementation of **Vertex AI Vector Search** on the stored transcripts. This would allow an Archivist to ask: "Find the part where Grandpa talks about his first boat."
- **TTS Summarization**: Post-session batch processing to generate a "Chapterized" version of the session for easier navigation.

### 5.4 Sharing & Collaboration
- Allow an Archivist to invite other family members to view (read-only) a Storyteller's archive.
- Shared Dossier editing for collaborative question planning.
