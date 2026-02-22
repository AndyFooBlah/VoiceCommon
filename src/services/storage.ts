/**
 * Persistence services for LegacyBot sessions.
 *
 * Handles two core archival operations:
 *   1. Audio upload to Firebase Cloud Storage (WebM/Opus at 128 kbps)
 *   2. Real-time transcript sync to Firestore
 *
 * Both services follow the "Never Delete" policy — data is only ever
 * appended or created, never overwritten or removed.
 *
 * GCS path convention:
 *   gs://{bucket}/{familyId}/{dossierId}/{sessionId}.webm
 *
 * Firestore path for transcripts:
 *   families/{familyId}/dossiers/{dossierId}/sessions/{sessionId}/transcript/entries
 */

import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import {
  doc,
  setDoc,
  updateDoc,
  addDoc,
  collection,
  query,
  where,
  getDocs,
  orderBy,
  limit as firestoreLimit,
  getDoc,
  Timestamp,
} from 'firebase/firestore';
import { db, storage } from './firebase';
import {
  TranscriptEntry,
  TranscriptEditHistoryEntry,
  SessionMetadata,
  InterviewQuestion,
  StoryEvent,
  FamilyEvent,
  SessionEngagement,
  SuggestedQuestion,
  Memoir,
  MediaItem,
  AudioClip,
  PromptPhoto,
} from '../types';

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Creates a new session document in Firestore and returns its ID.
 * Called when the Storyteller presses "Start" to begin a recording.
 */
export async function createSession(
  familyId: string,
  dossierId: string,
  storytellerUid: string,
): Promise<string> {
  const colRef = collection(db, 'families', familyId, 'dossiers', dossierId, 'sessions');
  const session: Omit<SessionMetadata, 'id'> = {
    storytellerUid,
    startTime: Timestamp.now(),
    endTime: null,
    audioUrl: '',
    status: 'active',
    durationSeconds: 0,
  };
  const docRef = await addDoc(colRef, session);
  return docRef.id;
}

/**
 * Updates the session document when a session ends or is interrupted.
 * Sets the end time, duration, status, and (optionally) the audio URL.
 */
export async function finalizeSession(
  familyId: string,
  dossierId: string,
  sessionId: string,
  status: 'completed' | 'interrupted',
  durationSeconds: number,
  audioUrl?: string,
): Promise<void> {
  const docRef = doc(db, 'families', familyId, 'dossiers', dossierId, 'sessions', sessionId);
  await updateDoc(docRef, {
    endTime: Timestamp.now(),
    status,
    durationSeconds,
    ...(audioUrl ? { audioUrl } : {}),
  });
}

// ---------------------------------------------------------------------------
// Audio archival (GCS)
// ---------------------------------------------------------------------------

/**
 * Uploads a recorded audio blob to Firebase Cloud Storage.
 *
 * The blob is the mixed User+Bot WebM/Opus recording from the MediaRecorder.
 * Returns the public download URL, which is stored on the session document.
 *
 * Path: {familyId}/{dossierId}/{sessionId}.webm
 */
export async function archiveAudioToGCS(
  audioBlob: Blob,
  familyId: string,
  dossierId: string,
  sessionId: string,
): Promise<string> {
  const storagePath = `${familyId}/${dossierId}/${sessionId}.webm`;
  const storageRef = ref(storage, storagePath);

  await uploadBytes(storageRef, audioBlob, {
    contentType: 'audio/webm;codecs=opus',
  });

  const downloadUrl = await getDownloadURL(storageRef);
  return downloadUrl;
}

// ---------------------------------------------------------------------------
// Transcript sync (Firestore)
// ---------------------------------------------------------------------------

/**
 * Writes the full transcript to the session's transcript document.
 *
 * Called in real-time as each turn completes during a live session.
 * Stores the full transcript as an array in a single document for
 * efficient reads during session review.
 */
export async function syncTranscriptToFirestore(
  familyId: string,
  dossierId: string,
  sessionId: string,
  entries: TranscriptEntry[],
): Promise<void> {
  const docRef = doc(
    db,
    'families',
    familyId,
    'dossiers',
    dossierId,
    'sessions',
    sessionId,
    'transcript',
    'entries',
  );
  await setDoc(docRef, { entries }, { merge: false });
}

// ---------------------------------------------------------------------------
// Question state sync (Firestore)
// ---------------------------------------------------------------------------

/**
 * Updates a single question's status and findings in Firestore.
 * Called by the Gemini function-calling tool (updateQuestionStatus) during
 * a live session, and by the Archivist when manually overriding status.
 */
