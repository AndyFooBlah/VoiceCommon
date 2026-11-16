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
 * Offline, table-driven tests for the Live model registry.
 *
 * Every known model x every thinking request must give an exact config or an
 * exact, actionable error. The live suite (`npm run test:live`) re-measures
 * the same table against the real API.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LIVE_MODEL,
  LIVE_MODELS,
  LiveConfigError,
  assertLiveModelUsable,
  currentLiveModelIds,
  getLiveModelInfo,
  resolveThinkingConfig,
} from '../../services/liveModels';
import type { ThinkingRequest } from '../../services/liveModels';

const LIVE = 'gemini-3.8-live';
const EXTENDED = 'gemini-3.8-live-extended-thinking';
const LEGACY = 'gemini-3.1-flash-live-preview';

type Expected = { config: { thinkingLevel: string } | undefined } | { error: RegExp[] };

const omit: Expected = { config: undefined };
const level = (l: string): Expected => ({ config: { thinkingLevel: l } });

// model x request -> exact outcome. Measured against the live API 2026-11-15.
const TABLE: Array<[model: string, requested: ThinkingRequest, expected: Expected]> = [
  // gemini-3.8-live rejects every thinking level.
  [LIVE, 'auto', omit],
  [LIVE, 'none', omit],
  [LIVE, 'MINIMAL', { error: [/'gemini-3\.8-live'/, /'MINIMAL'/, /does not accept a thinking level/, /Fix: remove thinkingLevel, or pass 'auto' or 'none'/] }],
  [LIVE, 'LOW', { error: [/'gemini-3\.8-live'/, /'LOW'/, /1007/] }],
  [LIVE, 'MEDIUM', { error: [/'gemini-3\.8-live'/, /'MEDIUM'/, /1007/] }],
  [LIVE, 'HIGH', { error: [/'gemini-3\.8-live'/, /'HIGH'/, /gemini-3\.8-live-extended-thinking/] }],

  // gemini-3.8-live-extended-thinking requires a level and rejects MINIMAL.
  [EXTENDED, 'auto', level('LOW')],
  [EXTENDED, 'none', { error: [/'gemini-3\.8-live-extended-thinking'/, /requires a thinking level/, /'none'/, /Fix: pass thinkingLevel: 'auto' \(resolves to LOW\) or one of LOW, MEDIUM, HIGH/] }],
  [EXTENDED, 'MINIMAL', { error: [/'gemini-3\.8-live-extended-thinking'/, /rejects thinkingLevel 'MINIMAL'/, /1007/, /one of LOW, MEDIUM, HIGH/] }],
  [EXTENDED, 'LOW', level('LOW')],
  [EXTENDED, 'MEDIUM', level('MEDIUM')],
  [EXTENDED, 'HIGH', level('HIGH')],

  // The legacy 3.1 preview accepts everything, including omission.
  [LEGACY, 'auto', level('MINIMAL')],
  [LEGACY, 'none', omit],
  [LEGACY, 'MINIMAL', level('MINIMAL')],
  [LEGACY, 'LOW', level('LOW')],
  [LEGACY, 'MEDIUM', level('MEDIUM')],
  [LEGACY, 'HIGH', level('HIGH')],
];

