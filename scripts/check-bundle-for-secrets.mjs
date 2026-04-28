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
 * Post-build guard: scan the published library bundle for shapes that look
 * like real API keys and fail loudly if any sensitive key is present.
 *
 * Libraries owe nobody an allowlist — they are consumed by other projects
 * and must NEVER ship a key (not even a "dev" or "test" one). Any match
 * fails the build.
 *
 * Run as: `node scripts/check-bundle-for-secrets.mjs`
 * Hooked to `npm run build:lib`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const PATTERNS = [
  { name: 'Google API key (Gemini / Maps / Firebase)', re: /AIza[A-Za-z0-9_-]{35}/g },
  { name: 'OpenAI / Anthropic-style key',              re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: 'Google OAuth access token',                 re: /\bya29\.[A-Za-z0-9_-]{20,}/g },
  { name: 'Slack token',                                re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'GitHub personal access token',               re: /\bgh[opsu]_[A-Za-z0-9]{36,}/g },
  { name: 'GCP service account JSON shape',             re: /"type"\s*:\s*"service_account"/g },
];

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(js|mjs|cjs|d\.ts|map|json|txt)$/i.test(entry.name)) yield full;
  }
}

if (!fs.existsSync(DIST)) {
  console.error(`[check-bundle-for-secrets] ${DIST} does not exist — run "npm run build:lib" first.`);
  process.exit(2);
}

const findings = [];
for (const file of walk(DIST)) {
  const text = fs.readFileSync(file, 'utf8');
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      findings.push({ file: path.relative(ROOT, file), name, value: m[0] });
    }
  }
}

if (findings.length === 0) {
  console.log('[check-bundle-for-secrets] dist/ is clean — no API-key shapes found.');
  process.exit(0);
}

console.error(`\n[check-bundle-for-secrets] FAIL — ${findings.length} suspected secret${findings.length === 1 ? '' : 's'} in published library bundle:\n`);
for (const { file, name, value } of findings) {
  const masked = value.length > 16 ? value.slice(0, 8) + '…' + value.slice(-4) : value;
  console.error(`  ${file}`);
  console.error(`    ${name}: ${masked}`);
}
console.error(`\nLibraries must never ship API keys — not even Firebase config. Consumers`);
console.error(`supply runtime configuration via initializeVoiceCommon(...). Fix the leak.\n`);
process.exit(1);
