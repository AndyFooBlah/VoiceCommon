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
 * Firestore data model:
 *   users/{uid}                              → UserProfile
 *   sessions/{sessionId}                     → SessionMetadata
 *   sessions/{sessionId}/transcript/entries  → { entries: TranscriptEntry[] }
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
import { db, storage } from './firebase';
import { TranscriptEntry, SessionMetadata, SessionStatus } from '../types';

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Creates a new session document in Firestore and returns its ID.
 */
export async function createSession(userId: string): Promise<string> {
  const colRef = collection(db, 'sessions');
  const session: Omit<SessionMetadata, 'id'> = {
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
 */
export async function finalizeSession(
  sessionId: string,
  status: 'completed' | 'interrupted',
  durationSeconds: number,
  audioUrl?: string,
): Promise<void> {
  const docRef = doc(db, 'sessions', sessionId);
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
export async function getUserSessions(userId: string): Promise<SessionMetadata[]> {
  const colRef = collection(db, 'sessions');
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
export async function getSession(sessionId: string): Promise<SessionMetadata | null> {
  const docRef = doc(db, 'sessions', sessionId);
  const snap = await getDoc(docRef);
  return snap.exists() ? ({ ...snap.data(), id: snap.id } as SessionMetadata) : null;
}

/**
 * Returns the count of completed sessions for a user.
 */
export async function getCompletedSessionCount(userId: string): Promise<number> {
  const colRef = collection(db, 'sessions');
  const q = query(colRef, where('userId', '==', userId), where('status', '==', 'completed'));
  const snapshot = await getDocs(q);
  return snapshot.size;
}

/**
 * Returns the start dates of the most recent N completed sessions for a user.
 */
export async function getRecentSessionDates(userId: string, limit: number = 3): Promise<Date[]> {
  const colRef = collection(db, 'sessions');
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
 */
export async function syncTranscriptToFirestore(
  sessionId: string,
  entries: TranscriptEntry[],
): Promise<void> {
  const docRef = doc(db, 'sessions', sessionId, 'transcript', 'entries');
  await setDoc(docRef, { entries }, { merge: false });
}

/**
 * Fetch the transcript entries for a given session.
 */
export async function getTranscriptEntries(sessionId: string): Promise<TranscriptEntry[]> {
  const docRef = doc(db, 'sessions', sessionId, 'transcript', 'entries');
  const snap = await getDoc(docRef);
  if (!snap.exists()) return [];
  return snap.data().entries ?? [];
}
