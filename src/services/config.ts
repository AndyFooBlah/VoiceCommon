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
  /** Google Maps API key (enables weather and maps tools). Optional. */
  mapsApiKey?: string;
}

/**
 * Unique key for storing config on globalThis.
 *
 * Using globalThis rather than a module-level variable ensures the singleton
 * survives across bundler chunk boundaries — if the consuming app (e.g.
 * LegacyBot with Vite code-splitting) places VoiceCommon's code in multiple
 * chunks, all copies share the same globalThis and therefore the same config.
 */
const GLOBAL_CONFIG_KEY = '__voiceCommon_config__';

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
 *   mapsApiKey: 'AIza...',
 * });
 * ```
 */
export function initializeVoiceCommon(config: VoiceCommonConfig): void {
  (globalThis as Record<string, unknown>)[GLOBAL_CONFIG_KEY] = config;
  _initFirebase(config.firebase);
}

/**
 * Returns the active VoiceCommon configuration.
 * Throws if `initializeVoiceCommon()` has not been called yet.
 */
export function getConfig(): VoiceCommonConfig {
  const config = (globalThis as Record<string, unknown>)[GLOBAL_CONFIG_KEY] as VoiceCommonConfig | undefined;
  if (!config) {
    throw new Error(
      'VoiceCommon is not initialized. Call initializeVoiceCommon(config) before using any VoiceCommon hooks or services.',
    );
  }
  return config;
}
