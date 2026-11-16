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
 * Guard: no retired model id may return to shipping source.
 *
 * Scans production source (src/ minus tests and mocks, scripts/, functions/src)
 * for Gemini model ids and requires each one to be either
 *   - a model the Live registry marks `current`, or
 *   - a known, verified non-Live model (KNOWN_OTHER_MODELS below).
 * An id the registry marks `legacy` or `shutdown` may appear only in the
 * registry file itself, or on a line carrying the marker `model-history:`
 * (a comment explaining the past). Anything else fails, with the file and
 * line, so a stale constant cannot come back unnoticed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { DEFAULT_LIVE_MODEL, LIVE_MODELS, getLiveModelInfo } from '../services/liveModels';

const ROOT = path.resolve(__dirname, '..', '..');

/** Non-Live model ids production source may name. Verify against the provider docs before adding one. */
const KNOWN_OTHER_MODELS: Record<string, string> = {
  'gemini-3.8-flash-tts': 'TTS model used once by scripts/gen-speech-fixtures.mjs (current per docs, 2026-11-15)',
};

/** Files allowed to name legacy and shut-down ids: the registry is where they are recorded. */
const REGISTRY_FILES = new Set(['src/services/liveModels.ts']);

const HISTORY_MARKER = 'model-history:';

const MODEL_ID = /\bgemini-(?:\d|live-|embedding|omni|nano)[a-z0-9.-]*/g;

type Finding = { file: string; line: number; id: string; problem: string };

function classify(file: string, lineNumber: number, lineText: string): Finding[] {
  const findings: Finding[] = [];
  for (const match of lineText.matchAll(MODEL_ID)) {
    const id = match[0].replace(/[.-]+$/, '');
    const info = getLiveModelInfo(id);
    if (info) {
      if (info.status === 'current') continue;
      if (REGISTRY_FILES.has(file) || lineText.includes(HISTORY_MARKER)) continue;
      findings.push({
        file,
        line: lineNumber,
        id,
        problem: `${info.status} Live model (replacement: ${info.replacement ?? DEFAULT_LIVE_MODEL})`,
      });
    } else if (!(id in KNOWN_OTHER_MODELS)) {
      findings.push({
        file,
        line: lineNumber,
        id,
        problem: 'unknown model id: verify it against the provider docs, then add it to the registry or KNOWN_OTHER_MODELS',
      });
    }
  }
  return findings;
}

function* sourceFiles(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '__tests__', '__mocks__', 'dist', 'lib'].includes(entry.name)) continue;
      yield* sourceFiles(full);
    } else if (/\.(ts|tsx|js|mjs|cjs|json)$/.test(entry.name)) {
      yield full;
    }
  }
}

function scan(): Finding[] {
  const findings: Finding[] = [];
  for (const top of ['src', 'scripts', path.join('functions', 'src')]) {
    for (const full of sourceFiles(path.join(ROOT, top))) {
      const file = path.relative(ROOT, full).split(path.sep).join('/');
      fs.readFileSync(full, 'utf8')
        .split('\n')
        .forEach((text, i) => findings.push(...classify(file, i + 1, text)));
    }
  }
  return findings;
}

describe('no retired model ids in shipping source', () => {
  it('finds nothing stale or unknown', () => {
    const findings = scan();
    const report = findings.map((f) => `${f.file}:${f.line}  ${f.id}  ${f.problem}`).join('\n');
    expect(report).toBe('');
  });

  it('the scanner actually sees model ids (it is not vacuously green)', () => {
    const registry = fs.readFileSync(path.join(ROOT, 'src/services/liveModels.ts'), 'utf8');
    const seen = new Set([...registry.matchAll(MODEL_ID)].map((m) => m[0].replace(/[.-]+$/, '')));
    for (const id of Object.keys(LIVE_MODELS)) expect(seen).toContain(id);
  });

  it('flags a legacy id outside the registry', () => {
    const line = "export const MODEL = 'gemini-3.1-flash-live-preview';";
    expect(classify('src/hooks/useSession.ts', 10, line)).toEqual([
      {
        file: 'src/hooks/useSession.ts',
        line: 10,
        id: 'gemini-3.1-flash-live-preview',
        problem: 'legacy Live model (replacement: gemini-3.8-live)',
      },
    ]);
  });

  it('flags a shut-down id and an id nobody has verified', () => {
    expect(classify('src/a.ts', 1, "'gemini-2.0-flash-live-001'")[0].problem).toMatch(/^shutdown Live model/);
    expect(classify('src/a.ts', 1, "actorModel: 'gemini-3-flash-preview',")[0].problem).toMatch(/^unknown model id/);
  });

  it('allows legacy ids in the registry file and on marked history lines', () => {
    expect(classify('src/services/liveModels.ts', 1, "'gemini-3.1-flash-live-preview': {")).toEqual([]);
    expect(
      classify('src/hooks/useSession.ts', 1, '// model-history: the default was gemini-3.1-flash-live-preview through 0.15.x'),
    ).toEqual([]);
  });

  it('allows current Live models and verified non-Live models, and ignores non-model words', () => {
    expect(classify('src/a.ts', 1, "'gemini-3.8-live' 'gemini-3.8-live-extended-thinking' gemini-3.8-live.")).toEqual([]);
    expect(classify('scripts/x.mjs', 1, "const TTS_MODEL = 'gemini-3.8-flash-tts';")).toEqual([]);
    expect(classify('src/a.ts', 1, 'see ai.google.dev/gemini-api/docs and gemini-live-api-dev')).toEqual([
      // "gemini-live-api-dev" looks like a model id; it must be reported, not skipped silently.
      expect.objectContaining({ id: 'gemini-live-api-dev' }),
    ]);
  });
});
