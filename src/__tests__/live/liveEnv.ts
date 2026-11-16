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
 * Shared plumbing for the live suite (`npm run test:live`).
 *
 * The key is read from the environment and handed to the kit; it is never
 * printed. Results are printed one line per check and, when
 * LIVE_RESULTS_FILE is set, appended to that file as JSON lines (no secrets:
 * results are redacted by the kit) so CI can publish a summary table.
 */

import fs from 'node:fs';
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { describe } from 'vitest';
import { buildLiveConnectConfig } from '../../services/liveConnectConfig';
import type { BuildLiveConnectConfigParams } from '../../services/liveConnectConfig';
import type { LiveCheckResult, LiveCheckTarget } from '../../testing';

export const LIVE_API_KEY = process.env.GEMINI_API_KEY ?? '';

/** `describe` that skips the whole block (green) when no key is configured. */
export const describeLive = describe.skipIf(!LIVE_API_KEY);

/** A neutral instruction: short answers keep runs cheap and quick. */
export const TEST_INSTRUCTION =
  'You are a voice assistant used in an automated connection test. ' +
  'Answer in one short sentence unless asked otherwise. Follow bracketed test cues exactly.';

/** A representative application tool, so every setup carries a real schema. */
export const SAMPLE_TOOL: FunctionDeclaration = {
  name: 'getWeather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: Type.OBJECT,
    properties: { city: { type: Type.STRING, description: 'City name, e.g. "Paris".' } },
    required: ['city'],
  },
};

/** Build a check target from the same builder `useSession` uses. */
export function targetFor(
  label: string,
  params: Partial<BuildLiveConnectConfigParams> & { model: string },
): LiveCheckTarget & { label: string } {
  return {
    label,
    apiKey: LIVE_API_KEY,
    model: params.model,
    config: buildLiveConnectConfig({ systemInstruction: TEST_INSTRUCTION, tools: [SAMPLE_TOOL], ...params }),
  };
}

/**
 * Print a result, record it, and fail the test when the check failed or a
 * provider contract changed. A `warn` or `skipped` result passes.
 */
export function expectCheck(result: LiveCheckResult, label: string): LiveCheckResult {
  const metrics = Object.entries(result.metrics)
    .filter(([, v]) => v !== '' && v !== -1)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(`[live] ${result.status.toUpperCase().padEnd(16)} ${label} :: ${result.name} :: ${result.detail}${metrics ? ` [${metrics}]` : ''}`);
  if (process.env.LIVE_RESULTS_FILE) {
    fs.appendFileSync(
      process.env.LIVE_RESULTS_FILE,
      JSON.stringify({ label, at: new Date().toISOString(), ...result }) + '\n',
    );
  }
  if (!result.pass && result.trace?.length) {
    console.log(`[live] trace for ${label} :: ${result.name}\n  ${result.trace.join('\n  ')}`);
  }
  if (result.status === 'contract-changed') {
    throw new Error(`[${label}] ${result.detail}`);
  }
  if (!result.pass) {
    throw new Error(`[${label}] ${result.name} failed: ${result.detail}`);
  }
  return result;
}
