# Product Requirements Document: LegacyBot

## 1. Executive Summary
LegacyBot is a voice-first life story preservation application designed to help seniors ("Storytellers") record and archive their oral histories through active, empathetic interviewing. The system is managed by a family member or professional ("Archivist") who provides context and specific prompts to guide the AI's inquiry.

## 2. Target Audience
- **The Storyteller**: Seniors (often non-technical) who want to share their life experiences in a natural, conversational way.
- **The Archivist**: Family members or biographers who set up the "Dossier," define the "Story Queue," and review the archived results.

## 3. Key Requirements

### 3.1 Conversational Interviewing
- **Active Listening**: The system must use high-fidelity, low-latency voice interaction (Gemini Live).
- **Interviewer Logic**: The bot must act as an active interviewer, not just a passive recorder. It should ask follow-up questions, seek clarifications, and bridge related topics.
- **Non-Interruptive Behavior**: The bot never interrupts a "good story." It waits for natural pauses before prompting the user to "continue" or moving to new topics. The Storyteller *may* interrupt the bot at any time (e.g., to correct or add detail), and the bot must gracefully yield and listen.
- **Warm-up Protocol**: Every session must begin with a warm-up greeting that addresses the Storyteller by name (e.g., "Good morning, Margaret! How are you feeling today?") to build rapport before archival work begins.

### 3.2 Archival & Persistence
- **"Never Delete" Policy**: Every word spoken and every raw audio bite must be preserved permanently.
- **Audio Format**: Sessions are recorded as mixed audio (User + Bot) and uploaded to Google Cloud Storage (GCS) in **WebM/Opus at 128 kbps**. This provides transparent speech quality at ~58 MB/hour, balancing fidelity with the long-term storage costs of a "never delete" policy.
- **Real-time Transcripts**: Transcripts must be streamed and synced to Firestore immediately, not waiting for user consent to "save."
- **Partial Session Recovery**: If a connection drops mid-session, any audio and transcript data captured up to that point must still be uploaded and preserved. No data should be lost due to an ungraceful disconnection.
- **Searchability**: A database must map transcripts to raw audio URLs to allow future searching and indexing of specific stories.

### 3.3 The Dossier & Question Engine
- **Dossier Persistence**: The Dossier is stored in Firestore and persists across sessions. It is created once by the Archivist and refined over time as new questions arise or context is added.
- **Storyteller Profile**: Each Dossier is associated with a Storyteller. The Storyteller's **name is required**; additional context (age, location, background) is free-text.
- **Family Tree Context**: The Archivist inputs a list of relatives (names and relations) so the bot can acknowledge them when mentioned.
- **Historical Context**: General background on the Storyteller's life (e.g., "Grew up in Ohio in the 50s").
- **Question State Management**: Questions in the "Story Queue" must track their progress:
  - **Unasked**: Not yet brought up.
  - **InProgress**: Topic has been broached but requires more depth.
  - **Completed**: Topic has been richly explored and summarized.
- **Archivist Override**: The Archivist may manually reset a "Completed" question back to "Unasked" or "InProgress" to revisit a topic in a future session.
- **Findings/Summaries**: The bot should summarize "findings" for each question as the conversation progresses.

### 3.4 Customization & Personality
- **Voice Selection**: Ability to choose between multiple prebuilt voices (Zephyr, Kore, etc.).
- **Personality Modes**:
  - *Empathetic Biographer*: Warm and emotional.
  - *Oral Historian (Investigative)*: Precise, focused on dates and facts.
  - *Casual Grandchild*: Informal and enthusiastic.

### 3.5 Multi-User & Multi-Storyteller Support
- **Authentication**: Users (Archivists) authenticate via Firebase Authentication (Google or Email sign-in).
- **Multiple Dossiers**: An Archivist can create and manage multiple Dossiers, each for a different Storyteller.
- **Data Isolation**: Each Archivist's Dossiers, sessions, and audio archives are private and only accessible to the authenticated owner. Firestore security rules and GCS IAM policies enforce this.
- **Dossier Selection**: On login, the Archivist sees a list of their Storyteller Dossiers and can select one to begin or continue a session.

### 3.6 Session History & Review
- **Session List**: The Archivist can browse all past sessions for a given Storyteller, sorted by date.
- **Transcript Review**: Past session transcripts are viewable in full, with speaker labels (Storyteller vs. Bot) and timestamps.
- **Audio Playback**: The Archivist can play back archived audio for any past session directly from the app.
- **Question Progress Dashboard**: The Archivist can see the current state of the Story Queue across all sessions — which questions are Completed, InProgress, or Unasked — along with accumulated findings.

## 4. User Experience (UX) Goals
- **Accessibility**: Minimal buttons for the Storyteller. One large "Start" button. The Archivist panel is hidden by default and not needed during a session.
- **Feedback**: Visual waveform indicators to show the bot is listening or speaking.
- **Error Recovery**: If a connection drops, the app displays a reassuring message (not a technical error), preserves all data captured so far, and offers a simple "Reconnect" button. The Storyteller should never feel they've lost their story.
- **Connectivity Awareness**: The app should detect poor network conditions and warn the Archivist before starting a session if the connection may be unreliable.
