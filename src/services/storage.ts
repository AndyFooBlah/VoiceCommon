// Copyright 2026 Andrew Brook
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Persistence services for VoiceCommon sessions.
 *
 * Handles two core archival operations:
 *   1. Audio upload to Firebase Cloud Storage (WebM/Opus at 128 kbps)
 *   2. Real-time transcript sync to Firestore
 *
 * Default Firestore data model:
 *   sessions/{sessionId}                     → SessionMetadata
 *   sessions/{sessionId}/transcript/entries  → { entries: TranscriptEntry[] }
 *
 * Apps with nested session paths (e.g. families/{id}/dossiers/{id}/sessions)
 * pass a `sessionsCollection` argument to override the root collection.
 *
 * GCS path convention:
 *   gs://{bucket}/sessions/{userId}/{sessionId}.webm
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
import { db, storage, auth } from './firebase';
import { TranscriptEntry, SessionMetadata, SessionStatus } from '../types';

/** Default top-level Firestore collection used for sessions. */
const DEFAULT_SESSIONS = 'sessions';

/**
 * Returns the currently-authenticated user's UID, or throws.
 *
 * Used as defense-in-depth at the client-library boundary: Firestore/Storage
 * rules are the authoritative enforcement, but failing fast client-side when
 * no user is authenticated gives a clearer error and avoids round-tripping
 * unauthenticated requests.
 */
function requireCurrentUserId(): string {
  const uid = auth.currentUser?.uid;
  if (!uid) {
    throw new Error('Not authenticated — call requires a signed-in Firebase user.');
  }
  return uid;
}

/**
 * Verifies the caller owns the given session. Fetches the session document
 * and throws if either it doesn't exist or its userId does not match the
 * current authenticated user.
 *
 * Defense-in-depth — Firestore rules already enforce this, but a client-side
 * check surfaces ownership errors with clearer messages and prevents partial
 * writes on subcollections whose rules cascade via get() lookups.
 */
