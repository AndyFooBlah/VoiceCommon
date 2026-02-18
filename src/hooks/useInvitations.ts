/**
 * Invitation management hook for LegacyBot.
 * Provides invitation creation (admin) and acceptance flows.
 *
 * Firestore path: invitations/{inviteId}
 */

import { useState, useEffect, useCallback } from 'react';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../services/firebase';
import { Invitation, UserRole } from '../types';
import {
  createInvitation as createInvitationService,
  acceptInvitation as acceptInvitationService,
  getInvitation,
  getPendingInvitationsForEmail,
} from '../services/invitations';

/**
 * Hook for admins to manage invitations for a family.
 * Subscribes to pending invitations in real-time.
 */
export function useFamilyInvitations(familyId: string | undefined) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!familyId) {
      setInvitations([]);
      setLoading(false);
      return;
    }

    const colRef = collection(db, 'invitations');
    const q = query(
      colRef,
      where('familyId', '==', familyId),
      where('status', '==', 'pending'),
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const items = snapshot.docs.map((d) => ({
          ...d.data(),
          id: d.id,
        })) as Invitation[];
        setInvitations(items);
        setLoading(false);
      },
      (err) => {
        console.error('useFamilyInvitations snapshot error:', err);
        setLoading(false);
      },
    );

    return unsubscribe;
  }, [familyId]);

  const createInvite = useCallback(
    async (email: string, roles: UserRole[], dossierIds: string[], invitedBy: string) => {
      if (!familyId) throw new Error('No family selected');
      return createInvitationService(familyId, email, roles, dossierIds, invitedBy);
    },
    [familyId],
  );

  return { invitations, loading, createInvite };
}

/**
 * Hook for accepting an invitation by invite ID.
 */
export function useAcceptInvitation() {
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadInvitation = useCallback(async (inviteId: string) => {
    setLoading(true);
    setError(null);
    try {
      const invite = await getInvitation(inviteId);
      setInvitation(invite);
      if (!invite) setError('Invitation not found');
    } catch (err) {
      setError('Failed to load invitation');
    } finally {
      setLoading(false);
    }
  }, []);

  const accept = useCallback(
    async (inviteId: string, uid: string, displayName: string, email: string) => {
      setLoading(true);
      setError(null);
      try {
        await acceptInvitationService(inviteId, uid, displayName, email);
        setInvitation((prev) => (prev ? { ...prev, status: 'accepted' } : prev));
      } catch (err: any) {
        setError(err.message || 'Failed to accept invitation');
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  return { invitation, loading, error, loadInvitation, accept };
}

/**
 * Hook to get pending invitations for the current user's email.
 */
export function usePendingInvitations(email: string | undefined) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!email) {
      setInvitations([]);
      setLoading(false);
      return;
    }

    const colRef = collection(db, 'invitations');
    const q = query(
      colRef,
      where('email', '==', email.toLowerCase()),
      where('status', '==', 'pending'),
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const items = snapshot.docs.map((d) => ({
          ...d.data(),
          id: d.id,
        })) as Invitation[];
        setInvitations(items);
        setLoading(false);
      },
      (err) => {
        console.error('usePendingInvitations snapshot error:', err);
        setLoading(false);
      },
    );

    return unsubscribe;
  }, [email]);

  return { invitations, loading };
}