describe('resolveThinkingConfig: every known model x every request', () => {
  it.each(TABLE)('%s + %s', (model, requested, expected) => {
    if ('error' in expected) {
      let thrown: unknown;
      try {
        resolveThinkingConfig(model, requested);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(LiveConfigError);
      const error = thrown as LiveConfigError;
      expect(error.model).toBe(model);
      expect(error.name).toBe('LiveConfigError');
      for (const pattern of expected.error) expect(error.message).toMatch(pattern);
    } else {
      expect(resolveThinkingConfig(model, requested)).toEqual(expected.config);
    }
  });

  it('covers every measured model in the registry', () => {
    const measured = Object.values(LIVE_MODELS)
      .filter((m) => m.thinking.support !== 'unverified')
      .map((m) => m.id)
      .sort();
    expect([...new Set(TABLE.map(([model]) => model))].sort()).toEqual(measured);
    // 6 requests per measured model, none missing.
    expect(TABLE).toHaveLength(measured.length * 6);
  });

  it("defaults to 'auto' when no request is given", () => {
    expect(resolveThinkingConfig(LIVE)).toBeUndefined();
    expect(resolveThinkingConfig(EXTENDED)).toEqual({ thinkingLevel: 'LOW' });
  });

  it('tolerates a models/ resource prefix', () => {
    expect(resolveThinkingConfig(`models/${EXTENDED}`, 'auto')).toEqual({ thinkingLevel: 'LOW' });
    expect(() => resolveThinkingConfig(`models/${LIVE}`, 'LOW')).toThrow(LiveConfigError);
  });
});

describe('resolveThinkingConfig: model ids the registry does not know', () => {
  const UNKNOWN = 'gemini-9.9-live-from-the-future';

  it("omits thinkingConfig for 'auto' and 'none'", () => {
    expect(resolveThinkingConfig(UNKNOWN, 'auto')).toBeUndefined();
    expect(resolveThinkingConfig(UNKNOWN, 'none')).toBeUndefined();
    expect(resolveThinkingConfig(UNKNOWN)).toBeUndefined();
  });

  it.each(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] as const)('passes an explicit %s through untouched', (l) => {
    expect(resolveThinkingConfig(UNKNOWN, l)).toEqual({ thinkingLevel: l });
  });

  it('never throws', () => {
    for (const requested of ['auto', 'none', 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] as const) {
      expect(() => resolveThinkingConfig(UNKNOWN, requested)).not.toThrow();
    }
  });

  it('treats a registry model with unverified thinking like an unknown id', () => {
    const unverified = 'gemini-2.5-flash-native-audio-preview-12-2025';
    expect(getLiveModelInfo(unverified)?.thinking.support).toBe('unverified');
    expect(resolveThinkingConfig(unverified, 'auto')).toBeUndefined();
    expect(resolveThinkingConfig(unverified, 'HIGH')).toEqual({ thinkingLevel: 'HIGH' });
  });
});

describe('registry', () => {
  it('DEFAULT_LIVE_MODEL is gemini-3.8-live, a current model', () => {
    expect(DEFAULT_LIVE_MODEL).toBe('gemini-3.8-live');
    expect(getLiveModelInfo(DEFAULT_LIVE_MODEL)?.status).toBe('current');
    expect(currentLiveModelIds()).toContain(DEFAULT_LIVE_MODEL);
  });

  it('lists the two current models and nothing legacy as current', () => {
    expect(currentLiveModelIds().sort()).toEqual([LIVE, EXTENDED].sort());
    expect(getLiveModelInfo(LEGACY)?.status).toBe('legacy');
  });

  it.each(Object.values(LIVE_MODELS))('$id is internally consistent', (info) => {
    expect(LIVE_MODELS[info.id]).toBe(info);
    expect(info.verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const { support, disallowedLevels, autoLevel } = info.thinking;
    if (support === 'rejected') expect(autoLevel).toBeUndefined();
    if (support === 'required') expect(autoLevel).toBeDefined();
    if (autoLevel) expect(disallowedLevels).not.toContain(autoLevel);
    if (info.status !== 'current') {
      // A legacy or retired model must name a replacement that is current.
      expect(info.replacement).toBeDefined();
      expect(getLiveModelInfo(info.replacement!)?.status).toBe('current');
    }
    if (info.status === 'shutdown') {
      expect(info.shutdown).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("'auto' never throws for any registry model", () => {
    for (const id of Object.keys(LIVE_MODELS)) {
      expect(() => resolveThinkingConfig(id, 'auto')).not.toThrow();
    }
  });

  it('is frozen and does not match inherited property names', () => {
    expect(Object.isFrozen(LIVE_MODELS)).toBe(true);
    expect(getLiveModelInfo('constructor')).toBeUndefined();
    expect(getLiveModelInfo('toString')).toBeUndefined();
  });
});

describe('assertLiveModelUsable', () => {
  it('passes for current, legacy and unknown models', () => {
    expect(() => assertLiveModelUsable(LIVE)).not.toThrow();
    expect(() => assertLiveModelUsable(LEGACY)).not.toThrow();
    expect(() => assertLiveModelUsable('some-new-model')).not.toThrow();
  });

  it('throws an actionable error for a shut-down model', () => {
    expect(() => assertLiveModelUsable('gemini-2.0-flash-live-001')).toThrow(LiveConfigError);
    expect(() => assertLiveModelUsable('gemini-2.0-flash-live-001')).toThrow(
      /'gemini-2\.0-flash-live-001' was shut down on 2025-12-09.*Fix: use 'gemini-3\.8-live'/,
    );
  });
});
