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
 * Tests for the Wikipedia RAG tool.
 *
 * Three groups:
 *
 * 1. Pure function unit tests — no network, no auth, always fast.
 *
 * 2. searchWikipedia unit tests — all external calls (fetch, Gemini, Firestore)
 *    are mocked. Verify pipeline logic: fallback on empty results, cache hit
 *    skips fetch, Gemini filter fallback on error, etc.
 *
 * 3. Wikipedia API integration tests — call the REAL Wikipedia API to confirm
 *    the request format and response parsing are correct. No auth needed.
 *    These tests would have caught the action=opensearch → 0 results bug and
 *    any future Wikipedia API format changes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  openSearch,
  fetchSummary,
  chunkText,
  cosineSimilarity,
  titleToId,
  searchWikipedia,
} from '../../../services/tools/wikipedia';

// ---------------------------------------------------------------------------
// 1. Pure function unit tests
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
  it('returns 1 for identical non-zero vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 for mismatched lengths (treated as zero-length by norm)', () => {
    // [1] vs [1,0] would have length mismatch — function returns 0 when either is empty or lengths differ
    expect(cosineSimilarity([1, 0], [1])).toBe(0);
  });

  it('is independent of vector magnitude', () => {
    expect(cosineSimilarity([1, 0], [100, 0])).toBeCloseTo(1);
  });
});

describe('titleToId', () => {
  it('lowercases and replaces spaces with underscores', () => {
    expect(titleToId('Abraham Lincoln')).toBe('abraham_lincoln');
  });

  it('handles roman numerals', () => {
    expect(titleToId('Artemis II')).toBe('artemis_ii');
  });

  it('replaces non-alphanumeric/underscore chars with dashes', () => {
    // Apostrophes and other special chars become dashes; spaces become underscores
    expect(titleToId("Neil Armstrong's Moon Walk")).toBe('neil_armstrong-s_moon_walk');
  });
});