export async function updateQuestionStateInFirestore(
  familyId: string,
  dossierId: string,
  questionId: string,
  status: string,
  findings: string,
): Promise<void> {
  const docRef = doc(db, 'families', familyId, 'dossiers', dossierId, 'questions', questionId);
  await updateDoc(docRef, {
    status,
    findings,
    updatedAt: Timestamp.now(),
  });
}

// ---------------------------------------------------------------------------
// Session history queries (for system instruction context)
// ---------------------------------------------------------------------------

/**
 * Returns the count of completed sessions for a dossier.
 * Used to determine first session vs returning session greeting.
 */
export async function getCompletedSessionCount(
  familyId: string,
  dossierId: string,
): Promise<number> {
  const colRef = collection(db, 'families', familyId, 'dossiers', dossierId, 'sessions');
  const q = query(colRef, where('status', '==', 'completed'));
  const snapshot = await getDocs(q);
  return snapshot.size;
}

/**
 * Fetches a brief summary from the most recent completed session's transcript.
 * Returns a short text describing what was discussed, for session continuity.
 */
export async function getPreviousSessionSummary(
  familyId: string,
  dossierId: string,
): Promise<string | undefined> {
  const colRef = collection(db, 'families', familyId, 'dossiers', dossierId, 'sessions');
  const q = query(colRef, where('status', '==', 'completed'), orderBy('startTime', 'desc'), firestoreLimit(1));
  const snapshot = await getDocs(q);
  if (snapshot.empty) return undefined;

  const lastSession = snapshot.docs[0];
  const transcriptRef = doc(
    db, 'families', familyId, 'dossiers', dossierId,
    'sessions', lastSession.id, 'transcript', 'entries',
  );
  const transcriptSnap = await getDoc(transcriptRef);
  if (!transcriptSnap.exists()) return undefined;

  const entries = transcriptSnap.data().entries ?? [];
  if (entries.length === 0) return undefined;

  // Build a brief summary from the last few exchanges
  const lastEntries = entries.slice(-6);
  const summary = lastEntries
    .map((e: any) => `${e.role === 'user' ? 'Storyteller' : 'Bot'}: ${e.text.slice(0, 150)}`)
    .join(' | ');
  return summary;
}

// ---------------------------------------------------------------------------
// Emotional observation logging
// ---------------------------------------------------------------------------

export interface EmotionalObservation {
  mood: string;
  confidence: number;
  trigger: string;
  recommendation: string;
  timestamp: Timestamp;
}

/**
 * Appends an emotional observation to the session's transcript document.
 * Observations are stored alongside transcript entries but kept separate.
 */
export async function logEmotionalObservation(
  familyId: string,
  dossierId: string,
  sessionId: string,
  observation: Omit<EmotionalObservation, 'timestamp'>,
): Promise<void> {
  const docRef = doc(
    db, 'families', familyId, 'dossiers', dossierId,
    'sessions', sessionId, 'transcript', 'entries',
  );
  const snap = await getDoc(docRef);
  const existing = snap.exists() ? snap.data() : {};
  const observations: EmotionalObservation[] = existing.emotionalObservations ?? [];
  observations.push({ ...observation, timestamp: Timestamp.now() });
  await setDoc(docRef, { ...existing, emotionalObservations: observations }, { merge: true });
}

// ---------------------------------------------------------------------------
// Event storage (#35)
// ---------------------------------------------------------------------------

/**
 * Save extracted events to Firestore.
 * Creates new event documents in the events subcollection.
 */
export async function saveExtractedEvents(
  familyId: string,
  dossierId: string,
  events: Omit<StoryEvent, 'id' | 'createdAt' | 'updatedAt'>[],
): Promise<string[]> {
  const colRef = collection(db, 'families', familyId, 'dossiers', dossierId, 'events');
  const now = Timestamp.now();
  const ids: string[] = [];
  for (const event of events) {
    const docRef = await addDoc(colRef, { ...event, createdAt: now, updatedAt: now });
    ids.push(docRef.id);
  }
  return ids;
}

/**
 * Fetch all events for a dossier.
 */
export async function getEvents(
  familyId: string,
  dossierId: string,
): Promise<StoryEvent[]> {
  const colRef = collection(db, 'families', familyId, 'dossiers', dossierId, 'events');
  const snapshot = await getDocs(colRef);
  return snapshot.docs.map((d) => ({ ...d.data(), id: d.id }) as StoryEvent);
}

// ---------------------------------------------------------------------------
// Family-level event storage (#62)
// ---------------------------------------------------------------------------

