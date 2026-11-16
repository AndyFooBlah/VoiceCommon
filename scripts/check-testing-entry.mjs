#!/usr/bin/env node
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
 * Post-build guard for the `@andyfooblah/voice-common/testing` entry.
 *
 * The testing entry is a Node-only live conformance kit. It must load in a
 * plain Node process with nothing but `@google/genai` installed, so it must
 * never pull in React, the DOM or Firebase, directly or through a shared
 * chunk. This script:
 *   1. walks the import graph of dist/testing.js and fails on any import that
 *      is not a relative chunk, `@google/genai`, or a `node:` built-in;
 *   2. imports dist/testing.js under Node and checks the public surface;
 *   3. loads every speech fixture through the built entry, proving the
 *      fixtures directory is found from dist/.
 *
 * Run as: `node scripts/check-testing-entry.mjs` (part of `npm run build:lib`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'dist', 'testing.js');
const ALLOWED = [/^@google\/genai$/, /^node:/];
const TAG = '[check-testing-entry]';

if (!fs.existsSync(ENTRY)) {
  console.error(`${TAG} ${ENTRY} does not exist — run "npm run build:lib" first.`);
  process.exit(2);
}

// 1. Import graph.
const seen = new Set();
const external = new Map();
const queue = [ENTRY];
while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const code = fs.readFileSync(file, 'utf8');
  const specifiers = [
    ...code.matchAll(/\bimport\s*(?:[^'"()]*?\bfrom\s*)?["']([^"']+)["']/g),
    ...code.matchAll(/\bexport\s*[^'"]*?\bfrom\s*["']([^"']+)["']/g),
    ...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1]);
  for (const spec of specifiers) {
    if (spec.startsWith('.')) queue.push(path.resolve(path.dirname(file), spec));
    else external.set(spec, path.relative(ROOT, file));
  }
}

const forbidden = [...external].filter(([spec]) => !ALLOWED.some((re) => re.test(spec)));
if (forbidden.length) {
  console.error(`${TAG} FAIL — the testing entry must only import @google/genai and node: built-ins, but found:`);
  for (const [spec, from] of forbidden) console.error(`  ${spec}  (imported by ${from})`);
  process.exit(1);
}

// 2. Loads under plain Node, with the expected surface.
const kit = await import(pathToFileURL(ENTRY).href);
const required = [
  'LiveTestSession',
  'runLiveConformance',
  'assertLiveConformance',
  'formatLiveConformanceReport',
  'buildLiveConnectConfig',
  'resolveThinkingConfig',
  'loadSpeechFixture',
  'checkSetupAccepted',
  'canaryThinkingContract',
  'DEFAULT_LIVE_MODEL',
  'LIVE_MODELS',
];
const missing = required.filter((name) => !(name in kit));
if (missing.length) {
  console.error(`${TAG} FAIL — dist/testing.js is missing exports: ${missing.join(', ')}`);
  process.exit(1);
}

// 3. Fixtures resolve from the built entry.
for (const id of kit.SPEECH_FIXTURE_IDS) {
  const fixture = kit.loadSpeechFixture(id);
  if (!fixture.pcm?.byteLength) {
    console.error(`${TAG} FAIL — speech fixture '${id}' loaded empty`);
    process.exit(1);
  }
}

console.log(
  `${TAG} dist/testing.js loads under Node (${seen.size} file(s); externals: ${[...external.keys()].sort().join(', ')}); ` +
    `${kit.SPEECH_FIXTURE_IDS.length} fixtures resolve; default model ${kit.DEFAULT_LIVE_MODEL}.`,
);
