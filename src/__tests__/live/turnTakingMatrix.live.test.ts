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
 * LIVE: turn-taking presets on DEFAULT_LIVE_MODEL.
 *
 * The three presets the apps use (see `UseSessionOptions`):
 *   - server VAD, all defaults        — CarBot, weatherbot-app (snappy Q&A)
 *   - server VAD, LOW end sensitivity
 *     + long silence                  — LegacyBot (patient with storytellers)
 *   - manual turn control             — client-side VAD decides turn ends
 */

import { describe, it } from 'vitest';
import { DEFAULT_LIVE_MODEL } from '../../services/liveModels';
import {
  checkAudioTurn,
  checkBargeIn,
  checkLatency,
  checkManualTurnControl,
  checkPatience,
} from '../../testing';
import { describeLive, expectCheck, targetFor } from './liveEnv';

const PRESETS = [
  { name: 'server-vad-default', params: {} },
  {
    name: 'patient-low-sensitivity-2500ms',
    params: { endOfSpeechSensitivity: 'LOW' as const, endOfSpeechSilenceMs: 2_500 },
  },
  { name: 'manual-turn-control', params: { manualTurnControl: true, endOfSpeechSilenceMs: 2_500 } },
];

describeLive(`live: turn-taking presets on ${DEFAULT_LIVE_MODEL}`, () => {
  describe.each(PRESETS)('$name', ({ name, params }) => {
    const target = targetFor(name, { model: DEFAULT_LIVE_MODEL, ...params });
    const label = `${DEFAULT_LIVE_MODEL} / ${name}`;

    it('spoken turn is transcribed and answered', async () => {
      // audio-turn skips itself for a manual config; manual-turn-control covers it.
      expectCheck(await checkAudioTurn(target), label);
      if (params.manualTurnControl) expectCheck(await checkManualTurnControl(target), label);
    });

    it('patience: the configured silence is honoured across a mid-sentence pause', async () => {
      // Skips itself for server-default silence and for manual mode.
      expectCheck(await checkPatience(target), label);
    });

    it('barge-in interrupts the bot', async () => {
      expectCheck(await checkBargeIn(target), label);
    });

    it('latency from end of speech to first bot audio', async () => {
      expectCheck(await checkLatency(target), label);
    });
  });
});
