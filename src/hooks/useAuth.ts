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

async function ensureUserProfile(user: User): Promise<void> {
  console.log('[Auth] ensureUserProfile start uid=' + user.uid);
  const userRef = doc(db, 'users', user.uid);
  let snapshot;
  try {
    snapshot = await getDoc(userRef);
    console.log('[Auth] ensureUserProfile getDoc ok, exists=' + snapshot.exists());
  } catch (err) {
    console.error('[Auth] ensureUserProfile getDoc FAILED:', err);
    throw err;
  }
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!snapshot.exists()) {
    const profile: UserProfile = {
      email: user.email ?? '',
      displayName: user.displayName ?? user.email ?? 'Anonymous',
      createdAt: Timestamp.now(),
      familyIds: [],
    };
    try {
      await setDoc(userRef, { ...profile, timezone });
      console.log('[Auth] ensureUserProfile created new profile');
    } catch (err) {
      console.error('[Auth] ensureUserProfile setDoc (create) FAILED:', err);
      throw err;
    }
  } else {
    const existing = snapshot.data();
    if (existing.timezone !== timezone) {
      try {
        await setDoc(userRef, { timezone }, { merge: true });
        console.log('[Auth] ensureUserProfile updated timezone');
      } catch (err) {
        console.error('[Auth] ensureUserProfile setDoc (timezone) FAILED:', err);
        throw err;
      }
    } else {
      console.log('[Auth] ensureUserProfile profile up-to-date, no write needed');
    }
  }
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    console.log('[Auth] onAuthStateChanged listener registered');
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      console.log('[Auth] onAuthStateChanged fired, uid=' + (firebaseUser?.uid ?? 'null'));
      setUser(firebaseUser);
      setLoading(false);
      if (firebaseUser) {
        ensureUserProfile(firebaseUser).catch((err) =>
          console.error('[Auth] ensureUserProfile (background) error:', err)
        );
      }
    });
    return () => {
      console.log('[Auth] onAuthStateChanged listener removed');
      unsubscribe();
    };
  }, []);

  async function signInWithGoogle(): Promise<void> {
    console.log('[Auth] signInWithGoogle called');
    try {
      await signInWithPopup(auth, googleProvider);
      console.log('[Auth] signInWithPopup resolved');
    } catch (err) {
      console.error('[Auth] signInWithPopup error:', err);
      throw err;
    }
  }

  async function signInWithEmail(email: string, password: string): Promise<void> {
    console.log('[Auth] signInWithEmail called for', email);
    try {
      await signInWithEmailAndPassword(auth, email, password);
      console.log('[Auth] signInWithEmailAndPassword resolved');
    } catch (err) {
      console.error('[Auth] signInWithEmailAndPassword error:', err);
      throw err;
    }
  }

  async function signUpWithEmail(email: string, password: string): Promise<void> {
    console.log('[Auth] signUpWithEmail called for', email);
    try {
      await createUserWithEmailAndPassword(auth, email, password);
      console.log('[Auth] createUserWithEmailAndPassword resolved');
    } catch (err) {
      console.error('[Auth] createUserWithEmailAndPassword error:', err);
      throw err;
    }
  }

  async function signOut(): Promise<void> {
    console.log('[Auth] signOut called');
    await firebaseSignOut(auth);
    console.log('[Auth] signOut complete');
  }

  return { user, loading, signInWithGoogle, signInWithEmail, signUpWithEmail, signOut };
}
