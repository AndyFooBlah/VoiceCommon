/**
 * Family events management hook for LegacyBot.
 * Provides event CRUD for family-level events.
 *
 * Firestore paths:
 *   families/{familyId}/events/{eventId}
 */

import { useState, useEffect } from 'react';
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
} from 'firebase/firestore';
import { db } from '../services/firebase';
import { FamilyEvent } from '../types';

/**
 * Subscribe to all events for a family.
 */
export function useFamilyEvents(familyId: string | undefined) {
  const [events, setEvents] = useState<(FamilyEvent & { id: string })[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!familyId) {
      setEvents([]);
      setLoading(false);
      return;
    }

    const colRef = collection(db, 'families', familyId, 'events');
    const q = query(colRef, orderBy('createdAt', 'desc'));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const items = snapshot.docs.map((d) => ({
          ...d.data(),
          id: d.id,
        })) as (FamilyEvent & { id: string })[];
        setEvents(items);
        setLoading(false);
      },
      (err) => {
        console.error('useFamilyEvents snapshot error:', err);
        setLoading(false);
      },
    );

    return unsubscribe;
  }, [familyId]);

  return { events, loading };
}

/**
 * Create a new event for a family.
 */
export async function createEvent(
  familyId: string,
  title: string,
  description: string,
  date: string | undefined,
  createdBy: string,
): Promise<string> {
  const now = Timestamp.now();

  const eventData: Omit<FamilyEvent, 'id'> = {
    familyId,
    title,
    date: date || undefined,
    description,
    storytellerUids: [],
    sessionIds: [],
    createdAt: now,
    updatedAt: now,
    createdBy,
  };

  const eventRef = await addDoc(collection(db, 'families', familyId, 'events'), eventData);
  return eventRef.id;
}

/**
 * Update an existing event.
 */
export async function updateEvent(
  familyId: string,
  eventId: string,
  updates: Partial<Pick<FamilyEvent, 'title' | 'description' | 'date'>>,
): Promise<void> {
  const docRef = doc(db, 'families', familyId, 'events', eventId);
  await updateDoc(docRef, {
    ...updates,
    updatedAt: Timestamp.now(),
  });
}

/**
 * Delete an event.
 */
export async function deleteEvent(familyId: string, eventId: string): Promise<void> {
  const docRef = doc(db, 'families', familyId, 'events', eventId);
  await deleteDoc(docRef);
}
