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
 * Registry of Gemini Live models and their setup constraints.
 *
 * PURE MODULE: no React, DOM, Firebase or network. Only a type import from
 * `@google/genai`, so it is safe to load in Node test code and from the
 * `@andyfooblah/voice-common/testing` entry.
 *
 * Why this exists: the Live models disagree about `thinkingConfig`, and a
 * mismatch is not reported as a config error. The server accepts the
 * WebSocket, reads the setup message and closes with code 1007, which looks
 * like a connection fault. `resolveThinkingConfig` turns that into a clear
 * Error thrown BEFORE connecting.
 *
 * Every fact below was checked against the provider docs AND measured against
 * the live API on the `verified` date. The live conformance suite
 * (`npm run test:live`, see TESTING.md) re-measures the thinking contract for
 * every model in this table, so a provider change shows up as a
 * "contract changed" canary rather than as broken sessions.
 *
 * Sources (the Gemini API docs now live under aistudio.google.com/docs;
 * ai.google.dev/gemini-api/docs redirects there):
 *   - https://aistudio.google.com/docs/deprecations   (release / shutdown dates)
 *   - https://aistudio.google.com/docs/live-api/capabilities#model-comparison
 *   - https://aistudio.google.com/docs/models/gemini-3.8-live#migrating
 *   - https://aistudio.google.com/docs/live-api/thinking
 */

import type { ThinkingConfig, ThinkingLevel } from '@google/genai';

/**
 * How a Live model treats `thinkingConfig.thinkingLevel` in the setup message.
 *   - `rejected`   — any level closes the socket (1007). Omit the field.
 *   - `required`   — omitting the field closes the socket (1007).
 *   - `optional`   — the field may be sent or omitted.
 *   - `unverified` — not measured; values are passed through untouched.
 */
export type LiveThinkingSupport = 'rejected' | 'required' | 'optional' | 'unverified';

/**
 * Lifecycle of a Live model id.
 *   - `current`  — recommended by the provider.
 *   - `legacy`   — still served, but the provider names a replacement.
 *   - `shutdown` — no longer served; connecting can never succeed.
 */
export type LiveModelStatus = 'current' | 'legacy' | 'shutdown';

/**
 * How a Live model executes function calls.
 *   - `blocking-only`        — the model waits for the tool response.
 *   - `non-blocking-default` — asynchronous unless a declaration sets
 *                              `behavior: BLOCKING`.
 *   - `non-blocking-only`    — asynchronous only.
 *   - `unverified`           — not measured.
 */
export type LiveToolExecution =
  | 'blocking-only'
  | 'non-blocking-default'
  | 'non-blocking-only'
  | 'unverified';

export interface LiveModelInfo {
  /** Model id as passed to `ai.live.connect({ model })`. */
  id: string;
  status: LiveModelStatus;
  /** Release date from the provider's deprecations table (ISO date or month). */
  released: string;
  /** Announced shutdown date (ISO), or null when none is announced. */
  shutdown: string | null;
  /** Provider-recommended replacement, when one is named. */
  replacement?: string;
  thinking: {
    support: LiveThinkingSupport;
    /** Levels the server rejects even though thinking itself is accepted. */
    disallowedLevels: readonly `${ThinkingLevel}`[];
    /** What `'auto'` resolves to. Undefined means "omit thinkingConfig". */
    autoLevel?: `${ThinkingLevel}`;
  };
  toolExecution: LiveToolExecution;
  /** Date (ISO) these facts were last checked against docs and the live API. */
  verified: string;
  notes: readonly string[];
}

/** What a caller may ask for: an explicit level, `'none'` (omit), or `'auto'`. */
export type ThinkingRequest = ThinkingLevel | `${ThinkingLevel}` | 'none' | 'auto';

/** The Live model VoiceCommon uses when the caller does not choose one. */
export const DEFAULT_LIVE_MODEL = 'gemini-3.8-live';

const VERIFIED = '2026-11-15';

