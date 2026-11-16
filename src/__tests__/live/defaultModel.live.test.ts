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
 * LIVE: the full conformance check list for DEFAULT_LIVE_MODEL with the
 * config `useSession` builds by default (thinking 'auto', server VAD with
 * default sensitivities, endSession injected, resumption + compression on).
 *
 * Runs only via `npm run test:live` with GEMINI_API_KEY set.
 */

import { it } from 'vitest';
import { DEFAULT_LIVE_MODEL } from '../../services/liveModels';
import {
  checkAudioTurn,
  checkBargeIn,
  checkContextWindowCompression,
  checkEphemeralToken,
  checkLatency,
  checkManualTurnControl,
  checkModelListed,
  checkPatience,
  checkSessionResumption,
  checkSetupAccepted,
  checkTextTurn,
  checkToolDeclarationsAccepted,
  checkToolRoundTrip,
} from '../../testing';
import { LIVE_API_KEY, describeLive, expectCheck, targetFor } from './liveEnv';

describeLive(`live: ${DEFAULT_LIVE_MODEL} with the hook's default config`, () => {
  const target = targetFor('default', { model: DEFAULT_LIVE_MODEL });
  const label = `${DEFAULT_LIVE_MODEL} / default`;

  it('(1) setup is accepted', async () => {
    expectCheck(await checkSetupAccepted(target), label);
  });

  it('(2) text turn produces audio, transcription and turnComplete', async () => {
    expectCheck(await checkTextTurn(target), label);
  });

  it('(3) audio turn under server VAD is transcribed and answered', async () => {
    expectCheck(await checkAudioTurn(target), label);
  });

  it('(3b) input transcription is accurate on a sentence of distinct words', async () => {
    expectCheck(await checkAudioTurn(target, { fixture: 'distinct-words', minWordMatch: 0.8 }), `${label} / distinct-words`);
  });

  it('(4a) the tool declaration list is accepted', async () => {
    expectCheck(await checkToolDeclarationsAccepted(target), label);
  });

  it('(4b) tool round trip: built-in probe tool', async () => {
    expectCheck(await checkToolRoundTrip(target), `${label} / builtin-probe`);
  });

  it('(4c) tool round trip: an application tool with arguments', async () => {
    expectCheck(
      await checkToolRoundTrip(target, {
        prompt: 'What is the weather in Paris right now? Use the getWeather tool.',
        expectTool: 'getWeather',
        result: 'It is 18 degrees Celsius and sunny in Paris.',
        expectInReply: 'sunny',
      }),
      `${label} / app-tool`,
    );
  });

  it('(5) manual turn control produces a reply', async () => {
    expectCheck(await checkManualTurnControl(target), label);
  });

  it('(6) patience: a 3000 ms silenceDurationMs is honoured across a 1800 ms pause', async () => {
    expectCheck(await checkPatience(target, { silenceMs: 3_000 }), `${label} / silence=3000`);
  });

  it('(7) barge-in interrupts the bot', async () => {
    expectCheck(await checkBargeIn(target), label);
  });

  it('(8) session resumption keeps context across a reconnect', async () => {
    expectCheck(await checkSessionResumption(target), label);
  });

  it('(9) context window compression is accepted', async () => {
    expectCheck(await checkContextWindowCompression(target), label);
  });

  it('(11) the model is listed with bidiGenerateContent', async () => {
    expectCheck(await checkModelListed(LIVE_API_KEY, DEFAULT_LIVE_MODEL), label);
  });

  it("(12) ephemeral-token path on the hook's pinned API version", async () => {
    expectCheck(await checkEphemeralToken(target), label);
  });

  it('(13) latency from end of speech to first bot audio', async () => {
    expectCheck(await checkLatency(target), label);
  });
});
