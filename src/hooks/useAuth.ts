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
 * Authentication hook for LegacyBot.
 *
 * Wraps Firebase Auth state in a React hook that provides:
 *   - user:     The currently signed-in Firebase user (or null)
 *   - loading:  Whether the auth state is still being determined
 *   - signInWithGoogle:  Trigger Google OAuth popup sign-in
 *   - signInWithEmail:   Sign in with email/password
 *   - signUpWithEmail:   Register a new account with email/password
 *   - signOut:           Sign the user out and clear local state
 *
 * On first login, a user profile document is created in Firestore at
 * users/{uid} with the user's email and display name.
 *
 * References: design.md §3.1 | GitHub Issue #2
 */

import { useState, useEffect } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  User,
} from 'firebase/auth';
import { doc, getDoc, setDoc, Timestamp } from 'firebase/firestore';
import { auth, db } from '../services/firebase';
import { UserProfile } from '../types';

const googleProvider = new GoogleAuthProvider();

/**
 * Creates a user profile document in Firestore if one doesn't already exist.
 * Called on every auth state change to cover both redirect returns and
 * email sign-ins. Safe to call repeatedly — idempotent.
 */
async function ensureUserProfile(user: User): Promise<void> {
  const userRef = doc(db, 'users', user.uid);
  const snapshot = await getDoc(userRef);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!snapshot.exists()) {
    const profile: UserProfile = {
      email: user.email ?? '',
      displayName: user.displayName ?? user.email ?? 'Anonymous',
      createdAt: Timestamp.now(),
      familyIds: [],
    };
    await setDoc(userRef, { ...profile, timezone });
  } else {
    // Keep timezone current in case the user has travelled or changed system settings.
    const existing = snapshot.data();
    if (existing.timezone !== timezone) {
      await setDoc(userRef, { timezone }, { merge: true });
    }
  }
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Subscribe to Firebase auth state changes on mount.
  // ensureUserProfile runs fire-and-forget so auth state is never gated
  // on a Firestore round-trip (which could fail and leave the UI stuck).
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);
      if (firebaseUser) {
        ensureUserProfile(firebaseUser).catch(console.error);
      }
    });
    return unsubscribe;
  }, []);

  /** Sign in with Google OAuth popup. */
  async function signInWithGoogle(): Promise<void> {
    await signInWithPopup(auth, googleProvider);
  }

  /** Sign in an existing user with email and password. */
  async function signInWithEmail(email: string, password: string): Promise<void> {
    await signInWithEmailAndPassword(auth, email, password);
  }

  /** Create a new account with email and password. */
  async function signUpWithEmail(email: string, password: string): Promise<void> {
    await createUserWithEmailAndPassword(auth, email, password);
  }

  /** Sign the user out of Firebase. */
  async function signOut(): Promise<void> {
    await firebaseSignOut(auth);
  }

  return { user, loading, signInWithGoogle, signInWithEmail, signUpWithEmail, signOut };
}
