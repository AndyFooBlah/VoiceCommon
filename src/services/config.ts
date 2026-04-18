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

/** Full configuration required to use VoiceCommon. */
export interface VoiceCommonConfig {
  /** Firebase project configuration. */
  firebase: FirebaseConfig;
  /** Google Gemini API key (from Google AI Studio). */
  geminiApiKey: string;
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
 * Narrow accessor for the Gemini API key. Consumers that need the key for
 * direct Gemini API calls (e.g. non-Live generate/embed) should use this
 * instead of retrieving the whole config object.
 */
export function getGeminiApiKey(): string {
  return getConfig().geminiApiKey;
}
