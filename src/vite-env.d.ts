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

/// <reference types="vite/client" />

/**
 * Type declarations for Vite environment variables used by the demo app.
 *
 * Only Firebase web config lives here — those values are public by design
 * (security comes from Firestore Rules + GCP API key restrictions).
 *
 * NEVER add a VITE_*_KEY/_SECRET/_TOKEN entry for a sensitive credential.
 * Anything VITE_* prefixed is bundled into the browser JS and is trivially
 * extractable. The Gemini API key is held only by the consumer's
 * server-side broker; VoiceCommon's `tokenProvider` config invokes that
 * broker to mint short-lived ephemeral tokens.
 */
interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string;
  readonly VITE_FIREBASE_PROJECT_ID: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly VITE_FIREBASE_APP_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
