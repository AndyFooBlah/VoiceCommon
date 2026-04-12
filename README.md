# VoiceCommon

A reusable framework for building voice AI web applications powered by Google Gemini Live and Firebase.

> **Origin:** VoiceCommon was started as a way to extract reusable common functionality from [LegacyBot](https://github.com/AndyFooBlah/LegacyBot), a voice-first life story preservation app. The patterns for real-time voice sessions, transcript archival, audio recording, and AI tool integrations have been generalized here into a clean framework that any voice AI app can build on.

---

## What VoiceCommon provides

- **Gemini Live integration** — real-time bidirectional voice sessions with Google's Gemini Live API, including PCM audio streaming, bot audio playback scheduling, and connection lifecycle management
- **Firebase authentication** — Google OAuth and email/password sign-in, with user profile creation in Firestore
- **Session archival** — automatic recording of mixed user+bot audio to Cloud Storage (WebM/Opus), real-time transcript sync to Firestore
- **Built-in tool integrations** — weather, maps/distance, jokes, and Wikipedia search, each usable as a Gemini function tool
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
- A Google Gemini API key from [Google AI Studio](https://aistudio.google.com)
- (Optional) A Google Maps API key for weather and location tools

### 1. Clone and install

```bash
git clone https://github.com/AndyFooBlah/VoiceCommon.git
cd VoiceCommon
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your Firebase and Gemini credentials
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

### Custom system instruction

Replace the default assistant with your own by calling `buildSessionInstruction` with your own `assistantName` and `appContext`:

```typescript
import { buildSessionInstruction } from './services/gemini';

const instruction = buildSessionInstruction({
  assistantName: 'Nova',
  appContext: 'You are a customer service agent for Acme Corp...',
  currentDateTime: new Date().toLocaleString(),
});
```

Or skip `buildSessionInstruction` entirely and pass your own string directly to `useSession`.

### Custom tools

Add tools alongside the built-in set, or replace them:

```typescript
import { useSession } from './hooks/useSession';
import { allTools } from './services/gemini';
import type { FunctionDeclaration } from '@google/genai';

const myTool: FunctionDeclaration = {
  name: 'lookupOrder',
  description: 'Look up a customer order by order number.',
  parameters: { ... },
};

const { startSession, stopSession, messages } = useSession({
  userId: user.uid,
  systemInstruction: myInstruction,
  tools: [...allTools, myTool],
  onToolCall: async (name, args) => {
    if (name === 'lookupOrder') return lookupOrder(args.orderNumber);
    // fall through to built-in handlers...
  },
});
```

### Post-session processing

The `onSessionCompleted` Cloud Function in `functions/src/index.ts` fires whenever a session transitions to `completed`. Add your own server-side logic there — transcript analysis, notifications, summaries, webhooks, etc.

---

## Project structure

```
src/
├── services/
│   ├── firebase.ts          # Firebase app initialization
│   ├── gemini.ts            # Gemini Live session instruction builder + tool registry
│   ├── storage.ts           # Firestore + GCS session/transcript persistence
│   ├── audioUtils.ts        # PCM encoding, decoding, resampling
│   └── tools/
│       ├── weather.ts       # Weather tool (Google Maps Weather API)
│       ├── maps.ts          # Place search + distance tool (Google Maps Geocoding)
│       ├── jokes.ts         # Joke tool (JokeAPI)
│       └── wikipedia.ts     # Wikipedia search tool
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
├── types.ts                 # Core TypeScript interfaces
└── App.tsx                  # Router

functions/
└── src/
    └── index.ts             # Cloud Functions (onSessionCompleted hook)

public/
└── pcm-processor.js         # AudioWorklet for low-latency PCM streaming
```

---

## Firestore data model

```
users/{uid}
  email, displayName, createdAt, timezone

sessions/{sessionId}
  userId, startTime, endTime, audioUrl, status, durationSeconds

sessions/{sessionId}/transcript/entries
  { entries: TranscriptEntry[] }
```

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
| Testing | Vitest, React Testing Library |
| CI | GitHub Actions |

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
