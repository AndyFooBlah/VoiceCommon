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
 * Builds the `config` object handed to `ai.live.connect({ model, config })`.
 *
 * PURE MODULE: no React, DOM, Firebase or network. `useSession` calls
 * `buildLiveConnectConfig` for every (re)connect, and the live conformance kit
 * (`@andyfooblah/voice-common/testing`) calls the same function, so a test of
 * an app profile exercises exactly the setup message production sends.
 */

import { Modality, Type, StartSensitivity, EndSensitivity } from '@google/genai';
import type { FunctionDeclaration, LiveConnectConfig, SpeechConfig } from '@google/genai';
import {
  DEFAULT_LIVE_MODEL,
  LiveConfigError,
  assertLiveModelUsable,
  getLiveModelInfo,
  resolveThinkingConfig,
} from './liveModels';
import type { ThinkingRequest } from './liveModels';

/**
 * API version `useSession` pins when it opens the Live WebSocket with an
 * ephemeral token.
 *
 * Measured 2026-11-15 with @google/genai 2.11.0: a token minted by
 * `authTokens.create` on either `v1alpha` or `v1beta` connects on either
 * version. The provider's ephemeral-token guide now says "only with the
 * v1beta version", while the SDK (2.11.0 and 3.3.0 alike) logs "ephemeral
 * token support is in v1alpha only" for anything else. Both work today, so
 * the pin stays on the version the SDK itself asks for; `liveApiVersion` on
 * `useSession` is the escape hatch, and the live suite checks both versions
 * every run.
 */
export const LIVE_API_VERSION = 'v1alpha';

/** Name of the tool VoiceCommon injects so the bot can end the session. */
export const END_SESSION_TOOL_NAME = 'endSession';

/** The injected end-of-session tool declaration. */
export function endSessionTool(): FunctionDeclaration {
  return {
    name: END_SESSION_TOOL_NAME,
    description:
      'End the voice session. Call this only when the user explicitly signals they want to stop.',
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  };
}

export interface BuildLiveConnectConfigParams {
  /** Live model id. Defaults to {@link DEFAULT_LIVE_MODEL}. */
  model?: string;
  /** Full system instruction text. */
  systemInstruction: string;
  /** Application tool declarations. `endSession` is appended automatically. */
  tools?: FunctionDeclaration[];
  /**
   * Append the `endSession` tool (default true, as `useSession` does). Set
   * false only for direct-connect paths that do not use `useSession`.
   */
  includeEndSessionTool?: boolean;
  /**
   * `'auto'` (default) derives the right `thinkingConfig` from the model;
   * `'none'` omits it; an explicit level is validated against the registry
   * and throws {@link LiveConfigError} when the model is known to reject it.
   */
  thinkingLevel?: ThinkingRequest;
  /** Voice selection, passed through unchanged. Omitted when undefined. */
  speechConfig?: SpeechConfig;
  /**
   * Disable the server's automatic voice-activity detection; the client sends
   * `activityStart` / `activityEnd` itself.
   */
  manualTurnControl?: boolean;
  /**
   * Server-VAD mode: `automaticActivityDetection.silenceDurationMs`. Omitted
   * (server default, about 800 ms) when undefined. Ignored in manual mode,
   * where the client applies it.
   */
  endOfSpeechSilenceMs?: number;
  /** Server-VAD end-of-speech sensitivity. Default `'HIGH'`. */
  endOfSpeechSensitivity?: 'HIGH' | 'LOW';
  /** Session-resumption handle from a previous connection, if any. */
  resumptionHandle?: string | null;
}

/** Resolve the model id a session will use. */
export function resolveLiveModel(model?: string | null): string {
  return model ?? DEFAULT_LIVE_MODEL;
}

/**
 * Throws when a tool declaration asks for an execution mode the registry
 * knows the model rejects at setup.
 */
function assertToolsCompatible(model: string, tools: FunctionDeclaration[]): void {
  const info = getLiveModelInfo(model);
  if (info?.toolExecution !== 'non-blocking-only') return;
  const blocking = tools.filter((t) => (t.behavior as string | undefined) === 'BLOCKING');
  if (blocking.length === 0) return;
  throw new LiveConfigError(
    model,
    `[VoiceCommon] Live model '${info.id}' only supports asynchronous function calls, but ` +
      `${blocking.map((t) => `'${t.name}'`).join(', ')} ${blocking.length === 1 ? 'is' : 'are'} declared with behavior: BLOCKING ` +
      `(the server would close the WebSocket with code 1007 during setup). ` +
      `Fix: remove behavior from the declaration or set it to NON_BLOCKING.`,
  );
}

/**
 * Build the Live `config` for one connection.
 *
 * Validation happens here, before any network call: a model the registry
 * marks shut down, a thinking level the model rejects, or a tool execution
 * mode the model rejects each throw a {@link LiveConfigError} naming the
 * model, the offending value and the fix.
 */
export function buildLiveConnectConfig(params: BuildLiveConnectConfigParams): LiveConnectConfig {
  const model = resolveLiveModel(params.model);
  assertLiveModelUsable(model);

  const thinkingConfig = resolveThinkingConfig(model, params.thinkingLevel ?? 'auto');

  const functionDeclarations: FunctionDeclaration[] = [
    ...(params.tools ?? []),
    ...(params.includeEndSessionTool === false ? [] : [endSessionTool()]),
  ];
  assertToolsCompatible(model, functionDeclarations);

  const endSensitivity =
    params.endOfSpeechSensitivity === 'LOW'
      ? EndSensitivity.END_SENSITIVITY_LOW
      : EndSensitivity.END_SENSITIVITY_HIGH;

  return {
    systemInstruction: { parts: [{ text: params.systemInstruction }] },
    // Native-audio Live models ONLY support the AUDIO modality.
    // Including TEXT causes the server to close the WebSocket immediately.
    responseModalities: [Modality.AUDIO],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Left out entirely when the model rejects the field (gemini-3.8-live).
    ...(thinkingConfig ? { thinkingConfig } : {}),
    ...(functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : {}),
    // Turn detection. In manual mode the server's automatic VAD is disabled
    // and the client drives turn boundaries (activityStart / activityEnd).
    // Otherwise: high start sensitivity keeps barge-in snappy; end-of-speech
    // sensitivity and silence are configurable.
    realtimeInputConfig: {
      automaticActivityDetection: params.manualTurnControl
        ? { disabled: true }
        : {
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
            endOfSpeechSensitivity: endSensitivity,
            // How long a pause the user is allowed before the bot commits
            // end-of-speech and takes its turn. Omit to use the API default.
            ...(params.endOfSpeechSilenceMs != null
              ? { silenceDurationMs: params.endOfSpeechSilenceMs }
              : {}),
          },
    },
    // Voice selection — only included when the caller provides a speech config.
    ...(params.speechConfig ? { speechConfig: params.speechConfig } : {}),
    // Session resumption: the server issues handles that are passed back on
    // reconnect, so a session survives the Live API's ~10-min connection
    // resets WITH full conversation context. A handle resumes; {} starts fresh.
    sessionResumption: params.resumptionHandle ? { handle: params.resumptionHandle } : {},
    // Context-window compression lets long sessions run past the 15-min audio
    // session limit by summarising older turns.
    contextWindowCompression: { slidingWindow: {} },
  };
}