/**
 * Save auto-extracted events to the family-level events collection.
 * Called after post-session StoryEvent extraction to promote events to
 * family scope with session and storyteller attribution.
 *
 * Firestore path: families/{familyId}/events/{eventId}
 */
export async function saveFamilyEvents(
  familyId: string,
  events: Omit<FamilyEvent, 'id' | 'createdAt' | 'updatedAt'>[],
): Promise<void> {
  const colRef = collection(db, 'families', familyId, 'events');
  const now = Timestamp.now();
  for (const event of events) {
    await addDoc(colRef, { ...event, createdAt: now, updatedAt: now });
  }
}

// ---------------------------------------------------------------------------
// Engagement storage (#45)
// ---------------------------------------------------------------------------

/**
 * Save engagement assessment for a session.
 */
export async function saveEngagementAssessment(
  familyId: string,
  dossierId: string,
  sessionId: string,
  engagement: Omit<SessionEngagement, 'analyzedAt'>,
): Promise<void> {
  const docRef = doc(
    db, 'families', familyId, 'dossiers', dossierId,
    'sessions', sessionId, 'analysis', 'engagement',
  );
  await setDoc(docRef, { ...engagement, analyzedAt: Timestamp.now() });
}

/**
 * Fetch engagement assessment for a session.
 */
export async function getEngagementAssessment(
  familyId: string,
  dossierId: string,
  sessionId: string,
): Promise<SessionEngagement | null> {
  const docRef = doc(
    db, 'families', familyId, 'dossiers', dossierId,
    'sessions', sessionId, 'analysis', 'engagement',
  );
  const snap = await getDoc(docRef);
  return snap.exists() ? (snap.data() as SessionEngagement) : null;
}

// ---------------------------------------------------------------------------
// Suggested questions storage (#41)
// ---------------------------------------------------------------------------

/**
 * Save AI-suggested questions for a session.
 */
export async function saveSuggestedQuestions(
  familyId: string,
  dossierId: string,
  sessionId: string,
  suggestions: SuggestedQuestion[],
): Promise<void> {
  const docRef = doc(
    db, 'families', familyId, 'dossiers', dossierId,
    'sessions', sessionId, 'analysis', 'suggestions',
  );
  await setDoc(docRef, { suggestions, analyzedAt: Timestamp.now() });
}

/**
 * Fetch AI-suggested questions for a session.
 */
export async function getSuggestedQuestions(
  familyId: string,
  dossierId: string,
  sessionId: string,
): Promise<SuggestedQuestion[]> {
  const docRef = doc(
    db, 'families', familyId, 'dossiers', dossierId,
    'sessions', sessionId, 'analysis', 'suggestions',
  );
  const snap = await getDoc(docRef);
  if (!snap.exists()) return [];
  return snap.data().suggestions ?? [];
}

/**
 * Fetch the transcript entries for a given session.
 */
export async function getTranscriptEntries(
  familyId: string,
  dossierId: string,
  sessionId: string,
): Promise<TranscriptEntry[]> {
  const docRef = doc(
    db, 'families', familyId, 'dossiers', dossierId,
    'sessions', sessionId, 'transcript', 'entries',
  );
  const snap = await getDoc(docRef);
  if (!snap.exists()) return [];
  return snap.data().entries ?? [];
}

// ---------------------------------------------------------------------------
// Transcript editing (#37)
// ---------------------------------------------------------------------------

/**
 * Save edited transcript entries alongside the original.
 * The original entries are never modified.
 */
export async function saveEditedTranscript(
  familyId: string,
  dossierId: string,
  sessionId: string,
  editedEntries: TranscriptEntry[],
  editedBy: string,
): Promise<void> {
  const docRef = doc(
    db, 'families', familyId, 'dossiers', dossierId,
    'sessions', sessionId, 'transcript', 'entries',
  );
  await updateDoc(docRef, {
    editedEntries,
    editedBy,
    editedAt: Timestamp.now(),
  });
}

/**
 * Save an edit to a single storyteller message.
 * - Initialises editedEntries from the original entries on first edit.
 * - Preserves the original AI transcription in originalText (set once).
 * - Appends every edit to the entry's editHistory array.
 */
