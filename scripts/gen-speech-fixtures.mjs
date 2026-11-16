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
 * Generate the committed speech fixtures used by the live conformance kit.
 *
 * Run ONCE (already done; the output is committed under fixtures/speech/).
 * Tests never synthesize at runtime. Re-running produces different audio,
 * because the TTS model is not deterministic, so only re-run to add or
 * replace a fixture, and commit the result together with manifest.json.
 *
 *   GEMINI_API_KEY=... node scripts/gen-speech-fixtures.mjs            # missing fixtures only
 *   GEMINI_API_KEY=... node scripts/gen-speech-fixtures.mjs --force    # regenerate all
 *   GEMINI_API_KEY=... node scripts/gen-speech-fixtures.mjs --only distinct-words --force
 *
 * Provenance: every voice is SYNTHETIC, produced by the Gemini TTS model
 * named in TTS_MODEL through the Interactions API
 * (https://aistudio.google.com/docs/speech-generation, verified 2026-11-15).
 * No recording of a real person is involved.
 *
 * The key is read from the environment, sent only in the x-goog-api-key
 * header, and never printed or written anywhere.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const TTS_MODEL = 'gemini-3.8-flash-tts';
const SAMPLE_RATE = 16_000;
// The TTS endpoint returns 24 kHz WAV. Its documented `sample_rate` option was
// rejected with HTTP 400 for 16000 when this was written (2026-11-15), so the
// script resamples to the Live API's native 16 kHz input rate itself.
const TTS_SAMPLE_RATE = 24_000;
const MAX_BYTES = 200 * 1024;
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'fixtures', 'speech');

/** @type {{id: string, text: string, voice: string, purpose: string}[]} */
const FIXTURES = [
  {
    id: 'question-capital',
    text: 'What is the capital of France?',
    voice: 'Kore',
    purpose: 'A short factual question: audio turn, latency.',
  },
  {
    id: 'story-part-1',
    text: 'When I was a child, we lived in a small house near the river,',
    voice: 'Charon',
    purpose: 'First half of a sentence; the patience check inserts a silent gap after it.',
  },
  {
    id: 'story-part-2',
    text: 'and every summer my grandmother baked apple pies for the whole street.',
    voice: 'Charon',
    purpose: 'Second half of the sentence started in story-part-1.',
  },
  {
    id: 'distinct-words',
    text: 'The seven yellow apples are in the garden by the window.',
    voice: 'Kore',
    purpose: 'A sentence of distinct words for input-transcription accuracy. (A bare word list came back from TTS at over eight seconds, beyond the fixture size limit.)',
  },
  {
    id: 'barge-in',
    text: 'Excuse me, sorry to interrupt, but please stop for a moment. I have a different question for you.',
    voice: 'Kore',
    purpose: 'Several seconds of continuous speech to interrupt the bot with.',
  },
  {
    id: 'goodbye',
    text: "Okay, that's everything I needed today. Thank you, goodbye.",
    voice: 'Charon',
    purpose: 'A clear sign-off, for apps that test their end-of-session tool.',
  },
];

function redact(text, key) {
  return String(text).split(key).join('[REDACTED]').replace(/AIza[A-Za-z0-9_-]{20,}/g, '[REDACTED]');
}

function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('TTS response is not a WAV file');
  }
  let offset = 12;
  let fmt = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const declared = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    const size = declared === 0xffffffff || body + declared > buf.length ? buf.length - body : declared;
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      return { ...fmt, pcm: buf.subarray(body, body + size) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

function encodeWav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * Trim leading and trailing near-silence so an utterance starts and ends
 * within a few tens of milliseconds of speech. The checks measure latency
 * from the end of the file, so a long silent tail would skew them.
 */
function trimSilence(pcm, { threshold = 0.012, windowMs = 10, leadMs = 60, tailMs = 80 } = {}) {
  const win = Math.round((SAMPLE_RATE * windowMs) / 1000);
  const samples = pcm.length / 2;
  const loud = [];
  for (let start = 0; start + win <= samples; start += win) {
    let sum = 0;
    for (let i = 0; i < win; i++) {
      const s = pcm.readInt16LE((start + i) * 2) / 32768;
      sum += s * s;
    }
    loud.push(Math.sqrt(sum / win) > threshold);
  }
  const first = loud.indexOf(true);
  const last = loud.lastIndexOf(true);
  if (first < 0) throw new Error('TTS returned silence');
  const from = Math.max(0, first * win - Math.round((SAMPLE_RATE * leadMs) / 1000));
  const to = Math.min(samples, (last + 1) * win + Math.round((SAMPLE_RATE * tailMs) / 1000));
  return Buffer.from(pcm.subarray(from * 2, to * 2));
}

/** Last audio block of an Interactions API response (`steps[].content[]`). */
function findAudio(interaction) {
  const blocks = (interaction?.steps ?? [])
    .filter((step) => step.type === 'model_output')
    .flatMap((step) => step.content ?? [])
    .filter((c) => c.type === 'audio' && typeof c.data === 'string');
  return blocks.length ? blocks[blocks.length - 1].data : null;
}

/**
 * Resample 16-bit mono PCM with a Hann-windowed sinc low-pass (cutoff just
 * under the target Nyquist frequency), so nothing aliases into the result.
 */
function resample(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;
  const inSamples = pcm.length / 2;
  const x = new Float64Array(inSamples);
  for (let i = 0; i < inSamples; i++) x[i] = pcm.readInt16LE(i * 2) / 32768;
  const ratio = fromRate / toRate;
  const outSamples = Math.floor(inSamples / ratio);
  const cutoff = (Math.min(fromRate, toRate) * 0.46) / fromRate; // cycles per input sample
  const half = 24;
  const out = Buffer.alloc(outSamples * 2);
  for (let n = 0; n < outSamples; n++) {
    const centre = n * ratio;
    const k0 = Math.ceil(centre - half);
    const k1 = Math.floor(centre + half);
    let acc = 0;
    for (let k = k0; k <= k1; k++) {
      if (k < 0 || k >= inSamples) continue;
      const t = centre - k;
      const arg = 2 * Math.PI * cutoff * t;
      const sinc = t === 0 ? 1 : Math.sin(arg) / arg;
      const window = 0.5 * (1 + Math.cos((Math.PI * t) / half));
      acc += x[k] * 2 * cutoff * sinc * window;
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(acc * 32768))), n * 2);
  }
  return out;
}

