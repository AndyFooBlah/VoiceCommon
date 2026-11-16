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
 * LIVE: provider-contract canaries.
 *
 * These measure what the server actually accepts and compare it with the
 * model registry (src/services/liveModels.ts). A flip is reported as
 * "PROVIDER CONTRACT CHANGED" rather than as an ordinary failure: sessions
 * may still work, but the registry and its `'auto'` defaults need review.
 *
 * Also proves that `thinkingLevel: 'auto'` produces a working session on the
 * extended-thinking and legacy models, not only on the default.
 */

import { it } from 'vitest';
import { LIVE_API_VERSION } from '../../services/liveConnectConfig';
import { DEFAULT_LIVE_MODEL, LIVE_MODELS } from '../../services/liveModels';
import {
  canaryRegistryFreshness,
  canarySilentToolResponse,
  canaryThinkingContract,
  canaryToolBehaviorContract,
  canaryToolCallOrdering,
  checkEphemeralToken,
  checkModelListed,
  checkSetupAccepted,
  checkTextTurn,
  checkToolRoundTrip,
} from '../../testing';
import { LIVE_API_KEY, describeLive, expectCheck, targetFor } from './liveEnv';

const EXTENDED = 'gemini-3.8-live-extended-thinking';
const LEGACY = 'gemini-3.1-flash-live-preview';

// Every registry model whose thinking contract has been measured.
const MEASURED = Object.values(LIVE_MODELS)
  .filter((m) => m.status !== 'shutdown' && m.thinking.support !== 'unverified')
  .map((m) => m.id);

describeLive('live: provider-contract canaries', () => {
  it.each(MEASURED)('thinkingConfig contract matches the registry: %s', async (model) => {
    expectCheck(await canaryThinkingContract(LIVE_API_KEY, model), model);
  });

  it.each(MEASURED)('BLOCKING tool declaration contract matches the registry: %s', async (model) => {
    expectCheck(await canaryToolBehaviorContract(LIVE_API_KEY, model), model);
  });

  // useSession's transcript, speaking state and end-of-session handling are
  // verified offline against recorded traces of each model's event order
  // (useSession.replay.test.ts). These notice when the provider changes it.
  it.each(MEASURED)('tool-call event ordering matches the registry: %s', async (model) => {
    expectCheck(await canaryToolCallOrdering(LIVE_API_KEY, model), model);
  });

  it.each(MEASURED)('a SILENT tool response is not followed by speech: %s', async (model) => {
    // Skips itself for models useSession never sends SILENT to.
    expectCheck(await canarySilentToolResponse(LIVE_API_KEY, model), model);
  });

  it('no dialogue Live model is listed that the registry does not know', async () => {
    expectCheck(await canaryRegistryFreshness(LIVE_API_KEY), 'registry');
  });

  it.each([EXTENDED, LEGACY])('%s is listed with bidiGenerateContent', async (model) => {
    expectCheck(await checkModelListed(LIVE_API_KEY, model), model);
  });
});

describeLive("live: thinkingLevel 'auto' yields a working session on the non-default models", () => {
  it.each([EXTENDED, LEGACY])('%s: setup, text turn and tool round trip', async (model) => {
    const target = targetFor('auto', { model });
    const label = `${model} / auto`;
    expectCheck(await checkSetupAccepted(target), label);
    expectCheck(await checkTextTurn(target), label);
    expectCheck(await checkToolRoundTrip(target), label);
  }, 240_000);
});

describeLive('live: ephemeral-token API version matrix', () => {
  // The apps' brokers mint on v1alpha today; the provider docs now show
  // v1beta. Every combination must keep working so neither side is forced
  // to move first. The first row is the production path.
  const target = targetFor('default', { model: DEFAULT_LIVE_MODEL });
  const versions = [
    ['v1alpha', LIVE_API_VERSION],
    ['v1beta', LIVE_API_VERSION],
    ['v1alpha', 'v1beta'],
    ['v1beta', 'v1beta'],
  ] as const;

  it.each(versions)('token minted on %s connects on %s', async (mintApiVersion, connectApiVersion) => {
    expectCheck(
      await checkEphemeralToken(target, { mintApiVersion, connectApiVersion }),
      `${DEFAULT_LIVE_MODEL} / token`,
    );
  });
});
