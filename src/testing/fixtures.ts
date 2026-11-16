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
 * Committed speech fixtures for the live conformance kit.
 *
 * The fixtures are short 16 kHz mono 16-bit WAV files of SYNTHETIC speech,
 * generated once by `scripts/gen-speech-fixtures.mjs` and committed under
 * `fixtures/speech/` (shipped in the npm package). Nothing is synthesized at
 * test time. `fixtures/speech/manifest.json` records the text, voice, model
 * and checksum of each file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INPUT_SAMPLE_RATE, parseWav, pcmDurationMs } from './audio';

/** Fixture ids shipped with the package. */
export const SPEECH_FIXTURE_IDS = [
  'question-capital',
  'story-part-1',
  'story-part-2',
  'distinct-words',
  'barge-in',
  'goodbye',
] as const;

export type SpeechFixtureId = (typeof SPEECH_FIXTURE_IDS)[number];

export interface SpeechFixtureManifestEntry {
  id: string;
  file: string;
  /** The words spoken, used for fuzzy transcription checks. */
  text: string;
  voice: string;
  durationMs: number;
  bytes: number;
  sha256: string;
}

export interface SpeechFixtureManifest {
  /** How the files were produced. */
  provenance: {
    generator: string;
    model: string;
    generatedAt: string;
    synthetic: true;
    note: string;
  };
  format: { sampleRate: number; channels: number; bitsPerSample: number; container: string };
  fixtures: SpeechFixtureManifestEntry[];
}

export interface SpeechFixture extends SpeechFixtureManifestEntry {
  /** Raw 16 kHz mono 16-bit little-endian PCM, ready for `sendAudioPcm16k`. */
  pcm: Buffer;
}

let cachedDir: string | null = null;

/**
 * Locate `fixtures/speech/`. The directory sits at the package root, which is
 * one level above `dist/` in the published package and two above
 * `src/testing/` in the repository, so walk upward until it is found.
 */
export function speechFixturesDir(): string {
  if (cachedDir) return cachedDir;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'fixtures', 'speech');
    if (fs.existsSync(path.join(candidate, 'manifest.json'))) {
      cachedDir = candidate;
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'voice-common speech fixtures not found (expected fixtures/speech/manifest.json in the package root)',
  );
}

/** Read the fixture manifest. */
export function readSpeechFixtureManifest(): SpeechFixtureManifest {
  const file = path.join(speechFixturesDir(), 'manifest.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as SpeechFixtureManifest;
}

/** Load one fixture's PCM and metadata. */
export function loadSpeechFixture(id: SpeechFixtureId | (string & {})): SpeechFixture {
  const manifest = readSpeechFixtureManifest();
  const entry = manifest.fixtures.find((f) => f.id === id);
  if (!entry) {
    throw new Error(
      `Unknown speech fixture '${id}'. Available: ${manifest.fixtures.map((f) => f.id).join(', ')}`,
    );
  }
  const wav = parseWav(fs.readFileSync(path.join(speechFixturesDir(), entry.file)));
  if (wav.sampleRate !== INPUT_SAMPLE_RATE || wav.channels !== 1 || wav.bitsPerSample !== 16) {
    throw new Error(
      `Speech fixture '${id}' is ${wav.sampleRate} Hz / ${wav.channels} ch / ${wav.bitsPerSample} bit; expected 16000 Hz mono 16-bit`,
    );
  }
  return { ...entry, durationMs: Math.round(pcmDurationMs(wav.pcm)), pcm: wav.pcm };
}

/** Load a WAV file of your own (must be 16 kHz mono 16-bit PCM). */
export function loadWavPcm16k(filePath: string): Buffer {
  const wav = parseWav(fs.readFileSync(filePath));
  if (wav.sampleRate !== INPUT_SAMPLE_RATE || wav.channels !== 1 || wav.bitsPerSample !== 16) {
    throw new Error(
      `${path.basename(filePath)} is ${wav.sampleRate} Hz / ${wav.channels} ch / ${wav.bitsPerSample} bit; expected 16000 Hz mono 16-bit`,
    );
  }
  return wav.pcm;
}
