/**
 * Invitation service for LegacyBot.
 * Handles CRUD operations for the invitations collection and the accept flow.
 *
 * Firestore path: invitations/{inviteId}
 */

import {
  collection,
  doc,
  addDoc,
  updateDoc,
  getDoc,
  getDocs,
  query,
  where,
  Timestamp,
  writeBatch,
  arrayUnion,
} from 'firebase/firestore';
import { db } from './firebase';
import { Invitation, UserRole, FamilyMemberRecord } from '../types';

/**
 * Creates a new invitation document. The Cloud Function trigger will send the email.
 */
export async function createInvitation(
  familyId: string,
  email: string,
  roles: UserRole[],
  dossierIds: string[],
  invitedBy: string,
): Promise<string> {
  const colRef = collection(db, 'invitations');
  const invitation: Omit<Invitation, 'id'> = {
    familyId,
    email: email.toLowerCase(),
    roles,
    dossierIds,
    invitedBy,
    status: 'pending',
    createdAt: Timestamp.now(),
  };
  const docRef = await addDoc(colRef, invitation);
  return docRef.id;
}

/**
 * Fetches a single invitation by ID.
 */
export async function getInvitation(inviteId: string): Promise<Invitation | null> {
  const docRef = doc(db, 'invitations', inviteId);
  const snapshot = await getDoc(docRef);
  if (!snapshot.exists()) return null;
  return { ...snapshot.data(), id: snapshot.id } as Invitation;
}

/**
 * Fetches all pending invitations for a given email address.
 */
export async function getPendingInvitationsForEmail(email: string): Promise<Invitation[]> {
  const colRef = collection(db, 'invitations');
  const q = query(colRef, where('email', '==', email.toLowerCase()), where('status', '==', 'pending'));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => ({ ...d.data(), id: d.id }) as Invitation);
}

/**
 * Fetches all pending invitations created by admins for a given family.
 */
export async function getPendingInvitationsForFamily(familyId: string): Promise<Invitation[]> {
  const colRef = collection(db, 'invitations');
  const q = query(colRef, where('familyId', '==', familyId), where('status', '==', 'pending'));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => ({ ...d.data(), id: d.id }) as Invitation);
}

/**
 * Cancels a pending invitation by deleting the document.
 */
export async function cancelInvitation(inviteId: string): Promise<void> {
  const { deleteDoc: firestoreDeleteDoc } = await import('firebase/firestore');
  const docRef = doc(db, 'invitations', inviteId);
  await firestoreDeleteDoc(docRef);
}

/**
 * Accepts an invitation: creates a family member record, updates user.familyIds,
 * links storyteller to dossiers if applicable, and marks invitation as accepted.
 * All writes are batched for atomicity.
 */
export async function acceptInvitation(
  inviteId: string,
  uid: string,
  displayName: string,
  email: string,
): Promise<void> {
  const invitation = await getInvitation(inviteId);
  if (!invitation) throw new Error('Invitation not found');
  if (invitation.status !== 'pending') throw new Error('Invitation already accepted');

  // Step 1: Create member record, update user profile, and mark invitation accepted.
  // These must complete first so the user is a family member before step 2.
  const batch = writeBatch(db);

  const memberRef = doc(db, 'families', invitation.familyId, 'members', uid);
  const memberData: FamilyMemberRecord = {
    roles: invitation.roles,
    email: email.toLowerCase(),
    displayName,
    joinedAt: Timestamp.now(),
    invitedBy: invitation.invitedBy,
  };
  batch.set(memberRef, memberData);

  const userRef = doc(db, 'users', uid);
  batch.update(userRef, { familyIds: arrayUnion(invitation.familyId) });

  const inviteRef = doc(db, 'invitations', inviteId);
  batch.update(inviteRef, { status: 'accepted' });

  await batch.commit();

  // Step 2: Link storyteller to dossiers. Done separately because Firestore
  // rules evaluate against pre-batch state — the member doc must already
  // exist for the dossier write rules to pass.
  if (invitation.roles.includes('storyteller') && invitation.dossierIds.length > 0) {
    const dossierBatch = writeBatch(db);
    for (const dossierId of invitation.dossierIds) {
      const dossierRef = doc(db, 'families', invitation.familyId, 'dossiers', dossierId);
      dossierBatch.update(dossierRef, { storytellerUid: uid });
    }
    await dossierBatch.commit();
  }
}
