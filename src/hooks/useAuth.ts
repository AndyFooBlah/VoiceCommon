/**
 * Authentication hook for LegacyBot.
 *
 * Wraps Firebase Auth state in a React hook that provides:
 *   - user:     The currently signed-in Firebase user (or null)
 *   - loading:  Whether the auth state is still being determined
 *   - signInWithGoogle:  Trigger Google OAuth popup sign-in
 *   - signInWithEmail:   Sign in (or register) with email/password
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
 * Called after every successful sign-in to handle first-time users.
 */
async function ensureUserProfile(user: User): Promise<void> {
  const userRef = doc(db, 'users', user.uid);
  const snapshot = await getDoc(userRef);
  if (!snapshot.exists()) {
    const profile: UserProfile = {
      email: user.email ?? '',
      displayName: user.displayName ?? user.email ?? 'Anonymous',
      createdAt: Timestamp.now(),
    };
    await setDoc(userRef, profile);
  }
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Subscribe to Firebase auth state changes on mount.
  // This handles page reloads — if the user was previously signed in,
  // Firebase restores the session automatically.
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  /** Sign in with Google OAuth popup. */
  async function signInWithGoogle(): Promise<void> {
    const result = await signInWithPopup(auth, googleProvider);
    await ensureUserProfile(result.user);
  }

  /**
   * Sign in with email and password.
   * If the account doesn't exist, it's created automatically (registration).
   */
  async function signInWithEmail(email: string, password: string): Promise<void> {
    let result;
    try {
      result = await signInWithEmailAndPassword(auth, email, password);
    } catch (error: any) {
      // If the user doesn't exist, create the account
      if (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential') {
        result = await createUserWithEmailAndPassword(auth, email, password);
      } else {
        throw error;
      }
    }
    await ensureUserProfile(result.user);
  }

  /** Sign the user out of Firebase. */
  async function signOut(): Promise<void> {
    await firebaseSignOut(auth);
  }

  return { user, loading, signInWithGoogle, signInWithEmail, signOut };
}