async function synthesize(fixture, key) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: [
        {
          type: 'user_input',
          content: [
            {
              type: 'text',
              text: fixture.text,
              annotations: [
                { type: 'speech_metadata', style: 'natural conversational pace, clear, close microphone, quiet room' },
              ],
            },
          ],
        },
      ],
      response_format: { type: 'audio', mime_type: 'audio/wav' },
      generation_config: { speech_config: [{ voice: fixture.voice }] },
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`TTS request failed: HTTP ${res.status} ${redact(body, key).slice(0, 400)}`);
  const data = findAudio(JSON.parse(body));
  if (!data) throw new Error(`TTS response had no audio: ${redact(body, key).slice(0, 400)}`);
  const wav = parseWav(Buffer.from(data, 'base64'));
  if (wav.sampleRate !== TTS_SAMPLE_RATE || wav.channels !== 1 || wav.bitsPerSample !== 16) {
    throw new Error(`Unexpected TTS format: ${wav.sampleRate} Hz, ${wav.channels} ch, ${wav.bitsPerSample} bit`);
  }
  return trimSilence(resample(wav.pcm, wav.sampleRate, SAMPLE_RATE));
}

async function main() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error('Set GEMINI_API_KEY in the environment (it is never printed or stored).');
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  const entries = [];
  let generated = 0;

  for (const fixture of FIXTURES) {
    const file = `${fixture.id}.wav`;
    const target = path.join(OUT_DIR, file);
    const wanted = (!only || only === fixture.id) && (force || !fs.existsSync(target));
    if (wanted) {
      let pcm;
      try {
        pcm = await synthesize(fixture, key);
      } catch (err) {
        console.error(`FAILED    ${file}: ${redact(err?.message ?? err, key)}`);
        process.exit(1);
      }
      const wav = encodeWav(pcm);
      if (wav.length > MAX_BYTES) {
        console.error(`FAILED    ${file}: ${wav.length} bytes exceeds the ${MAX_BYTES}-byte fixture limit; shorten the text`);
        process.exit(1);
      }
      fs.writeFileSync(target, wav);
      generated += 1;
      console.log(`generated ${file}  ${(wav.length / 1024).toFixed(0)} KB`);
    } else if (!fs.existsSync(target)) {
      console.log(`skip      ${file} (not selected and not on disk)`);
      continue;
    } else {
      console.log(`keep      ${file}`);
    }
    // The manifest entry always describes the file actually on disk.
    const onDisk = fs.readFileSync(target);
    const { pcm: diskPcm } = parseWav(onDisk);
    entries.push({
      id: fixture.id,
      file,
      text: fixture.text,
      voice: fixture.voice,
      purpose: fixture.purpose,
      durationMs: Math.round((diskPcm.length / 2 / SAMPLE_RATE) * 1000),
      bytes: onDisk.length,
      sha256: crypto.createHash('sha256').update(onDisk).digest('hex'),
    });
  }

  const manifest = {
    provenance: {
      generator: 'scripts/gen-speech-fixtures.mjs',
      model: TTS_MODEL,
      generatedAt: previous?.provenance?.generatedAt && generated === 0 ? previous.provenance.generatedAt : new Date().toISOString(),
      synthetic: true,
      note: 'All voices are synthetic (Gemini TTS prebuilt voices). No recording of a real person. Resampled from 24 kHz to 16 kHz; leading and trailing silence trimmed; otherwise unprocessed.',
    },
    format: { sampleRate: SAMPLE_RATE, channels: 1, bitsPerSample: 16, container: 'wav' },
    fixtures: entries,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote     ${path.relative(ROOT, manifestPath)}`);
}

await main();
