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
 * VoiceCommon library entry point.
 *
 * Re-exports the public API for npm package consumers.
 * Start here: call `initializeVoiceCommon(config)` before using any hooks.
 *
 * Knowledge tools (Wikipedia, Maps, Weather, Jokes, Date/Time) are now in
 * @andyfooblah/knowledge-common. Import and initialize that package separately.
 */

// Initialization
export { initializeVoiceCommon } from './services/config';
export type { VoiceCommonConfig, GeminiLiveToken } from './services/config';
export type { FirebaseConfig } from './services/firebase';

// Firebase service instances (populated after initializeVoiceCommon())
export { auth, db, storage, functions } from './services/firebase';

// Core types
export * from './types';

// Hooks
export { useSession } from './hooks/useSession';
export type { UseSessionOptions, UseSessionReturn } from './hooks/useSession';

// Live model registry and the pure connect-config builder. `useSession` uses
// these internally; they are exported so an app's direct-connect paths and
// its tests can share the same validated setup message. The Node-only live
// conformance kit lives in '@andyfooblah/voice-common/testing'.
export {
  DEFAULT_LIVE_MODEL,
  LIVE_MODELS,
  LiveConfigError,
  getLiveModelInfo,
  currentLiveModelIds,
  assertLiveModelUsable,
  resolveThinkingConfig,
} from './services/liveModels';
export type {
  LiveModelInfo,
  LiveModelStatus,
  LiveThinkingSupport,
  LiveToolExecution,
  ThinkingRequest,
} from './services/liveModels';
export {
  LIVE_API_VERSION,
  END_SESSION_TOOL_NAME,
  endSessionTool,
  resolveLiveModel,
  buildLiveConnectConfig,
} from './services/liveConnectConfig';
export type { BuildLiveConnectConfigParams } from './services/liveConnectConfig';
export { useAuth } from './hooks/useAuth';
export { useAudioMixer } from './hooks/useAudioMixer';
export type { AudioMixerHandle } from './hooks/useAudioMixer';

// Services
export { buildSessionInstruction, allTools } from './services/gemini';
export type { BuildSessionInstructionOptions } from './services/gemini';
export {
  createSession,
  finalizeSession,
  getUserSessions,
  getSession,
  archiveAudioToGCS,
  syncTranscriptToFirestore,
  getTranscriptEntries,
} from './services/storage';
