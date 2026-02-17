# Technical Design Document: LegacyBot

## 1. System Architecture
LegacyBot is built as a modern React SPA utilizing the Google Gemini Live API for real-time multimodal interaction. It follows a client-side heavy architecture with direct-to-cloud persistence via Google Cloud Platform (GCP).

### 1.1 Core Components
- **Frontend**: React 19+, Tailwind CSS, Lucide-style SVG icons.
- **AI Core**: `@google/genai` (Gemini 2.5 Flash Native Audio).
- **Persistence**: 
  - **Firestore**: Stores session metadata, question states, and live transcript chunks.
  - **GCS**: Stores high-fidelity WebM/PCM raw audio files.
- **Audio Pipeline**: Browser `AudioContext` handles PCM streaming to the API and mixes bot/user audio into a `MediaRecorder` stream for archival.

## 2. Implementation Details

### 2.1 The Interviewer Engine (Function Calling)
The AI is given a specialized tool: `updateQuestionStatus(id, status, findings)`. 
- As the storyteller speaks, the model periodically calls this function to update the local and remote state of the Dossier.
- This creates a closed-loop system where the bot "knows" what it has already learned and what it still needs to ask.

### 2.2 Audio Archiving Mixer
To satisfy the "capture both sides" requirement, the app uses an internal audio destination:
1. **User Node**: Created from `getUserMedia`.
2. **Bot Node**: Created from the API's decoded `AudioBuffer`.
3. **Mixed Destination**: Both nodes connect to a `MediaStreamDestination`.
4. **MediaRecorder**: Records the Mixed Destination and uploads to GCS on `stop()`.

### 2.3 Real-time Sync
Transcripts are appended to a Firestore document array in real-time. This ensures that even if a tab crashes, the conversation up to that second is preserved.

## 3. Future Roadmap & Proposed Implementations

### 3.1 Authentication & Security
- **Auth**: Implement **Firebase Authentication** (Google/Email) to separate private family archives.
- **Security Rules**: 
  - Firestore: `allow read, write: if request.auth.uid == resource.data.ownerId`.
  - GCS: IAM policies to restrict audio access to authenticated family members only.
- **Data Encryption**: Enable Cloud Storage encryption at rest (default) and TLS for all data in transit.

### 3.2 Testing Strategy
- **Unit Testing**: Vitest for utility functions (audio encoding/decoding, Dossier state transitions).
- **Integration Testing**: Playwright with "Mock Mic" input to verify the Gemini connection lifecycle.
- **Acoustic Testing**: Automated checks to ensure the Mixed Stream contains both audio channels and appropriate volume levels.

### 3.3 Deployment & CI/CD
- **Hosting**: Firebase Hosting for global low-latency delivery.
- **CI/CD**: GitHub Actions to trigger builds on `main` branch.
- **Environment**: Use GitHub Secrets for `API_KEY` management, but prefer Firebase App Check in production to protect the Gemini endpoint.

### 3.4 Scalability & Search
- **Vector Search**: Future implementation of **Vertex AI Vector Search** on the stored transcripts. This would allow an Archivist to ask: "Find the part where Grandpa talks about his first boat."
- **TTS Summarization**: Post-session batch processing to generate a "Chapterized" version of the session for easier navigation.
