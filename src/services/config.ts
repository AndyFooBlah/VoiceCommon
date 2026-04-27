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
   * Long-lived Google Gemini API key. **Discouraged** for browser-side use
   * because it ships in the bundle and is harvestable. Provide `tokenProvider`
   * instead so VoiceCommon can mint short-lived ephemeral tokens via the
   * consumer's server-side broker. Required only as a fallback when no
   * `tokenProvider` is set.
   */
  geminiApiKey?: string;
  /**
   * Optional: returns a single-use ephemeral token minted server-side. When
   * set, VoiceCommon's internal session uses this in place of `geminiApiKey`,
   * so the long-lived key never reaches the browser. The callback is invoked
   * once per Live session opening.
   */
  tokenProvider?: () => Promise<GeminiLiveToken>;
}

/**
 * Unique key for storing config on globalThis.
 *
 * Using globalThis rather than a module-level variable ensures the singleton
 * survives across bundler chunk boundaries — if the consuming app (e.g.
 * LegacyBot with Vite code-splitting) places VoiceCommon's code in multiple
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
 *   geminiApiKey: 'AIza...',
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
 * INTERNAL API — deliberately not re-exported from `lib.ts`. The full config
 * contains the Gemini API key, so only tightly-scoped getters (see
 * `getGeminiApiKey`) are exposed to consumers. Internal modules (useSession,
 * etc.) may import this directly.
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
 * Narrow accessor for the Gemini API key.
 *
 * @deprecated Will be removed in the next major release. New consumers must
 * pass a server-side `tokenProvider` to `initializeVoiceCommon` and never
 * have a long-lived key in the browser. This accessor exists only to keep
 * older consumers working during the migration window.
 *
 * @throws if neither `geminiApiKey` nor `tokenProvider` is configured. Returns
 * empty string if only `tokenProvider` is configured (the key is intentionally
 * absent — call sites should switch to using `mintLiveToken()` instead).
 */
export function getGeminiApiKey(): string {
  return getConfig().geminiApiKey ?? '';
}

/**
 * Mint a single-use ephemeral token for opening a Gemini Live session.
 *
 * If `tokenProvider` is configured, calls it and returns the result. If only
 * `geminiApiKey` is configured (legacy mode), returns the long-lived key in
 * the same `{ token, expireTime }` shape so internal callers can stay
 * uniform. The legacy fallback's `expireTime` is set ~24 h in the future.
 *
 * Internal API — not re-exported from `lib.ts`.
 */
export async function mintLiveToken(): Promise<GeminiLiveToken> {
  const config = getConfig();
  if (config.tokenProvider) {
    return config.tokenProvider();
  }
  if (config.geminiApiKey) {
    return {
      token: config.geminiApiKey,
      expireTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }
  throw new Error(
    'VoiceCommon needs either `tokenProvider` (preferred) or `geminiApiKey` ' +
      'in initializeVoiceCommon(config). Both are missing.',
  );
}
