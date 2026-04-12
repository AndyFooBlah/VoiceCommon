# Product Requirements: VoiceCommon

## 1. Overview

VoiceCommon is a reusable framework for building voice AI web applications powered by Google Gemini Live and Firebase. It provides the common infrastructure needed by any app that wants to enable real-time voice conversations with an AI, archive those conversations, and let users review them later.

VoiceCommon ships with a minimal example application that demonstrates the framework. Teams building production apps on VoiceCommon are expected to replace or extend the example components with their own UI and business logic.

---

## 2. Goals

- Provide a well-factored, reusable baseline for voice AI web apps
- Minimize the work required to go from zero to a working voice AI session
- Make it easy to customize the AI persona, system instructions, and tool set
- Ensure all voice sessions are archived (audio + transcript) by default
- Keep the framework lean — include only infrastructure that is broadly useful, not app-specific features

---

## 3. Functional requirements

### 3.1 Authentication

- Users must be able to sign in with Google OAuth or email/password
- A user profile document is created in Firestore on first login (`users/{uid}`)
- Users must be signed in to start or view sessions

### 3.2 Voice sessions

- Users can start a new live voice session from the New Session page
- The session connects to Gemini Live and streams microphone audio in real time
- The AI responds with voice audio, played back through the browser
- A waveform visualizer shows whether the user or the AI is speaking
- The real-time transcript streams into the UI as conversation turns complete
- Sessions can be ended by the user (button) or by the AI (via `endSession` tool call)
- A session's status progresses: `active` → `completed` (or `interrupted` on error)

### 3.3 Audio archival

- Mixed audio (user + bot) is recorded throughout the session using `MediaRecorder`
- On session end, the audio blob is uploaded to Cloud Storage in WebM/Opus format
- The GCS download URL is stored on the session document in Firestore
- Audio is archived at `sessions/{userId}/{sessionId}.webm`

### 3.4 Transcript archival

- Each conversation turn is appended to an in-memory transcript during the session
- The full transcript is synced to Firestore in real time as turns complete
- Transcripts are stored at `sessions/{sessionId}/transcript/entries`
- Tool calls are recorded in the transcript with their name, arguments, and result

### 3.5 Session history

- Users can view a list of their past sessions, sorted newest-first
- Each session shows date, time, duration, and status
- Clicking a session opens the transcript viewer

### 3.6 Transcript viewer

- Displays the full conversation transcript for a past session
- Shows user and assistant turns as a chat-style message thread
- Lists tool calls used during the session
- Provides audio playback if an audio recording is available

### 3.7 Built-in tools

The following Gemini function tools are included out of the box:

| Tool | Description | API Required |
|------|-------------|-------------|
| `getWeather` | Current weather for a location | Google Maps Weather API |
| `searchPlace` | Look up a location or address | Google Maps Geocoding API |
| `getDistanceBetweenPlaces` | Straight-line distance between two locations | Google Maps Geocoding API |
| `getJoke` | Random safe-for-work joke | JokeAPI (no key required) |
| `searchWikipedia` | Brief summary of a Wikipedia article | Wikipedia REST API (no key required) |

Applications can use a subset of these tools, replace them, or add their own.

### 3.8 Post-session processing (Cloud Functions)

- The `onSessionCompleted` Cloud Function fires when a session transitions to `completed`
- It provides a hook for application-specific server-side logic (transcript analysis, notifications, summaries, etc.)
- The base implementation logs the event; apps fill in their own processing

---

## 4. Non-functional requirements

- **Real-time**: Transcript entries should appear within ~1 second of a conversation turn completing
- **Reliability**: Audio archival and transcript sync failures should be logged but not crash the session
- **Security**: Firestore and Storage rules enforce that users can only access their own data
- **Privacy**: No user data is shared across accounts
- **Extensibility**: The system instruction, tools, and post-session processing are all designed to be replaced or extended by application teams

---

## 5. Out of scope

The following are intentionally not part of VoiceCommon (they are app-specific concerns):

- Multi-user or family/group access control
- Role-based permissions (admin, viewer, etc.)
- AI-generated content beyond the session (summaries, reports, analyses)
- Email notifications or invitation workflows
- Media uploads (photos, documents)
- Transcript editing
- Export features (PDF, Markdown)