export async function saveMessageEdit(
  familyId: string,
  dossierId: string,
  sessionId: string,
  messageIndex: number,
  newText: string,
  editedBy: string,
  editedByName: string,
): Promise<void> {
  const docRef = doc(
    db, 'families', familyId, 'dossiers', dossierId,
    'sessions', sessionId, 'transcript', 'entries',
  );
  const snap = await getDoc(docRef);
  if (!snap.exists()) throw new Error('Transcript not found');

  const data = snap.data();
  const baseEntries: TranscriptEntry[] = data.editedEntries ?? data.entries ?? [];
  const now = Timestamp.now();

  const updated: TranscriptEntry[] = baseEntries.map((entry, idx) => {
    if ((entry.messageIndex ?? idx) !== messageIndex) return entry;
    const historyItem: TranscriptEditHistoryEntry = {
      text: newText,
      editedBy,
      editedByName,
      editedAt: now,
    };
    return {
      ...entry,
      text: newText,
      originalText: entry.originalText ?? entry.text,
      editHistory: [...(entry.editHistory ?? []), historyItem],
    };
  });

  await updateDoc(docRef, {
    editedEntries: updated,
    editedBy,
    editedAt: now,
  });
}

// ---------------------------------------------------------------------------
// Memoir storage (#36)
// ---------------------------------------------------------------------------

/**
 * Create a new memoir document.
 */
export async function createMemoir(
  familyId: string,
  dossierId: string,
  memoir: Omit<Memoir, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<string> {
  const colRef = collection(db, 'families', familyId, 'dossiers', dossierId, 'memoirs');
  const now = Timestamp.now();
  const docRef = await addDoc(colRef, { ...memoir, createdAt: now, updatedAt: now });
  return docRef.id;
}

/**
 * Update a memoir document.
 */
export async function updateMemoir(
  familyId: string,
  dossierId: string,
  memoirId: string,
  updates: Partial<Memoir>,
): Promise<void> {
  const docRef = doc(db, 'families', familyId, 'dossiers', dossierId, 'memoirs', memoirId);
  await updateDoc(docRef, { ...updates, updatedAt: Timestamp.now() });
}

/**
 * Fetch all memoirs for a dossier.
 */
export async function getMemoirs(
  familyId: string,
  dossierId: string,
): Promise<Memoir[]> {
  const colRef = collection(db, 'families', familyId, 'dossiers', dossierId, 'memoirs');
  const q = query(colRef, orderBy('createdAt', 'desc'));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => ({ ...d.data(), id: d.id }) as Memoir);
}

/**
 * Fetch all completed sessions with their transcripts for a dossier.
 */
