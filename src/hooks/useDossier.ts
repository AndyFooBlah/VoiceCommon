/**
 * Dossier management hook for LegacyBot.
 *
 * Provides CRUD operations for Dossiers stored in Firestore at
 * users/{uid}/dossiers/{dossierId}. Each Dossier represents the full
 * context for interviewing one Storyteller — their name, family tree,
 * historical background, voice/personality preferences, and the Story Queue.
 *
 * The hook also manages the questions subcollection, which tracks the
 * Archivist's Story Queue with status progression (Unasked → InProgress →
 * Completed) and AI-generated findings.
 *
 * Key design decisions:
 *   - Dossier updates are debounced (500ms) to avoid excessive Firestore writes
 *     when the Archivist is actively editing fields.
 *   - Questions are stored as a subcollection (not an array) so they can be
 *     updated individually by the Gemini function-calling tool during a session.
 *   - The hook exposes a flat API: callers don't need to know about Firestore
 *     paths or document references.
 *
 * References: design.md §2.1, §4 | GitHub Issues #4, #5, #6, #7
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  Timestamp,
  writeBatch,
} from 'firebase/firestore';
import { db } from '../services/firebase';
import { Dossier, InterviewQuestion } from '../types';

// ---------------------------------------------------------------------------
// Dossier List — used by the DossierList screen after login
// ---------------------------------------------------------------------------

/**
 * Subscribes to all Dossiers owned by the given user.
 * Returns a live-updating array of Dossier objects.
 */
export function useDossierList(uid: string | undefined) {
  const [dossiers, setDossiers] = useState<Dossier[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!uid) return;

    const colRef = collection(db, 'users', uid, 'dossiers');
    const q = query(colRef, orderBy('updatedAt', 'desc'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const items = snapshot.docs.map((doc) => ({
        ...doc.data(),
        id: doc.id,
      })) as Dossier[];
      setDossiers(items);
      setLoading(false);
    });

    return unsubscribe;
  }, [uid]);

  /** Create a new Dossier with a Storyteller name. Returns the new document ID. */
  async function createDossier(storytellerName: string): Promise<string> {
    if (!uid) throw new Error('Not authenticated');
    const colRef = collection(db, 'users', uid, 'dossiers');
    const now = Timestamp.now();
    const newDossier: Omit<Dossier, 'id'> = {
      storytellerName,
      storytellerContext: '',
      historicalContext: '',
      familyTree: [],
      selectedVoice: 'Zephyr',
      personality: 'empathetic',
      createdAt: now,
      updatedAt: now,
    };
    const docRef = await addDoc(colRef, newDossier);
    return docRef.id;
  }

  /** Permanently delete a Dossier and all its subcollections. */
  async function deleteDossier(dossierId: string): Promise<void> {
    if (!uid) throw new Error('Not authenticated');
    // Note: Firestore doesn't cascade-delete subcollections automatically.
    // For a production app, you'd use a Cloud Function to clean up.
    // For now, we delete the parent document — subcollection data becomes orphaned
    // but inaccessible via the app.
    await deleteDoc(doc(db, 'users', uid, 'dossiers', dossierId));
  }

  return { dossiers, loading, createDossier, deleteDossier };
}

// ---------------------------------------------------------------------------
// Single Dossier — used when editing or running a session
// ---------------------------------------------------------------------------

/**
 * Subscribes to a single Dossier and its questions subcollection.
 * Provides update functions with built-in debouncing for Dossier fields
 * and immediate writes for question status changes (needed for real-time
 * Gemini function-calling updates).
 */
export function useDossier(uid: string | undefined, dossierId: string | undefined) {
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Subscribe to the Dossier document
  useEffect(() => {
    if (!uid || !dossierId) return;

    const docRef = doc(db, 'users', uid, 'dossiers', dossierId);
    const unsubscribe = onSnapshot(docRef, (snapshot) => {
      if (snapshot.exists()) {
        setDossier({ ...snapshot.data(), id: snapshot.id } as Dossier);
      } else {
        setDossier(null);
      }
      setLoading(false);
    });

    return unsubscribe;
  }, [uid, dossierId]);

  // Subscribe to the questions subcollection
  useEffect(() => {
    if (!uid || !dossierId) return;

    const colRef = collection(db, 'users', uid, 'dossiers', dossierId, 'questions');
    const q = query(colRef, orderBy('order', 'asc'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const items = snapshot.docs.map((doc) => ({
        ...doc.data(),
        id: doc.id,
      })) as InterviewQuestion[];
      setQuestions(items);
    });

    return unsubscribe;
  }, [uid, dossierId]);

  // Clean up the debounce timer on unmount to prevent async writes after
  // the component is gone (which would cause a React state update warning).
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  /**
   * Update Dossier fields (debounced 500ms).
   * Used when the Archivist is typing in the editor — avoids excessive writes.
   */
  const updateDossier = useCallback(
    (updates: Partial<Dossier>) => {
      if (!uid || !dossierId) return;

      // Update local state immediately for responsive UI
      setDossier((prev) => (prev ? { ...prev, ...updates } : prev));

      // Debounce the Firestore write
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(async () => {
        const docRef = doc(db, 'users', uid, 'dossiers', dossierId);
        await updateDoc(docRef, { ...updates, updatedAt: Timestamp.now() });
      }, 500);
    },
    [uid, dossierId],
  );

  /** Add a new question to the Story Queue. */
  async function addQuestion(text: string): Promise<void> {
    if (!uid || !dossierId) return;
    const colRef = collection(db, 'users', uid, 'dossiers', dossierId, 'questions');
    const now = Timestamp.now();
    await addDoc(colRef, {
      text,
      status: 'Unasked',
      findings: '',
      order: questions.length, // Append to end
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Remove a question from the Story Queue. */
  async function removeQuestion(questionId: string): Promise<void> {
    if (!uid || !dossierId) return;
    await deleteDoc(doc(db, 'users', uid, 'dossiers', dossierId, 'questions', questionId));
  }

  /**
   * Update a question's fields (text, status, findings, order).
   * This is called both by the Archivist UI (editing text, manual status override)
   * and by the Gemini function-calling tool (status + findings updates).
   * Writes are immediate (not debounced) since the bot needs real-time state.
   */
  async function updateQuestion(
    questionId: string,
    updates: Partial<InterviewQuestion>,
  ): Promise<void> {
    if (!uid || !dossierId) return;
    const docRef = doc(db, 'users', uid, 'dossiers', dossierId, 'questions', questionId);
    await updateDoc(docRef, { ...updates, updatedAt: Timestamp.now() });
  }

  /** Reorder all questions by writing new `order` values in a batch. */
  async function reorderQuestions(orderedIds: string[]): Promise<void> {
    if (!uid || !dossierId) return;
    const batch = writeBatch(db);
    orderedIds.forEach((id, index) => {
      const docRef = doc(db, 'users', uid, 'dossiers', dossierId, 'questions', id);
      batch.update(docRef, { order: index, updatedAt: Timestamp.now() });
    });
    await batch.commit();
  }

  return {
    dossier,
    questions,
    loading,
    updateDossier,
    addQuestion,
    removeQuestion,
    updateQuestion,
    reorderQuestions,
  };
}
