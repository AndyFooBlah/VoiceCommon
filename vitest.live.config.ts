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
 * Vitest config for the LIVE suite: `npm run test:live`.
 *
 * These tests open real Gemini Live sessions. They self-skip unless
 * GEMINI_API_KEY is set in the environment, run in Node (no jsdom), and run
 * one file at a time so parallel sessions do not trip rate limits or skew
 * latency numbers. See TESTING.md.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/__tests__/live/**/*.live.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // A flaky network blip should not page anyone; a real failure repeats.
    retry: 1,
  },
});
