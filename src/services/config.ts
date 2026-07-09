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
 * VoiceCommon initialization and configuration.
 *
 * Consumers call `initializeVoiceCommon(config)` once at app startup
 * (before rendering) to supply Firebase and API key configuration.
 * All internal services use `getConfig()` to read these values at
 * call time — never at module load time — so the library is safe to
 * import as an npm package without Vite environment variables.
 */

import type { FirebaseConfig } from './firebase';
import { _initFirebase } from './firebase';

/** Ephemeral token returned by the consumer's server-side broker. */
export interface GeminiLiveToken {
  /** Single-use token string passed as `apiKey` to GoogleGenAI's live.connect(). */
  token: string;
  /** ISO timestamp when the token (and the Live session) expires. */
  expireTime: string;
}

/** Full configuration required to use VoiceCommon. */
export interface VoiceCommonConfig {
  /** Firebase project configuration. */
  firebase: FirebaseConfig;
  /**
   * Returns a single-use ephemeral token minted by the consumer's server-side
   * broker. **Required.** VoiceCommon never accepts a long-lived Gemini API
   * key — the prior `geminiApiKey` field has been removed because it caused
   * the key to ship in the consumer's browser bundle. Implement this callback
   * by calling your own Cloud Function that holds `GEMINI_API_KEY` in Secret
   * Manager and returns a short-lived token (e.g. via Gemini's
   * `authTokens.create` API).
   *
   * Invoked once per Live session opening.
   */
  tokenProvider: () => Promise<GeminiLiveToken>;
  /**
   * Enable verbose diagnostic logging that may include conversation content
   * (speech transcription previews, tool result bodies). Default false —
   * without it, VoiceCommon logs lifecycle events but not what was said.
   */
  debug?: boolean;
}

/**
 * Unique key for storing config on globalThis.
 *
 * Using globalThis rather than a module-level variable ensures the singleton
 * survives across bundler chunk boundaries — if the consuming app (e.g. one
 * using Vite code-splitting) places VoiceCommon's code in multiple
 * chunks, all copies share the same globalThis and therefore the same config.
 *
 * A Symbol (via Symbol.for) is used instead of a string property so third-party
 * code scanning Object.keys(globalThis) does not surface the config. The
 * registry-based Symbol.for lookup still gives us cross-chunk singleton behavior.
 */
const GLOBAL_CONFIG_KEY = Symbol.for('@andyfooblah/voice-common/config');

/**
 * Initialize VoiceCommon with your app's configuration.
 *
 * Must be called once before using any VoiceCommon hooks or services.
 * Typically called in your app entry point before `ReactDOM.createRoot()`.
 *
 * @example
 * ```ts
 * initializeVoiceCommon({
 *   firebase: { apiKey: '...', authDomain: '...', projectId: '...', storageBucket: '...', appId: '...' },
 *   // Required — calls your server-side broker, which holds GEMINI_API_KEY
 *   // and returns a single-use ephemeral Live token.
 *   tokenProvider: async () => {
 *     const result = await myMintGeminiLiveTokenCallable();
 *     return result.data; // { token: string, expireTime: string }
 *   },
 * });
 * ```
 */
export function initializeVoiceCommon(config: VoiceCommonConfig): void {
  (globalThis as Record<symbol, unknown>)[GLOBAL_CONFIG_KEY] = config;
  _initFirebase(config.firebase);
}

/**
 * Returns the active VoiceCommon configuration.
 *
 * INTERNAL API — deliberately not re-exported from `lib.ts`. The config holds
 * the consumer's `tokenProvider` (the capability to mint Live tokens), so only
 * tightly-scoped internal helpers (see `mintLiveToken`) read it. Internal
 * modules (useSession, etc.) may import this directly.
 *
 * Throws if `initializeVoiceCommon()` has not been called yet.
 */
export function getConfig(): VoiceCommonConfig {
  const config = (globalThis as Record<symbol, unknown>)[GLOBAL_CONFIG_KEY] as VoiceCommonConfig | undefined;
  if (!config) {
    throw new Error(
      'VoiceCommon is not initialized. Call initializeVoiceCommon(config) before using any VoiceCommon hooks or services.',
    );
  }
  return config;
}

/**
 * Mint a single-use ephemeral token for opening a Gemini Live session by
 * delegating to the consumer's `tokenProvider`.
 *
 * Internal API — not re-exported from `lib.ts`.
 */
export async function mintLiveToken(): Promise<GeminiLiveToken> {
  return getConfig().tokenProvider();
}

/**
 * Whether verbose content-bearing diagnostic logging is enabled.
 *
 * Internal API — not re-exported from `lib.ts`. Safe to call before
 * `initializeVoiceCommon()` (returns false rather than throwing) so logging
 * call sites never crash a session over a config read.
 */
export function isDebugEnabled(): boolean {
  const config = (globalThis as Record<symbol, unknown>)[GLOBAL_CONFIG_KEY] as
    | VoiceCommonConfig
    | undefined;
  return config?.debug === true;
}