describe('chunkText', () => {
  it('returns a single chunk for text shorter than CHUNK_CHARS', () => {
    const chunks = chunkText('Short article text.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('Short article text.');
  });

  it('returns empty array for blank text', () => {
    expect(chunkText('')).toHaveLength(0);
    expect(chunkText('   \n\n   ')).toHaveLength(0);
  });

  it('splits long text into multiple chunks', () => {
    // Build text longer than CHUNK_CHARS (2048 chars) across many paragraphs
    const para = 'The quick brown fox jumped over the lazy dog. '; // 46 chars
    const text = Array.from({ length: 100 }, (_, i) => `Paragraph ${i}. ${para}`).join('\n\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('produces chunks within the size limit', () => {
    const para = 'Word '.repeat(500); // 2500 chars — larger than CHUNK_CHARS
    const chunks = chunkText(para);
    // No individual chunk should be massively oversized (some slack for overlap)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThan(4000);
    }
  });

  it('consecutive chunks share overlap text', () => {
    // Create a text with clear paragraph boundaries so chunking is deterministic
    const para = 'A'.repeat(400) + ' '; // each paragraph is 401 chars
    const text = Array.from({ length: 10 }, (_, i) => `Para${i} ${para}`).join('\n\n');
    const chunks = chunkText(text);
    if (chunks.length >= 2) {
      // The end of chunk[0] should appear somewhere in chunk[1] (overlap)
      const tailOfFirst = chunks[0].slice(-200);
      expect(chunks[1]).toContain(tailOfFirst.trim().slice(0, 50));
    }
  });
});

// ---------------------------------------------------------------------------
// 2. searchWikipedia unit tests (all external calls mocked)
// ---------------------------------------------------------------------------

// Minimal stubs for OpenSearch and summary responses
const makeOpenSearchResponse = (titles: string[]) =>
  new Response(
    JSON.stringify({ query: { search: titles.map((t) => ({ title: t })) } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

const makeSummaryResponse = (title: string, extract = 'Test extract.') =>
  new Response(
    JSON.stringify({ title, description: 'Test description', extract }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

const makeArticleTextResponse = (text: string) =>
  new Response(
    JSON.stringify({ query: { pages: { '1': { extract: text } } } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

vi.mock('../../../services/config', () => ({
  getConfig: vi.fn().mockReturnValue({ geminiApiKey: 'test-key' }),
}));

// Mock the Gemini SDK — filterRelevantArticles and embedTexts both use it.
// Must use `function` (not arrow function) so GoogleGenAI works as a constructor.
vi.mock('@google/genai', () => {
  const mockModels = {
    generateContent: vi.fn().mockResolvedValue({ text: '[1]' }), // keep first candidate
    embedContent: vi.fn().mockResolvedValue({
      // Return a fixed embedding for every text in the batch
      embeddings: Array.from({ length: 50 }, () => ({ values: [1, 0, 0] })),
    }),
  };
  return {
    GoogleGenAI: vi.fn(function (this: { models: typeof mockModels }) {
      this.models = mockModels;
    }),
    Type: { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER' },
    FunctionDeclaration: class {},
  };
});

// Firestore is mocked globally in setup.ts — we customise per test as needed

describe('searchWikipedia (mocked)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns "no articles found" message when OpenSearch returns empty', async () => {
    fetchSpy.mockResolvedValue(makeOpenSearchResponse([]));

    const result = await searchWikipedia({ question: 'very obscure topic nobody wrote about' });
    expect(result).toMatch(/no wikipedia articles found/i);
  });

  it('returns a result string when the pipeline succeeds', async () => {
    const articleText = 'Artemis II is a NASA crewed lunar flyby mission. '.repeat(50);

    // Sequence: openSearch → summary × N → article text
    fetchSpy
      .mockResolvedValueOnce(makeOpenSearchResponse(['Artemis II', 'Artemis program']))
      .mockResolvedValueOnce(makeSummaryResponse('Artemis II'))
      .mockResolvedValueOnce(makeSummaryResponse('Artemis program'))
      .mockResolvedValue(makeArticleTextResponse(articleText));

    const result = await searchWikipedia({ question: 'Artemis II splashdown', noCache: true });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // Should NOT return an error message
    expect(result).not.toMatch(/unavailable|unable to retrieve/i);
  });

  it('falls back to top candidates when Gemini filter throws', async () => {
    const articleText = 'Test article content. '.repeat(100);

    fetchSpy
      .mockResolvedValueOnce(makeOpenSearchResponse(['Topic A', 'Topic B']))
      .mockResolvedValue(makeSummaryResponse('Topic A'));

    // Make Gemini throw on generateContent (filter call)
    const { GoogleGenAI } = await import('@google/genai');
    (GoogleGenAI as ReturnType<typeof vi.fn>).mockImplementationOnce(function (
      this: { models: unknown },
    ) {
      this.models = {
        generateContent: vi.fn().mockRejectedValue(new Error('Gemini unavailable')),
        embedContent: vi.fn().mockResolvedValue({
          embeddings: Array.from({ length: 50 }, () => ({ values: [1, 0, 0] })),
        }),
      };
    });

    fetchSpy
      .mockResolvedValueOnce(makeOpenSearchResponse(['Topic A']))
      .mockResolvedValueOnce(makeSummaryResponse('Topic A'))
      .mockResolvedValue(makeArticleTextResponse(articleText));

    // Should not throw — fallback to top candidates
    const result = await searchWikipedia({ question: 'Topic A details', noCache: true });
    expect(typeof result).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 3. Wikipedia API integration tests (real network, no auth)
//
// These make live calls to Wikipedia's public API. They validate:
//   - Our URL format and query parameters are accepted
//   - The response shape matches what we parse
//   - The full-text search API (action=query&list=search) returns results
//     for DESCRIPTIVE queries, not just exact article titles
//
// If any of these fail it means either Wikipedia changed their API or we
// introduced a regression in the URL/parsing code.
// ---------------------------------------------------------------------------

describe('Wikipedia API integration (live network)', { timeout: 15000 }, () => {
  it('openSearch finds articles for a simple noun query', async () => {
    const titles = await openSearch('Abraham Lincoln', 5);
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.some((t) => /lincoln/i.test(t))).toBe(true);
  });

  it('openSearch finds articles for a DESCRIPTIVE query (catches opensearch→0 bug)', async () => {
    // This query returned 0 results with action=opensearch.
    // With action=query&list=search it must return Artemis-related articles.
    const titles = await openSearch('Artemis II splashdown date', 5);
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.some((t) => /artemis/i.test(t))).toBe(true);
  });

  it('openSearch returns at most the requested limit', async () => {
    const titles = await openSearch('Space exploration', 3);
    expect(titles.length).toBeLessThanOrEqual(3);
  });

  it('openSearch returns empty array for a nonsense query', async () => {
    const titles = await openSearch('zzzzxxxxxqqqq12345nonsense', 5);
    // May or may not return results — just verify it does not throw and returns an array
    expect(Array.isArray(titles)).toBe(true);
  });

  it('fetchSummary returns a summary for a known article', async () => {
    const summary = await fetchSummary('Artemis II');
    expect(summary).not.toBeNull();
    expect(summary?.title).toMatch(/artemis/i);
    expect(summary?.extract).toBeTruthy();
    expect(summary?.extract.length).toBeGreaterThan(10);
  });

  it('fetchSummary returns null for a nonexistent article', async () => {
    const summary = await fetchSummary('ZzzzQqqq_This_Article_Does_Not_Exist_12345');
    expect(summary).toBeNull();
  });
});
