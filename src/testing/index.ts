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
 * `@andyfooblah/voice-common/testing` — the live conformance kit.
 *
 * NODE ONLY. This entry imports `@google/genai` and Node built-ins and
 * nothing else: no React, no DOM, no Firebase. Use it from a Node test
 * process (vitest with `environment: 'node'`) to check an app's real Live
 * configuration against the real Gemini Live API. It takes a long-lived API
 * key at runtime from the caller's environment, so it must never be imported
 * by browser code. See TESTING.md.
 */

// The registry and builder, re-exported so a Node test needs only this entry
// (the main entry pulls in React and Firebase).
export {
  DEFAULT_LIVE_MODEL,
  LIVE_MODELS,
  LiveConfigError,
  getLiveModelInfo,
  currentLiveModelIds,
  assertLiveModelUsable,
  resolveThinkingConfig,
} from '../services/liveModels';
export type {
  LiveModelInfo,
  LiveModelStatus,
  LiveThinkingSupport,
  LiveToolExecution,
  LiveIdleSignal,
  ThinkingRequest,
} from '../services/liveModels';
export {
  LIVE_API_VERSION,
  END_SESSION_TOOL_NAME,
  endSessionTool,
  resolveLiveModel,
  buildLiveConnectConfig,
} from '../services/liveConnectConfig';
export type { BuildLiveConnectConfigParams } from '../services/liveConnectConfig';

export { LiveTestSession, LiveSetupError, LiveWaitError, formatLiveTrace } from './LiveTestSession';
export type {
  LiveTestSessionOptions,
  LiveRawMessage,
  LiveTraceEvent,
  LiveTraceEventType,
  LiveTraceEventOf,
  LiveToolCall,
  WaitOptions,
  SendAudioOptions,
} from './LiveTestSession';

export {
  SPEECH_FIXTURE_IDS,
  loadSpeechFixture,
  loadWavPcm16k,
  readSpeechFixtureManifest,
  speechFixturesDir,
} from './fixtures';
export type {
  SpeechFixture,
  SpeechFixtureId,
  SpeechFixtureManifest,
  SpeechFixtureManifestEntry,
} from './fixtures';

export {
  INPUT_SAMPLE_RATE,
  OUTPUT_SAMPLE_RATE,
  silencePcm,
  concatPcm,
  joinWithSilence,
  pcmDurationMs,
  pcmRms,
  parseWav,
  encodeWav,
} from './audio';
export type { WavData } from './audio';

export { normalizeWords, wordMatchRatio, containsWords } from './text';
export { makeRedactor, redactSecrets } from './redact';

export {
  checkSetupAccepted,
  checkTextTurn,
  checkAudioTurn,
  checkToolRoundTrip,
  checkToolDeclarationsAccepted,
  checkManualTurnControl,
  checkPatience,
  checkBargeIn,
  checkSessionResumption,
  checkContextWindowCompression,
  canaryThinkingContract,
  canaryToolBehaviorContract,
  canaryRegistryFreshness,
  canaryToolCallOrdering,
  canarySilentToolResponse,
  checkModelListed,
  checkEphemeralToken,
  checkLatency,
  mintEphemeralLiveToken,
  isManualTurnControl,
  withManualTurnControl,
  withSilenceDurationMs,
} from './checks';
export type {
  LiveCheckResult,
  LiveCheckStatus,
  LiveCheckTarget,
  TextTurnOptions,
  AudioTurnOptions,
  ToolProbe,
  PatienceOptions,
  BargeInOptions,
  EphemeralTokenOptions,
  LatencyOptions,
} from './checks';

export {
  LIVE_CHECK_NAMES,
  DEFAULT_LIVE_CHECKS,
  buildProfileConnectConfig,
  runLiveConformance,
  formatLiveConformanceReport,
  assertLiveConformance,
} from './conformance';
export type {
  LiveAppProfile,
  LiveCheckName,
  RunLiveConformanceOptions,
  LiveConformanceReport,
} from './conformance';
