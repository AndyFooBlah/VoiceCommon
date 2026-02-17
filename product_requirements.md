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
- **Non-Interruptive Behavior**: Guidelines ensure the bot never interrupts a "good story." It waits for natural pauses before prompting the user to "continue" or moving to new topics.
- **Warm-up Protocol**: Every session must begin with a warm-up greeting (e.g., "How are you feeling today?") to build rapport before archival work begins.

### 3.2 Archival & Persistence
- **"Never Delete" Policy**: Every word spoken and every raw audio bite must be preserved permanently.
- **Raw Audio Archival**: Full sessions must be mixed (User + Bot) and uploaded to Google Cloud Storage (GCS) in a high-quality format.
- **Real-time Transcripts**: Transcripts must be streamed and synced to a searchable database (Firestore) immediately, not waiting for user consent to "save."
- **Searchability**: A database must map transcripts to raw audio URLs to allow future searching and indexing of specific stories.

### 3.3 The Dossier & Question Engine
- **Family Tree Context**: The Archivist inputs a list of relatives (names and relations) so the bot can acknowledge them when mentioned.
- **Historical Context**: General background on the Storyteller’s life (e.g., "Grew up in Ohio in the 50s").
- **Question State Management**: Questions in the "Story Queue" must track their progress:
  - **Unasked**: Not yet brought up.
  - **InProgress**: Topic has been broached but requires more depth.
  - **Completed**: Topic has been richly explored and summarized.
- **Findings/Summaries**: The bot should summarize "findings" for each question as the conversation progresses.

### 3.4 Customization & Personality
- **Voice Selection**: Ability to choose between multiple prebuilt voices (Zephyr, Kore, etc.).
- **Personality Modes**: 
  - *Empathetic Biographer*: Warm and emotional.
  - *Oral Historian (Investigative)*: Precise, focused on dates and facts.
  - *Casual Grandchild*: Informal and enthusiastic.

## 4. User Experience (UX) Goals
- **Accessibility**: Minimal buttons for the Storyteller. One large "Start" button.
- **Feedback**: Visual waveform indicators to show the bot is listening or speaking.
- **Safety**: Robust error handling to reassure the user if a connection drops.
