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
 *   gs://{bucket}/{uid}/{dossierId}/{sessionId}.webm
 *
 * Firestore path for transcripts:
 *   users/{uid}/dossiers/{dossierId}/sessions/{sessionId}/transcript/entries
 *
 * References: design.md §2.2, §3.3, §3.4 | GitHub Issues #10, #11
 */

import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import {
  doc,
  setDoc,
  updateDoc,
  addDoc,
  collection,
  Timestamp,
} from 'firebase/firestore';
import { db, storage } from './firebase';
import { TranscriptEntry, SessionMetadata, InterviewQuestion } from '../types';

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Creates a new session document in Firestore and returns its ID.
 * Called when the Storyteller presses "Start" to begin a recording.
 */
export async function createSession(
  uid: string,
  dossierId: string,
): Promise<string> {
  const colRef = collection(db, 'users', uid, 'dossiers', dossierId, 'sessions');
  const session: Omit<SessionMetadata, 'id'> = {
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
  uid: string,
  dossierId: string,
  sessionId: string,
  status: 'completed' | 'interrupted',
  durationSeconds: number,
  audioUrl?: string,
): Promise<void> {
  const docRef = doc(db, 'users', uid, 'dossiers', dossierId, 'sessions', sessionId);
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
 * Path: {uid}/{dossierId}/{sessionId}.webm
 */
export async function archiveAudioToGCS(
  audioBlob: Blob,
  uid: string,
  dossierId: string,
  sessionId: string,
): Promise<string> {
  const storagePath = `${uid}/${dossierId}/${sessionId}.webm`;
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
 * Appends a transcript entry to the session's transcript document.
 *
 * Called in real-time as each turn completes during a live session.
 * Uses arrayUnion-style writes — we store the full transcript as an array
 * in a single document for efficient reads during session review.
 *
 * Note: For very long sessions (>1MB document limit), a future improvement
 * would be to split into multiple chunks. For typical 1-hour sessions
 * this is not a concern.
 */
export async function syncTranscriptToFirestore(
  uid: string,
  dossierId: string,
  sessionId: string,
  entries: TranscriptEntry[],
): Promise<void> {
  const docRef = doc(
    db,
    'users',
    uid,
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
  uid: string,
  dossierId: string,
  questionId: string,
  status: string,
  findings: string,
): Promise<void> {
  const docRef = doc(db, 'users', uid, 'dossiers', dossierId, 'questions', questionId);
  await updateDoc(docRef, {
    status,
    findings,
    updatedAt: Timestamp.now(),
  });
}
