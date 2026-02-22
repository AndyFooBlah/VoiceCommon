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

## Continuous Integration

GitHub Actions runs automatically on every push to `main` and on every pull request targeting `main`. The workflow is defined in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

### What CI checks

| Step | Command | Purpose |
|------|---------|---------|
| Install | `npm ci` | Clean install from lockfile |
| Type check | `npx tsc --noEmit` | Catch type errors without emitting files |
| Tests | `npm test` | Run all 154 unit and integration tests |

CI uses Node 20 on Ubuntu with npm caching enabled for fast installs. A concurrency group ensures that only one run per branch is active at a time — pushing again cancels the previous in-progress run.

### Contributing workflow

1. **Create a feature branch** from `main`:
   ```bash
   git checkout -b feature/my-change
   ```

2. **Make changes and run checks locally** before pushing:
   ```bash
   npx tsc --noEmit && npm test
   ```

3. **Push and open a pull request** against `main`. CI runs automatically and reports pass/fail status on the PR.

4. **Merge when CI is green.** If you have GitHub Pro (or the repo is public), enable the "Require status checks to pass" branch protection rule for the `Lint, Type Check & Test` check to enforce this.

### Adding new tests

- Place test files in `src/__tests__/` mirroring the source structure (e.g. `src/__tests__/hooks/useAuth.test.ts` tests `src/hooks/useAuth.ts`)
- Firebase and Web Audio API mocks are set up globally in `src/__tests__/setup.ts` — no per-test boilerplate needed
- See [design.md §5](design.md) for the full testing strategy, priority tiers, and mocking approach

## Built With AI

LegacyBot was developed collaboratively with several AI coding assistants across different phases of the project.

| AI | Model | Role |
|----|-------|------|
| Google AI Studio | Gemini 3.0 | Built the initial UI and application scaffold |
| Claude Code | Opus 4.5, Opus 4.6, Sonnet 4.6 | Feature development, architecture, testing, and ongoing iteration |
| Gemini CLI | Gemini 3.1 Pro | Feature development and iteration |

## License

Private repository. All rights reserved.