export const LIVE_MODELS: Readonly<Record<string, LiveModelInfo>> = Object.freeze({
  'gemini-3.8-live': {
    id: 'gemini-3.8-live',
    status: 'current',
    released: '2026-09-15',
    shutdown: null,
    thinking: { support: 'rejected', disallowedLevels: [] },
    toolExecution: 'non-blocking-default',
    verified: VERIFIED,
    notes: [
      'Interleaved reasoning is built in. Any thinkingLevel closes the socket: 1007 "Thinking level is not supported for this model."',
      'Proactive audio is permanently on (proactiveAudio: false is an error); affective dialog is removed.',
      'Audio is the only response modality; use outputAudioTranscription for text.',
      'Default turn coverage is TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO.',
    ],
  },
  'gemini-3.8-live-extended-thinking': {
    id: 'gemini-3.8-live-extended-thinking',
    status: 'current',
    released: '2026-09-15',
    shutdown: null,
    thinking: { support: 'required', disallowedLevels: ['MINIMAL'], autoLevel: 'LOW' },
    toolExecution: 'non-blocking-only',
    verified: VERIFIED,
    notes: [
      'A thinkingLevel is mandatory: omitting it closes the socket with 1007 "Thinking level must be specified for this model."',
      'MINIMAL is rejected (1007 "... Please retry with other thinking level."); LOW, MEDIUM and HIGH are accepted.',
      'Speaks conversational fillers while tools run; turnComplete does not mean idle (see interactionStatus in the provider docs).',
      'Roughly 300 ms slower to first audio than gemini-3.8-live.',
    ],
  },
  'gemini-3.1-flash-live-preview': {
    id: 'gemini-3.1-flash-live-preview',
    status: 'legacy',
    released: '2026-03-11',
    shutdown: null,
    replacement: 'gemini-3.8-live',
    thinking: { support: 'optional', disallowedLevels: [], autoLevel: 'MINIMAL' },
    toolExecution: 'blocking-only',
    verified: VERIFIED,
    notes: [
      'Labelled "Legacy Live API preview model" by the provider; replacement gemini-3.8-live. No shutdown date announced as of the verified date.',
      'thinkingLevel is optional: omitted, MINIMAL, LOW, MEDIUM and HIGH are all accepted. The server default is MINIMAL.',
      'Was the VoiceCommon default through 0.15.x.',
    ],
  },
  'gemini-2.5-flash-native-audio-preview-12-2025': {
    id: 'gemini-2.5-flash-native-audio-preview-12-2025',
    status: 'legacy',
    released: '2025-12-12',
    shutdown: '2027-03-31',
    replacement: 'gemini-3.8-live',
    thinking: { support: 'unverified', disallowedLevels: [] },
    toolExecution: 'unverified',
    verified: VERIFIED,
    notes: [
      'Configures thinking with thinkingBudget rather than thinkingLevel; VoiceCommon has never been tested against it.',
    ],
  },
  'gemini-live-2.5-flash-preview': {
    id: 'gemini-live-2.5-flash-preview',
    status: 'shutdown',
    released: '2025-06-17',
    shutdown: '2025-12-09',
    replacement: 'gemini-3.8-live',
    thinking: { support: 'unverified', disallowedLevels: [] },
    toolExecution: 'unverified',
    verified: VERIFIED,
    notes: [],
  },
  'gemini-2.0-flash-live-001': {
    id: 'gemini-2.0-flash-live-001',
    status: 'shutdown',
    released: '2025-04-09',
    shutdown: '2025-12-09',
    replacement: 'gemini-3.8-live',
    thinking: { support: 'unverified', disallowedLevels: [] },
    toolExecution: 'unverified',
    verified: VERIFIED,
    notes: [],
  },
});

/** Thrown for a Live configuration the registry knows the server will reject. */
export class LiveConfigError extends Error {
  readonly model: string;
  constructor(model: string, message: string) {
    super(message);
    this.name = 'LiveConfigError';
    this.model = model;
  }
}

/** Strip the optional `models/` resource prefix. */
function bareModelId(model: string): string {
  return model.startsWith('models/') ? model.slice('models/'.length) : model;
}

