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
 * Offline tests for the pure parts of the live conformance kit: redaction,
 * fuzzy text matching, PCM/WAV helpers, and the integrity of the committed
 * speech fixtures. No network, no key.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  INPUT_SAMPLE_RATE,
  SPEECH_FIXTURE_IDS,
  concatPcm,
  containsWords,
  encodeWav,
  joinWithSilence,
  loadSpeechFixture,
  makeRedactor,
  normalizeWords,
  parseWav,
  pcmDurationMs,
  pcmRms,
  readSpeechFixtureManifest,
  redactSecrets,
  silencePcm,
  speechFixturesDir,
  wordMatchRatio,
} from '../../testing';

// Assembled at runtime so no key-shaped literal sits in the source tree.
const FAKE_KEY = ['AI', 'za', 'Sy', 'FAKEfakeFAKEfakeFAKEfakeFAKEfake123'].join('');
const FAKE_TOKEN = `auth_tokens/${'abc123DEF456'.repeat(3)}`;

describe('redaction', () => {
  it('removes a known secret verbatim wherever it appears', () => {
    const redact = makeRedactor(['super-secret-value-123']);
    expect(redact('error at wss://host?x=super-secret-value-123&y=1 (super-secret-value-123)')).toBe(
      'error at wss://host?x=[REDACTED]&y=1 ([REDACTED])',
    );
  });

  it('removes Google API keys by shape even when not told the value', () => {
    expect(redactSecrets(`request failed for ${FAKE_KEY}`)).toBe('request failed for [REDACTED]');
    expect(redactSecrets(`request failed for ${FAKE_KEY}`)).not.toContain('AIza');
  });

  it('removes ephemeral tokens by shape', () => {
    expect(redactSecrets(`token ${FAKE_TOKEN} rejected`)).toBe('token [REDACTED] rejected');
  });

  it('removes credentials carried in a URL query string, keeping the parameter name', () => {
    const out = redactSecrets('wss://x/ws/Service.BidiGenerateContent?key=abc.DEF-123_xyz&alt=json');
    expect(out).toBe('wss://x/ws/Service.BidiGenerateContent?key=[REDACTED]&alt=json');
    expect(redactSecrets('https://x/y?access_token=zzzTOKENzzz')).toBe('https://x/y?access_token=[REDACTED]');
  });

  it('redacts Error objects and structured values', () => {
    const redact = makeRedactor([FAKE_KEY]);
    expect(redact(new Error(`bad key ${FAKE_KEY}`))).toBe('bad key [REDACTED]');
    expect(redact({ url: `https://x?key=${FAKE_KEY}` })).not.toContain(FAKE_KEY);
  });

  it('leaves ordinary text alone and ignores empty secrets', () => {
    const redact = makeRedactor([undefined, null, '', 'ab']);
    expect(redact('1007 Thinking level is not supported for this model.')).toBe(
      '1007 Thinking level is not supported for this model.',
    );
  });
});

describe('fuzzy text matching', () => {
  it('ignores case, punctuation and apostrophes', () => {
    expect(normalizeWords("What's the Capital, of FRANCE?")).toEqual(['whats', 'the', 'capital', 'of', 'france']);
    expect(wordMatchRatio('What is the capital of France?', 'what is the capital of france')).toBe(1);
  });

  it('treats small digits and their words as the same', () => {
    expect(wordMatchRatio('The seven yellow apples', 'the 7 yellow apples')).toBe(1);
  });

  it('returns the fraction of expected words that were heard', () => {
    expect(wordMatchRatio('one two three four', 'one two')).toBe(0.5);
    expect(wordMatchRatio('one two three four', '')).toBe(0);
    expect(wordMatchRatio('', 'anything')).toBe(0);
  });

  it('containsWords needs every word', () => {
    expect(containsWords('The code word is Marigold.', 'marigold')).toBe(true);
    expect(containsWords('The code word is a secret.', 'marigold')).toBe(false);
  });
});

describe('PCM and WAV helpers', () => {
  it('makes digital silence of the right length', () => {
    const s = silencePcm(250);
    expect(s.byteLength).toBe(0.25 * INPUT_SAMPLE_RATE * 2);
    expect(pcmDurationMs(s)).toBe(250);
    expect(pcmRms(s)).toBe(0);
    expect(s.every((b) => b === 0)).toBe(true);
  });

  it('joins utterances with a silent gap', () => {
    const a = Buffer.alloc(3200, 1);
    const b = Buffer.alloc(1600, 2);
    const joined = joinWithSilence([a, b], 100);
    expect(joined.byteLength).toBe(3200 + 3200 + 1600);
    expect(joined.subarray(3200, 6400).every((x) => x === 0)).toBe(true);
    expect(concatPcm(a, b).byteLength).toBe(4800);
  });

  it('round-trips PCM through a WAV container', () => {
    const pcm = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 10) * 12000), i * 2);
    const wav = parseWav(encodeWav(pcm));
    expect(wav).toMatchObject({ sampleRate: 16_000, channels: 1, bitsPerSample: 16 });
    expect(Buffer.compare(wav.pcm, pcm)).toBe(0);
    expect(pcmRms(pcm)).toBeGreaterThan(0.2);
  });

  it('rejects input that is not WAV', () => {
    expect(() => parseWav(Buffer.from('not a wav file at all'))).toThrow(/Not a RIFF\/WAVE file/);
  });
});

describe('committed speech fixtures', () => {
  const manifest = readSpeechFixtureManifest();

  it('records synthetic provenance', () => {
    expect(manifest.provenance.synthetic).toBe(true);
    expect(manifest.provenance.generator).toBe('scripts/gen-speech-fixtures.mjs');
    expect(manifest.provenance.model).toMatch(/^gemini-.*tts$/);
    expect(manifest.format).toEqual({ sampleRate: 16_000, channels: 1, bitsPerSample: 16, container: 'wav' });
  });

  it('lists exactly the exported fixture ids', () => {
    expect(manifest.fixtures.map((f) => f.id).sort()).toEqual([...SPEECH_FIXTURE_IDS].sort());
  });

  it.each(SPEECH_FIXTURE_IDS)('%s is a small 16 kHz mono 16-bit WAV matching its checksum', (id) => {
    const entry = manifest.fixtures.find((f) => f.id === id)!;
    const file = fs.readFileSync(path.join(speechFixturesDir(), entry.file));
    expect(file.byteLength).toBeLessThan(200 * 1024);
    expect(file.byteLength).toBe(entry.bytes);
    expect(crypto.createHash('sha256').update(file).digest('hex')).toBe(entry.sha256);

    const fixture = loadSpeechFixture(id);
    expect(fixture.text.length).toBeGreaterThan(5);
    expect(fixture.durationMs).toBeGreaterThan(1_000);
    expect(fixture.durationMs).toBeLessThan(6_500);
    expect(fixture.pcm.byteLength % 2).toBe(0);
    // Real speech, not silence.
    expect(pcmRms(fixture.pcm)).toBeGreaterThan(0.01);
  });

  it('fails clearly for an unknown fixture', () => {
    expect(() => loadSpeechFixture('nope')).toThrow(/Unknown speech fixture 'nope'. Available: /);
  });
});
