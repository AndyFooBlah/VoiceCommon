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
 * PCM helpers for the live conformance kit. Node only (uses Buffer).
 *
 * The Live API takes raw 16-bit little-endian mono PCM. Input is 16 kHz;
 * output is 24 kHz.
 */

export const INPUT_SAMPLE_RATE = 16_000;
export const OUTPUT_SAMPLE_RATE = 24_000;
const BYTES_PER_SAMPLE = 2;

/** Bytes of 16-bit mono PCM for a duration. Always an even number. */
export function pcmBytesForMs(ms: number, sampleRate: number = INPUT_SAMPLE_RATE): number {
  return Math.round((ms / 1000) * sampleRate) * BYTES_PER_SAMPLE;
}

/** Duration in milliseconds of a 16-bit mono PCM buffer. */
export function pcmDurationMs(pcm: Uint8Array, sampleRate: number = INPUT_SAMPLE_RATE): number {
  return (pcm.byteLength / BYTES_PER_SAMPLE / sampleRate) * 1000;
}

/** Digital silence (all-zero samples). */
export function silencePcm(ms: number, sampleRate: number = INPUT_SAMPLE_RATE): Buffer {
  return Buffer.alloc(pcmBytesForMs(ms, sampleRate));
}

/** Concatenate PCM buffers of the same format. */
export function concatPcm(...parts: Uint8Array[]): Buffer {
  return Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
}

/** Join utterances with a gap of digital silence between each pair. */
export function joinWithSilence(parts: Uint8Array[], gapMs: number): Buffer {
  const out: Uint8Array[] = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push(silencePcm(gapMs));
    out.push(p);
  });
  return concatPcm(...out);
}

/** Root-mean-square level of 16-bit PCM, in [0, 1]. */
export function pcmRms(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const n = Math.floor(pcm.byteLength / BYTES_PER_SAMPLE);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * BYTES_PER_SAMPLE, true) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

export interface WavData {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** The raw sample bytes (the `data` chunk). */
  pcm: Buffer;
}

/** Parse a RIFF/WAVE file holding uncompressed PCM. */
export function parseWav(file: Uint8Array): WavData {
  const buf = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }
  let offset = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const declared = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    // Streaming encoders write 0 or 0xFFFFFFFF for an unknown length.
    const size = declared === 0xffffffff || body + declared > buf.length ? buf.length - body : declared;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data chunk precedes fmt chunk');
      // 1 = PCM, 0xFFFE = WAVE_FORMAT_EXTENSIBLE (PCM subtype in practice).
      if (fmt.format !== 1 && fmt.format !== 0xfffe) {
        throw new Error(`Unsupported WAV encoding ${fmt.format}; expected uncompressed PCM`);
      }
      return {
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitsPerSample: fmt.bitsPerSample,
        pcm: buf.subarray(body, body + size),
      };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV file has no data chunk');
}

/** Wrap 16-bit mono PCM in a WAV container. */
export function encodeWav(pcm: Uint8Array, sampleRate: number = INPUT_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.byteLength, 40);
  return concatPcm(header, pcm);
}