/** Registry entry for a model id, or undefined when the id is not known. */
export function getLiveModelInfo(model: string): LiveModelInfo | undefined {
  const id = bareModelId(model);
  return Object.prototype.hasOwnProperty.call(LIVE_MODELS, id) ? LIVE_MODELS[id] : undefined;
}

/** Ids the registry marks `current`. */
export function currentLiveModelIds(): string[] {
  return Object.values(LIVE_MODELS)
    .filter((m) => m.status === 'current')
    .map((m) => m.id);
}

/**
 * Throws when the registry knows the model can no longer be reached. Unknown
 * ids pass: a model newer than this library must stay usable.
 */
export function assertLiveModelUsable(model: string): void {
  const info = getLiveModelInfo(model);
  if (info?.status !== 'shutdown') return;
  throw new LiveConfigError(
    model,
    `[VoiceCommon] Live model '${info.id}' was shut down on ${info.shutdown}; a session can never connect to it. ` +
      `Fix: use '${info.replacement ?? DEFAULT_LIVE_MODEL}' (or omit liveModel to get the default, '${DEFAULT_LIVE_MODEL}').`,
  );
}

/**
 * Resolve the `thinkingConfig` to send for a Live model.
 *
 * @param model     Live model id (a `models/` prefix is tolerated).
 * @param requested An explicit ThinkingLevel, `'none'` to omit the field, or
 *                  `'auto'` (default) to derive the right value from the model:
 *                  omitted for `gemini-3.8-live`, LOW for
 *                  `gemini-3.8-live-extended-thinking`, MINIMAL for the legacy
 *                  3.1 preview, omitted for ids the registry does not know.
 * @returns the `thinkingConfig` object, or `undefined` when the field must be
 *          left out of the setup message.
 * @throws {LiveConfigError} when the registry knows the server rejects the
 *          explicit request for this model. Unknown model ids never throw; an
 *          explicit value is passed through untouched.
 */
export function resolveThinkingConfig(
  model: string,
  requested: ThinkingRequest = 'auto',
): ThinkingConfig | undefined {
  const info = getLiveModelInfo(model);
  const asConfig = (level: string): ThinkingConfig => ({ thinkingLevel: level as ThinkingLevel });

  if (!info || info.thinking.support === 'unverified') {
    return requested === 'auto' || requested === 'none' ? undefined : asConfig(requested);
  }

  const { support, disallowedLevels, autoLevel } = info.thinking;

  if (requested === 'auto') {
    return autoLevel ? asConfig(autoLevel) : undefined;
  }

  const closes = 'the server would close the WebSocket with code 1007 during setup';

  if (requested === 'none') {
    if (support === 'required') {
      throw new LiveConfigError(
        model,
        `[VoiceCommon] Live model '${info.id}' requires a thinking level, but thinkingLevel is 'none' (${closes}). ` +
          `Fix: pass thinkingLevel: 'auto' (resolves to ${autoLevel}) or one of ${allowedLevels(info).join(', ')}.`,
      );
    }
    return undefined;
  }

  if (support === 'rejected') {
    throw new LiveConfigError(
      model,
      `[VoiceCommon] Live model '${info.id}' does not accept a thinking level, but thinkingLevel is '${requested}' (${closes}). ` +
        `Fix: remove thinkingLevel, or pass 'auto' or 'none'. For configurable reasoning use 'gemini-3.8-live-extended-thinking'.`,
    );
  }

  if ((disallowedLevels as readonly string[]).includes(requested)) {
    throw new LiveConfigError(
      model,
      `[VoiceCommon] Live model '${info.id}' rejects thinkingLevel '${requested}' (${closes}). ` +
        `Fix: pass thinkingLevel: 'auto' (resolves to ${autoLevel ?? 'omitted'}) or one of ${allowedLevels(info).join(', ')}.`,
    );
  }

  return asConfig(requested);
}

const CONCRETE_LEVELS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] as const;

function allowedLevels(info: LiveModelInfo): string[] {
  return CONCRETE_LEVELS.filter((l) => !(info.thinking.disallowedLevels as readonly string[]).includes(l));
}
