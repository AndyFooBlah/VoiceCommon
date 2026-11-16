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
 * Offline tests for buildLiveConnectConfig — the object `useSession` passes
 * as `config` to `ai.live.connect`, and that the live conformance kit sends
 * for an app profile. Uses the real @google/genai enums (no mocks).
 */

import { describe, it, expect } from 'vitest';
import { Behavior, EndSensitivity, Modality, StartSensitivity, Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import {
  END_SESSION_TOOL_NAME,
  LIVE_API_VERSION,
  buildLiveConnectConfig,
  endSessionTool,
  resolveLiveModel,
} from '../../services/liveConnectConfig';
import { DEFAULT_LIVE_MODEL, LiveConfigError } from '../../services/liveModels';

const INSTRUCTION = 'You are a test assistant.';

const weatherTool: FunctionDeclaration = {
  name: 'getWeather',
  description: 'Get the weather.',
  parameters: { type: Type.OBJECT, properties: { city: { type: Type.STRING } }, required: ['city'] },
};

function declarations(config: ReturnType<typeof buildLiveConnectConfig>): FunctionDeclaration[] {
  return (config.tools ?? []).flatMap((t) => ('functionDeclarations' in t ? t.functionDeclarations ?? [] : []));
}

describe('buildLiveConnectConfig: defaults', () => {
  it('produces exactly the default setup config for the default model', () => {
    expect(buildLiveConnectConfig({ systemInstruction: INSTRUCTION })).toEqual({
      systemInstruction: { parts: [{ text: INSTRUCTION }] },
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      tools: [{ functionDeclarations: [endSessionTool()] }],
      realtimeInputConfig: {
        automaticActivityDetection: {
          startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
          endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
        },
      },
      sessionResumption: {},
      contextWindowCompression: { slidingWindow: {} },
    });
  });

  it('resolves the model to DEFAULT_LIVE_MODEL when none is given', () => {
    expect(resolveLiveModel()).toBe(DEFAULT_LIVE_MODEL);
    expect(resolveLiveModel(undefined)).toBe('gemini-3.8-live');
    expect(resolveLiveModel(null)).toBe('gemini-3.8-live');
    expect(resolveLiveModel('gemini-3.8-live-extended-thinking')).toBe('gemini-3.8-live-extended-thinking');
  });

  it('pins the API version the SDK wires ephemeral tokens to', () => {
    expect(LIVE_API_VERSION).toBe('v1alpha');
  });

  it('requests only the AUDIO modality and both transcriptions', () => {
    const config = buildLiveConnectConfig({ systemInstruction: INSTRUCTION });
    expect(config.responseModalities).toEqual(['AUDIO']);
    expect(config.inputAudioTranscription).toEqual({});
    expect(config.outputAudioTranscription).toEqual({});
  });

  it('always enables context window compression', () => {
    for (const manualTurnControl of [true, false]) {
      expect(
        buildLiveConnectConfig({ systemInstruction: INSTRUCTION, manualTurnControl }).contextWindowCompression,
      ).toEqual({ slidingWindow: {} });
    }
  });
});

describe('buildLiveConnectConfig: thinking', () => {
  const cases: Array<[model: string | undefined, thinking: Parameters<typeof buildLiveConnectConfig>[0]['thinkingLevel'], expected: unknown]> = [
    [undefined, undefined, undefined],
    ['gemini-3.8-live', 'auto', undefined],
    ['gemini-3.8-live', 'none', undefined],
    ['gemini-3.8-live-extended-thinking', undefined, { thinkingLevel: 'LOW' }],
    ['gemini-3.8-live-extended-thinking', 'HIGH', { thinkingLevel: 'HIGH' }],
    ['gemini-3.1-flash-live-preview', undefined, { thinkingLevel: 'MINIMAL' }],
    ['gemini-3.1-flash-live-preview', 'none', undefined],
    ['some-unknown-live-model', undefined, undefined],
    ['some-unknown-live-model', 'MEDIUM', { thinkingLevel: 'MEDIUM' }],
  ];

  it.each(cases)('model=%s thinkingLevel=%s', (model, thinkingLevel, expected) => {
    const config = buildLiveConnectConfig({ systemInstruction: INSTRUCTION, model, thinkingLevel });
    if (expected === undefined) {
      // The key must be absent, not present-and-undefined: gemini-3.8-live
      // closes the socket when thinkingConfig is sent at all.
      expect('thinkingConfig' in config).toBe(false);
    } else {
      expect(config.thinkingConfig).toEqual(expected);
    }
  });

  it('throws before connecting for a thinking level the model rejects', () => {
    expect(() =>
      buildLiveConnectConfig({ systemInstruction: INSTRUCTION, model: 'gemini-3.8-live', thinkingLevel: 'MINIMAL' }),
    ).toThrow(LiveConfigError);
    expect(() =>
      buildLiveConnectConfig({
        systemInstruction: INSTRUCTION,
        model: 'gemini-3.8-live-extended-thinking',
        thinkingLevel: 'none',
      }),
    ).toThrow(/requires a thinking level/);
  });

  it('throws for a model the registry marks shut down', () => {
    expect(() =>
      buildLiveConnectConfig({ systemInstruction: INSTRUCTION, model: 'gemini-live-2.5-flash-preview' }),
    ).toThrow(/was shut down on 2025-12-09/);
  });
});

describe('buildLiveConnectConfig: turn taking', () => {
  it('server VAD by default: HIGH start sensitivity, HIGH end sensitivity, no silence override', () => {
    const vad = buildLiveConnectConfig({ systemInstruction: INSTRUCTION }).realtimeInputConfig
      ?.automaticActivityDetection;
    expect(vad).toEqual({
      startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
      endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
    });
    expect(vad && 'silenceDurationMs' in vad).toBe(false);
    expect(vad?.disabled).toBeUndefined();
  });

  it.each([
    ['HIGH', 'END_SENSITIVITY_HIGH'],
    ['LOW', 'END_SENSITIVITY_LOW'],
  ] as const)('endOfSpeechSensitivity %s maps to %s', (endOfSpeechSensitivity, expected) => {
    expect(
      buildLiveConnectConfig({ systemInstruction: INSTRUCTION, endOfSpeechSensitivity }).realtimeInputConfig
        ?.automaticActivityDetection?.endOfSpeechSensitivity,
    ).toBe(expected);
  });

  it.each([0, 500, 2500, 10_000])('passes endOfSpeechSilenceMs=%d as silenceDurationMs', (silence) => {
    expect(
      buildLiveConnectConfig({ systemInstruction: INSTRUCTION, endOfSpeechSilenceMs: silence }).realtimeInputConfig
        ?.automaticActivityDetection?.silenceDurationMs,
    ).toBe(silence);
  });

  it('LegacyBot-style preset: LOW end sensitivity with a long silence', () => {
    expect(
      buildLiveConnectConfig({
        systemInstruction: INSTRUCTION,
        endOfSpeechSensitivity: 'LOW',
        endOfSpeechSilenceMs: 2500,
      }).realtimeInputConfig,
    ).toEqual({
      automaticActivityDetection: {
        startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
        endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
        silenceDurationMs: 2500,
      },
    });
  });

  it('manual turn control disables server VAD and sends nothing else', () => {
    expect(
      buildLiveConnectConfig({
        systemInstruction: INSTRUCTION,
        manualTurnControl: true,
        // Client-side settings: must not leak into the setup message.
        endOfSpeechSilenceMs: 5000,
        endOfSpeechSensitivity: 'LOW',
      }).realtimeInputConfig,
    ).toEqual({ automaticActivityDetection: { disabled: true } });
  });
});

describe('buildLiveConnectConfig: speech, resumption, tools', () => {
  it('omits speechConfig unless one is given', () => {
    expect('speechConfig' in buildLiveConnectConfig({ systemInstruction: INSTRUCTION })).toBe(false);
  });

  it('passes speechConfig through unchanged', () => {
    const speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } };
    expect(buildLiveConnectConfig({ systemInstruction: INSTRUCTION, speechConfig }).speechConfig).toBe(speechConfig);
  });

  it.each([undefined, null, ''])('starts a fresh resumable session when the handle is %s', (resumptionHandle) => {
    expect(
      buildLiveConnectConfig({ systemInstruction: INSTRUCTION, resumptionHandle }).sessionResumption,
    ).toEqual({});
  });

  it('resumes with a handle when one is given', () => {
    expect(
      buildLiveConnectConfig({ systemInstruction: INSTRUCTION, resumptionHandle: 'HANDLE-1' }).sessionResumption,
    ).toEqual({ handle: 'HANDLE-1' });
  });

  it('always injects endSession, last, after the application tools', () => {
    const config = buildLiveConnectConfig({ systemInstruction: INSTRUCTION, tools: [weatherTool] });
    expect(config.tools).toHaveLength(1);
    expect(declarations(config).map((d) => d.name)).toEqual(['getWeather', END_SESSION_TOOL_NAME]);
    expect(declarations(config)[0]).toBe(weatherTool);
    expect(declarations(config)[1]).toEqual({
      name: 'endSession',
      description: 'End the voice session. Call this only when the user explicitly signals they want to stop.',
      parameters: { type: Type.OBJECT, properties: {}, required: [] },
    });
  });

  it('injects endSession even with no application tools', () => {
    expect(declarations(buildLiveConnectConfig({ systemInstruction: INSTRUCTION })).map((d) => d.name)).toEqual([
      'endSession',
    ]);
    expect(declarations(buildLiveConnectConfig({ systemInstruction: INSTRUCTION, tools: [] }))).toHaveLength(1);
  });

  it('does not mutate the caller\'s tools array', () => {
    const tools = [weatherTool];
    buildLiveConnectConfig({ systemInstruction: INSTRUCTION, tools });
    expect(tools).toEqual([weatherTool]);
  });

  it('includeEndSessionTool: false leaves only the application tools, or no tools key at all', () => {
    const withTool = buildLiveConnectConfig({
      systemInstruction: INSTRUCTION,
      tools: [weatherTool],
      includeEndSessionTool: false,
    });
    expect(declarations(withTool).map((d) => d.name)).toEqual(['getWeather']);
    const none = buildLiveConnectConfig({ systemInstruction: INSTRUCTION, includeEndSessionTool: false });
    expect('tools' in none).toBe(false);
  });

  it('rejects a BLOCKING tool on a model that only runs tools asynchronously', () => {
    const blocking: FunctionDeclaration = { ...weatherTool, behavior: Behavior.BLOCKING };
    expect(() =>
      buildLiveConnectConfig({
        systemInstruction: INSTRUCTION,
        model: 'gemini-3.8-live-extended-thinking',
        tools: [blocking],
      }),
    ).toThrow(/'gemini-3\.8-live-extended-thinking' only supports asynchronous function calls.*'getWeather'.*Fix:/);
    // The same declaration is fine where blocking calls are supported.
    expect(() =>
      buildLiveConnectConfig({ systemInstruction: INSTRUCTION, model: 'gemini-3.8-live', tools: [blocking] }),
    ).not.toThrow();
    // NON_BLOCKING and unspecified are fine on the async-only model.
    expect(() =>
      buildLiveConnectConfig({
        systemInstruction: INSTRUCTION,
        model: 'gemini-3.8-live-extended-thinking',
        tools: [weatherTool, { ...weatherTool, name: 'other', behavior: Behavior.NON_BLOCKING }],
      }),
    ).not.toThrow();
  });

  it('carries the system instruction verbatim', () => {
    const text = 'Line one.\n\nLine two with "quotes" and unicode: café.';
    expect(buildLiveConnectConfig({ systemInstruction: text }).systemInstruction).toEqual({ parts: [{ text }] });
  });
});
