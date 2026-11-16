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
 * Fuzzy text comparison for transcription checks. Speech recognition output
 * varies in case, punctuation and number formatting, so checks compare words.
 */

const DIGIT_WORDS: Record<string, string> = {
  '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six',
  '7': 'seven', '8': 'eight', '9': 'nine', '10': 'ten', '11': 'eleven', '12': 'twelve',
};

/** Lower-case words with punctuation removed and small numbers spelled out. */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => DIGIT_WORDS[w] ?? w);
}

/**
 * Fraction (0..1) of the distinct words in `expected` that appear in
 * `actual`. Order is ignored. Returns 0 when `expected` has no words.
 */
export function wordMatchRatio(expected: string, actual: string): number {
  const want = new Set(normalizeWords(expected));
  if (want.size === 0) return 0;
  const got = new Set(normalizeWords(actual));
  let hit = 0;
  for (const w of want) if (got.has(w)) hit++;
  return hit / want.size;
}

/** True when every word of `needle` appears in `haystack` (any order). */
export function containsWords(haystack: string, needle: string): boolean {
  return wordMatchRatio(needle, haystack) === 1;
}

/** Shorten text for a report line. */
export function clip(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
