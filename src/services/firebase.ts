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
 * Firebase SDK initialization for VoiceCommon.
 *
 * Firebase is initialized lazily — service exports (`auth`, `db`, `storage`,
 * `functions`) are assigned when `_initFirebase()` is called by
 * `initializeVoiceCommon()` in config.ts. This allows VoiceCommon to be
 * used as an npm package without Vite environment variables.
 *
 * All usages of these exports are inside function bodies, so live bindings
 * will have been assigned by the time any hook or service is first called.
 */

import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { getStorage, type FirebaseStorage } from 'firebase/storage';
import { getFunctions, type Functions } from 'firebase/functions';

/** Firebase project configuration passed to `initializeVoiceCommon()`. */
export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId?: string;
  appId: string;
}

// Definite-assignment exports — populated by _initFirebase() before first use.
// eslint-disable-next-line prefer-const
export let auth!: Auth;
// eslint-disable-next-line prefer-const
export let db!: Firestore;
// eslint-disable-next-line prefer-const
export let storage!: FirebaseStorage;
// eslint-disable-next-line prefer-const
export let functions!: Functions;

/**
 * Initialize Firebase and assign the service exports.
 * Called internally by `initializeVoiceCommon()` — do not call directly.
 */
export function _initFirebase(config: FirebaseConfig): FirebaseApp {
  const app = initializeApp(config);
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app);
  functions = getFunctions(app);
  return app;
}