export async function getAllSessionTranscripts(
  familyId: string,
  dossierId: string,
): Promise<{ sessionId: string; entries: import('../types').TranscriptEntry[] }[]> {
  const colRef = collection(db, 'families', familyId, 'dossiers', dossierId, 'sessions');
  const q = query(colRef, where('status', '==', 'completed'), orderBy('startTime', 'asc'));
  const sessionsSnap = await getDocs(q);

  const results: { sessionId: string; entries: import('../types').TranscriptEntry[] }[] = [];
  for (const sessionDoc of sessionsSnap.docs) {
    const entries = await getTranscriptEntries(familyId, dossierId, sessionDoc.id);
    if (entries.length > 0) {
      results.push({ sessionId: sessionDoc.id, entries });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Media attachments (#39)
// ---------------------------------------------------------------------------

/**
 * Upload a media file to Firebase Storage and create a Firestore metadata doc.
 */
export async function uploadMedia(
  familyId: string,
  dossierId: string,
  file: File,
  meta: Pick<MediaItem, 'caption' | 'date' | 'people' | 'eventIds'>,
  uploaderUid: string,
): Promise<string> {
  const mediaId = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const storagePath = `${familyId}/${dossierId}/media/${mediaId}`;
  const storageRef = ref(storage, storagePath);

  await uploadBytes(storageRef, file, { contentType: file.type });
  const storageUrl = await getDownloadURL(storageRef);

  const colRef = collection(db, 'families', familyId, 'dossiers', dossierId, 'media');
  const item: Omit<MediaItem, 'id'> = {
    filename: file.name,
    storageUrl,
    mimeType: file.type,
    sizeBytes: file.size,
    caption: meta.caption,
    date: meta.date,
    people: meta.people,
    eventIds: meta.eventIds,
    uploadedBy: uploaderUid,
    createdAt: Timestamp.now(),
  };
  const docRef = await addDoc(colRef, item);
  return docRef.id;
}

/**
 * Fetch all media items for a dossier.
 */
export async function getMedia(
  familyId: string,
  dossierId: string,
): Promise<MediaItem[]> {
  const colRef = collection(db, 'families', familyId, 'dossiers', dossierId, 'media');
  const q = query(colRef, orderBy('createdAt', 'desc'));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => ({ ...d.data(), id: d.id }) as MediaItem);
}

/**
 * Update a media item's metadata.
 */
export async function updateMedia(
  familyId: string,
  dossierId: string,
  mediaId: string,
  updates: Partial<Pick<MediaItem, 'caption' | 'date' | 'people' | 'eventIds'>>,
): Promise<void> {
  const docRef = doc(db, 'families', familyId, 'dossiers', dossierId, 'media', mediaId);
  await updateDoc(docRef, updates);
}

/**
 * Delete a media item (removes Firestore doc; Storage file remains per "never delete" policy).
 */
export async function deleteMedia(
  familyId: string,
  dossierId: string,
  mediaId: string,
): Promise<void> {
  const { deleteDoc: firestoreDeleteDoc } = await import('firebase/firestore');
  const docRef = doc(db, 'families', familyId, 'dossiers', dossierId, 'media', mediaId);
  await firestoreDeleteDoc(docRef);
}

// ---------------------------------------------------------------------------
// Audio clips (#42)
// ---------------------------------------------------------------------------

/**
 * Save an audio clip (blob + metadata) to Storage and Firestore.
 */
export async function saveAudioClip(
  familyId: string,
  dossierId: string,
  clipBlob: Blob,
  meta: Omit<AudioClip, 'id' | 'clipUrl' | 'createdAt'>,
): Promise<string> {
  const clipId = `clip_${Date.now()}`;
  const storagePath = `${familyId}/${dossierId}/clips/${clipId}.webm`;
  const storageRef = ref(storage, storagePath);

  await uploadBytes(storageRef, clipBlob, { contentType: 'audio/webm;codecs=opus' });
  const clipUrl = await getDownloadURL(storageRef);

  const colRef = collection(db, 'families', familyId, 'dossiers', dossierId, 'clips');
  const docRef = await addDoc(colRef, {
    ...meta,
    clipUrl,
    createdAt: Timestamp.now(),
  });
  return docRef.id;
}

/**
 * Fetch all audio clips for a dossier.
 */
export async function getAudioClips(
  familyId: string,
  dossierId: string,
): Promise<AudioClip[]> {
  const colRef = collection(db, 'families', familyId, 'dossiers', dossierId, 'clips');
  const q = query(colRef, orderBy('createdAt', 'desc'));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => ({ ...d.data(), id: d.id }) as AudioClip);
}

/**
 * Delete an audio clip (Firestore doc only; Storage remains).
 */
export async function deleteAudioClip(
  familyId: string,
  dossierId: string,
  clipId: string,
): Promise<void> {
  const { deleteDoc: firestoreDeleteDoc } = await import('firebase/firestore');
  const docRef = doc(db, 'families', familyId, 'dossiers', dossierId, 'clips', clipId);
  await firestoreDeleteDoc(docRef);
}

// ---------------------------------------------------------------------------
// Prompt photos (#54)
// ---------------------------------------------------------------------------

/**
 * Upload a prompt photo to Firebase Storage and create a Firestore metadata doc.
 */
export async function uploadPromptPhoto(
  familyId: string,
  dossierId: string,
  file: File,
  caption: string,
  uploaderUid: string,
): Promise<string> {
  const photoId = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const storagePath = `${familyId}/${dossierId}/promptPhotos/${photoId}`;
  const storageRef = ref(storage, storagePath);

  await uploadBytes(storageRef, file, { contentType: file.type });
  const storageUrl = await getDownloadURL(storageRef);

  const colRef = collection(db, 'families', familyId, 'dossiers', dossierId, 'promptPhotos');
  const item: Omit<PromptPhoto, 'id'> = {
    storageUrl,
    caption,
    uploadedBy: uploaderUid,
    createdAt: Timestamp.now(),
  };
  const docRef = await addDoc(colRef, item);
  return docRef.id;
}

/**
 * Fetch all prompt photos for a dossier.
 */
export async function getPromptPhotos(
  familyId: string,
  dossierId: string,
): Promise<PromptPhoto[]> {
  const colRef = collection(db, 'families', familyId, 'dossiers', dossierId, 'promptPhotos');
  const q = query(colRef, orderBy('createdAt', 'asc'));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => ({ ...d.data(), id: d.id }) as PromptPhoto);
}

/**
 * Delete a prompt photo (Firestore doc only; Storage remains).
 */
export async function deletePromptPhoto(
  familyId: string,
  dossierId: string,
  photoId: string,
): Promise<void> {
  const { deleteDoc: firestoreDeleteDoc } = await import('firebase/firestore');
  const docRef = doc(db, 'families', familyId, 'dossiers', dossierId, 'promptPhotos', photoId);
  await firestoreDeleteDoc(docRef);
}
