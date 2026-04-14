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
 * CLI integration test for the Wikipedia RAG pipeline.
 *
 * Tests the full pipeline from question → Wikipedia search → Gemini filter →
 * embedding → chunk scoring → result, WITHOUT Firestore (noCache: true).
 *
 * Requirements: GEMINI_API_KEY environment variable.
 *
 * Usage:
 *   GEMINI_API_KEY=AIza... npx tsx scripts/test-wikipedia-rag.ts "Artemis II splashdown date"
 *   GEMINI_API_KEY=AIza... npx tsx scripts/test-wikipedia-rag.ts  # uses default test cases
 *
 * Exit codes:
 *   0 — all test cases produced non-error results
 *   1 — one or more test cases failed or threw
 */

import { initializeVoiceCommon } from '../src/services/config';
import { searchWikipedia, openSearch, fetchSummary } from '../src/services/tools/wikipedia';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
  console.error('ERROR: GEMINI_API_KEY environment variable is required.');
  console.error('Usage: GEMINI_API_KEY=AIza... npx tsx scripts/test-wikipedia-rag.ts [question]');
  process.exit(1);
}

// Initialize VoiceCommon with a dummy Firebase config (not used in noCache mode)
// and the real Gemini API key.
initializeVoiceCommon({
  firebase: {
    apiKey: 'dummy-for-cli-test',
    authDomain: 'dummy.firebaseapp.com',
    projectId: 'dummy-project',
    storageBucket: 'dummy.appspot.com',
    messagingSenderId: '000000000000',
    appId: '1:000000000000:web:000000000000000000000000',
  },
  geminiApiKey,
});

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

const DEFAULT_TEST_CASES = [
  // Descriptive queries (would have returned 0 with action=opensearch)
  'Artemis II splashdown date',
  'Apollo 11 first moon landing year',
  // Short noun-phrase queries
  'Abraham Lincoln',
  // Current-events style (maxAgeDays=1 to bypass any stale cache)
  'International Space Station crew 2025',
];

const questions = process.argv[2] ? [process.argv[2]] : DEFAULT_TEST_CASES;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let failed = 0;

async function runPipelineTest(question: string): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log(`QUESTION: "${question}"`);
  console.log('='.repeat(70));

  try {
    const t0 = Date.now();
    const result = await searchWikipedia({ question, noCache: true, maxChunks: 2 });
    const elapsed = Date.now() - t0;

    if (result.match(/unavailable|unable to retrieve|no wikipedia/i)) {
      console.error(`FAIL (${elapsed}ms): Result indicates an error — "${result.slice(0, 100)}"`);
      failed++;
    } else {
      console.log(`PASS (${elapsed}ms): ${result.length} chars returned`);
      console.log('\nFirst 400 chars of result:');
      console.log(result.slice(0, 400) + (result.length > 400 ? '...' : ''));
    }
  } catch (err) {
    console.error('FAIL (threw):', err);
    failed++;
  }
}

async function runApiTests(): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('WIKIPEDIA API CHECKS (no Gemini)');
  console.log('='.repeat(70));

  // Verify full-text search returns results for a descriptive query
  const descriptiveQuery = 'Artemis II splashdown date';
  const titles = await openSearch(descriptiveQuery, 5);
  if (titles.length === 0) {
    console.error(`FAIL: openSearch("${descriptiveQuery}") → 0 results (API format may have changed)`);
    failed++;
  } else {
    console.log(`PASS: openSearch → [${titles.join(', ')}]`);
  }

  // Verify summary fetch works
  const summary = await fetchSummary('Artemis II');
  if (!summary) {
    console.error('FAIL: fetchSummary("Artemis II") → null');
    failed++;
  } else {
    console.log(`PASS: fetchSummary("Artemis II") → "${summary.description}" (${summary.extract.length} chars)`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log('Wikipedia RAG Integration Test');
  console.log(`Gemini key: ${geminiApiKey.slice(0, 8)}...`);
  console.log(`Test cases: ${questions.length}`);

  await runApiTests();

  for (const question of questions) {
    await runPipelineTest(question);
  }

  console.log('\n' + '='.repeat(70));
  if (failed === 0) {
    console.log(`ALL TESTS PASSED`);
  } else {
    console.error(`${failed} TEST(S) FAILED`);
    process.exit(1);
  }
})();