async function requireSessionOwnership(
  sessionId: string,
  sessionsCollection: string,
): Promise<string> {
  const uid = requireCurrentUserId();
  const snap = await getDoc(doc(db, sessionsCollection, sessionId));
  if (!snap.exists()) {
    throw new Error(`Session ${sessionId} not found.`);
  }
  const data = snap.data();
  if (data.userId !== uid) {
    throw new Error(`Session ${sessionId} is not owned by the current user.`);
  }
  return uid;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Creates a new session document in Firestore and returns its ID.
 *
 * @param userId - The authenticated user's UID, stored on the document.
 * @param sessionsCollection - Firestore collection path (default: 'sessions').
 *   Use a nested path for apps with family-scoped access control, e.g.
 *   'families/{familyId}/dossiers/{dossierId}/sessions'.
 */
export async function createSession(
  userId: string,
  sessionsCollection = DEFAULT_SESSIONS,
  additionalData: Record<string, any> = {},
): Promise<string> {
  const currentUid = requireCurrentUserId();
  if (userId !== currentUid) {
    throw new Error('createSession: userId must match the authenticated user.');
  }
  const colRef = collection(db, sessionsCollection);
  const session: Omit<SessionMetadata, 'id'> & Record<string, any> = {
    ...additionalData,
    userId,
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
 *
 * @param sessionsCollection - Must match the value passed to `createSession`.
 */
export async function finalizeSession(
  sessionId: string,
  status: SessionStatus,
  durationSeconds: number,
  audioUrl?: string,
  sessionsCollection = DEFAULT_SESSIONS,
): Promise<void> {
  await requireSessionOwnership(sessionId, sessionsCollection);
  const docRef = doc(db, sessionsCollection, sessionId);
  await updateDoc(docRef, {
    endTime: Timestamp.now(),
    status,
    durationSeconds,
    ...(audioUrl ? { audioUrl } : {}),
  });
}

// ---------------------------------------------------------------------------
// Session queries
// ---------------------------------------------------------------------------

/**
 * Fetch all sessions for a user, ordered by start time descending.
 */
export async function getUserSessions(
  userId: string,
  sessionsCollection = DEFAULT_SESSIONS,
): Promise<SessionMetadata[]> {
  const colRef = collection(db, sessionsCollection);
  const q = query(
    colRef,
    where('userId', '==', userId),
    orderBy('startTime', 'desc'),
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => ({ ...d.data(), id: d.id }) as SessionMetadata);
}

/**
 * Fetch a single session by ID.
 */
export async function getSession(
  sessionId: string,
  sessionsCollection = DEFAULT_SESSIONS,
): Promise<SessionMetadata | null> {
  const docRef = doc(db, sessionsCollection, sessionId);
  const snap = await getDoc(docRef);
  return snap.exists() ? ({ ...snap.data(), id: snap.id } as SessionMetadata) : null;
}

/**
 * Returns the count of completed sessions for a user.
 */
export async function getCompletedSessionCount(
  userId: string,
  sessionsCollection = DEFAULT_SESSIONS,
): Promise<number> {
  const colRef = collection(db, sessionsCollection);
  const q = query(colRef, where('userId', '==', userId), where('status', '==', 'completed'));
  const snapshot = await getDocs(q);
  return snapshot.size;
}

/**
 * Returns the start dates of the most recent N completed sessions for a user.
 */
export async function getRecentSessionDates(
  userId: string,
  limit: number = 3,
  sessionsCollection = DEFAULT_SESSIONS,
): Promise<Date[]> {
  const colRef = collection(db, sessionsCollection);
  const q = query(
    colRef,
    where('userId', '==', userId),
    where('status', '==', 'completed'),
    orderBy('startTime', 'desc'),
    firestoreLimit(limit),
  );
  const snapshot = await getDocs(q);
  return snapshot.docs
    .map((d) => d.data().startTime?.toDate?.())
    .filter((d): d is Date => d instanceof Date);
}

// ---------------------------------------------------------------------------
// Audio archival (GCS)
// ---------------------------------------------------------------------------

/**
 * Uploads a recorded audio blob to Firebase Cloud Storage.
 * Returns the public download URL.
 *
 * Path: sessions/{userId}/{sessionId}.webm
 */
export async function archiveAudioToGCS(
  audioBlob: Blob,
  userId: string,
  sessionId: string,
): Promise<string> {
  const currentUid = requireCurrentUserId();
  if (userId !== currentUid) {
    throw new Error('archiveAudioToGCS: userId must match the authenticated user.');
  }
  const storagePath = `sessions/${userId}/${sessionId}.webm`;
  const storageRef = ref(storage, storagePath);

  await uploadBytes(storageRef, audioBlob, {
    contentType: 'audio/webm;codecs=opus',
  });

  return getDownloadURL(storageRef);
}

// ---------------------------------------------------------------------------
// Transcript sync (Firestore)
// ---------------------------------------------------------------------------

/**
 * Writes the full transcript to the session's transcript document.
 * Overwrites the previous state on each call (full replace, not append).
 *
 * @param sessionsCollection - Must match the value passed to `createSession`.
 */
export async function syncTranscriptToFirestore(
  sessionId: string,
  entries: TranscriptEntry[],
  sessionsCollection = DEFAULT_SESSIONS,
): Promise<void> {
  // Hot path — called on every transcript entry. Skip the session-ownership
  // read here (Firestore rules still enforce it) and just require an auth'd
  // user, which catches the common "caller forgot to check auth" mistake.
  requireCurrentUserId();
  const docRef = doc(db, sessionsCollection, sessionId, 'transcript', 'entries');
  await setDoc(docRef, { entries }, { merge: false });
}

/**
 * Fetch the transcript entries for a given session.
 *
 * @param sessionsCollection - Must match the value passed to `createSession`.
 */
export async function getTranscriptEntries(
  sessionId: string,
  sessionsCollection = DEFAULT_SESSIONS,
): Promise<TranscriptEntry[]> {
  await requireSessionOwnership(sessionId, sessionsCollection);
  const docRef = doc(db, sessionsCollection, sessionId, 'transcript', 'entries');
  const snap = await getDoc(docRef);
  if (!snap.exists()) return [];
  return snap.data().entries ?? [];
}
