# LegacyBot

A voice-first life story preservation app that helps families capture and archive the stories of their loved ones. LegacyBot uses the Google Gemini Live API to conduct empathetic, real-time voice interviews with storytellers, automatically transcribing and organizing their narratives.

## How It Works

1. **Create a Dossier** — Set up a storyteller profile with their name, background context, family tree, and a queue of interview questions.
2. **Start a Session** — LegacyBot greets the storyteller by name and guides the conversation using the question queue, adapting naturally to wherever the story leads.
3. **Review History** — Browse past sessions, read transcripts, listen to archived audio, and track question progress across interviews.

## Key Features

- Real-time voice conversation powered by Google Gemini Live API
- Three interviewer personalities: empathetic, investigative, casual
- Automatic question tracking with status updates via Gemini function calling
- Audio archival in WebM/Opus format to Firebase Cloud Storage
- Live transcript display during sessions
- Multi-user support with per-user data isolation via Firebase Auth
- Multiple storyteller dossiers per user
- Session history with audio playback and transcript review
- Partial session recovery (audio chunks saved every 10 seconds)

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS
- **AI**: Google Gemini Live API (`@google/genai`)
- **Backend**: Firebase (Authentication, Firestore, Cloud Storage)
- **Audio**: Web Audio API, MediaRecorder API
- **Testing**: Vitest, React Testing Library, jsdom

## Project Structure

```
src/
├── components/
│   ├── auth/          # LoginScreen
│   ├── dossier/       # DossierList, DossierEditor, StorytellerProfile
│   ├── session/       # SessionView, TranscriptFeed, Visualizer
│   ├── history/       # SessionList, TranscriptViewer, AudioPlayer, QuestionDashboard
│   └── shared/        # Layout, ErrorBoundary
├── hooks/             # useAuth, useDossier, useSession, useAudioMixer
├── services/          # firebase, gemini, storage, audioUtils
├── types.ts           # TypeScript interfaces
└── App.tsx            # Router setup
```

## Documentation

- [Product Requirements](product_requirements.md) — functional requirements, user stories, and UX goals
- [Design Document](design.md) — architecture, data model, security rules, testing strategy, and roadmap

## Getting Started

### Prerequisites

- Node.js 18+
- A Firebase project with Authentication, Firestore, and Cloud Storage enabled
- A Google Gemini API key

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/AndyFooBlah/LegacyBot.git
   cd LegacyBot
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create your environment file:
   ```bash
   cp .env.example .env.local
   ```

4. Fill in your Firebase and Gemini credentials in `.env.local`:
   ```
   VITE_FIREBASE_API_KEY=...
   VITE_FIREBASE_AUTH_DOMAIN=...
   VITE_FIREBASE_PROJECT_ID=...
   VITE_FIREBASE_STORAGE_BUCKET=...
   VITE_FIREBASE_MESSAGING_SENDER_ID=...
   VITE_FIREBASE_APP_ID=...
   VITE_GEMINI_API_KEY=...
   ```

5. Deploy Firestore and Storage security rules to your Firebase project:
   ```bash
   firebase deploy --only firestore:rules,storage
   ```

6. Start the dev server:
   ```bash
   npm run dev
   ```

### Running Tests

```bash
npm test            # single run
npm run test:watch  # watch mode
```

## License

Private repository. All rights reserved.
