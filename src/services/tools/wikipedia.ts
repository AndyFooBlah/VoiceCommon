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
 * Wikipedia RAG tool for VoiceCommon.
 *
 * Searches Wikipedia and returns semantically relevant chunks from the best
 * matching articles, using Firestore-cached embeddings for efficiency.
 *
 * Flow per call:
 *   1. Wikipedia OpenSearch → top 3 candidate article titles
 *   2. For each article, check `wikipedia_cache/{articleId}` freshness
 *   3. If stale or missing: fetch full article, chunk, batch-embed, store
 *   4. Embed the user's question
 *   5. Client-side cosine similarity against cached chunk embeddings
 *   6. Return top chunks grouped by article, ordered by chunkIndex
 *
 * Firestore schema:
 *   wikipedia_cache/{articleId}          → { title, fetchedAt, chunkCount }
 *   wikipedia_cache/{articleId}/chunks/{chunkIndex}
 *                                        → { text, chunkIndex, embedding: number[] }
 *
 * articleId = Wikipedia title with spaces replaced by underscores (lowercase).
 */

import { FunctionDeclaration, GoogleGenAI, Type } from '@google/genai';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  Timestamp,
} from 'firebase/firestore';
import { db } from '../firebase';
import { getConfig } from '../config';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHUNK_CHARS = 2048;        // ≈ 512 tokens (4 chars/token estimate)
const OVERLAP_CHARS = 400;       // ≈ 100 tokens overlap
const MAX_ARTICLE_CANDIDATES = 3;
const EMBED_MODEL = 'text-embedding-004';

// ---------------------------------------------------------------------------
// Tool declaration
// ---------------------------------------------------------------------------

/** Gemini function declaration for the Wikipedia RAG tool. */
export const wikipediaTool: FunctionDeclaration = {
  name: 'searchWikipedia',
  description:
    'Look up a topic on Wikipedia and return relevant factual passages. ' +
    'Use when the user asks about a historical event, person, place, or any ' +
    'factual topic you want more depth on. Use the passages to inform your ' +
    'response — do not read them aloud verbatim.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      question: {
        type: Type.STRING,
        description: 'The specific question or topic to look up on Wikipedia.',
      },
      maxChunks: {
        type: Type.NUMBER,
        description: 'Maximum number of text passages to return (default 4).',
      },
      maxAgeDays: {
        type: Type.NUMBER,
        description:
          'Maximum age of cached article content in days. Use a small value ' +
          '(e.g. 1) for current-events topics that change often; use a large ' +
          'value (e.g. 30) or omit for stable historical facts (default 7).',
      },
    },
    required: ['question'],
  },
};

// ---------------------------------------------------------------------------
// Main implementation
// ---------------------------------------------------------------------------

/** Search Wikipedia using RAG and return relevant passages. */
export async function searchWikipedia(args: {
  question: string;
  maxChunks?: number;
  maxAgeDays?: number;
}): Promise<string> {
  const { question, maxChunks = 4, maxAgeDays = 7 } = args;

  const t0 = Date.now();
  console.log(`[Wikipedia] Starting RAG search for: "${question}"`);

  try {
    // --- 1. OpenSearch: find top article titles ---
    const titles = await openSearch(question);
    if (titles.length === 0) {
      return `No Wikipedia articles found for "${question}".`;
    }
    console.log(`[Wikipedia] OpenSearch (${Date.now() - t0}ms) → ${titles.join(', ')}`);

    // --- 2. Embed the question ---
    const tEmbed = Date.now();
    const questionEmbedding = await embedTexts([question]);
    if (!questionEmbedding[0]) {
      return 'Unable to embed question for Wikipedia search.';
    }
    const qVec = questionEmbedding[0];
    console.log(`[Wikipedia] Question embedded (${Date.now() - tEmbed}ms)`);

    // --- 3. For each article: ensure cache is fresh, then score chunks ---
    const maxAgeMs = maxAgeDays * 86400 * 1000;
    const allScoredChunks: Array<{ articleTitle: string; chunkIndex: number; text: string; score: number }> = [];

    for (const title of titles.slice(0, MAX_ARTICLE_CANDIDATES)) {
      const articleId = titleToId(title);
      const chunks = await getOrFetchArticleChunks(articleId, title, maxAgeMs);
      if (chunks.length === 0) continue;

      // Score each chunk
      for (const chunk of chunks) {
        const score = cosineSimilarity(qVec, chunk.embedding);
        allScoredChunks.push({
          articleTitle: title,
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
          score,
        });
      }
    }

    if (allScoredChunks.length === 0) {
      return `Found Wikipedia articles for "${question}" but could not retrieve content.`;
    }

    // --- 4. Select top-k chunks by score, then regroup by article/chunkIndex ---
    const topChunks = allScoredChunks
      .sort((a, b) => b.score - a.score)
      .slice(0, maxChunks);

    // Group by article, preserve chunkIndex ordering within each article
    const byArticle = new Map<string, typeof topChunks>();
    for (const chunk of topChunks) {
      const group = byArticle.get(chunk.articleTitle) ?? [];
      group.push(chunk);
      byArticle.set(chunk.articleTitle, group);
    }

    const sections: string[] = [];
    for (const [articleTitle, chunks] of byArticle) {
      const sorted = chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
      const passages = sorted.map((c) => c.text).join('\n\n');
      sections.push(`## ${articleTitle}\n\n${passages}`);
    }

    console.log(
      `[Wikipedia] RAG complete (${Date.now() - t0}ms total). ` +
      `Articles: ${byArticle.size}, chunks returned: ${topChunks.length}`,
    );

    return sections.join('\n\n---\n\n');
  } catch (err) {
    console.error('[Wikipedia] RAG search failed:', err);
    return `Unable to retrieve Wikipedia information: ${String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Wikipedia API helpers
// ---------------------------------------------------------------------------

/** OpenSearch Wikipedia and return up to MAX_ARTICLE_CANDIDATES titles. */
async function openSearch(query: string): Promise<string[]> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}` +
    `&limit=${MAX_ARTICLE_CANDIDATES}&namespace=0&format=json&origin=*`;
  const res = await fetch(url);
  const data = await res.json();
  // OpenSearch returns [query, [titles], [descriptions], [urls]]
  return (data[1] as string[]) ?? [];
}

/** Fetch the full plaintext of a Wikipedia article via the extracts API. */
async function fetchArticleText(title: string): Promise<string | null> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exlimit=1` +
    `&titles=${encodeURIComponent(title)}&format=json&origin=*`;
  const res = await fetch(url);
  const data = await res.json();
  const pages = data?.query?.pages as Record<string, { extract?: string }> | undefined;
  if (!pages) return null;
  const page = Object.values(pages)[0];
  if (!page?.extract) return null;

  // Strip HTML tags — the extract API returns HTML
  return page.extract
    .replace(/<\/?(h[1-6]|p|ul|ol|li|b|i|a|span|div|br)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Split text into overlapping chunks at paragraph boundaries where possible.
 * Targets CHUNK_CHARS characters per chunk with OVERLAP_CHARS overlap.
 */
function chunkText(text: string): string[] {
  // Split on paragraph boundaries first
  const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);

  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 1 > CHUNK_CHARS && current.length > 0) {
      chunks.push(current.trim());
      // Start next chunk with overlap from the end of the current one
      const overlapStart = Math.max(0, current.length - OVERLAP_CHARS);
      current = current.slice(overlapStart) + '\n' + para;
    } else {
      current = current ? current + '\n' + para : para;
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Firestore cache
// ---------------------------------------------------------------------------

interface CachedChunk {
  text: string;
  chunkIndex: number;
  embedding: number[];
}

/** Convert a Wikipedia title to a Firestore-safe document ID. */
function titleToId(title: string): string {
  return title.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '-');
}

/**
 * Return cached chunks for an article, fetching and caching if necessary.
 * Refreshes the cache if older than maxAgeMs milliseconds.
 */
async function getOrFetchArticleChunks(
  articleId: string,
  title: string,
  maxAgeMs: number,
): Promise<CachedChunk[]> {
  const articleRef = doc(db, 'wikipedia_cache', articleId);

  // Check cache freshness
  const tCheck = Date.now();
  const snap = await getDoc(articleRef);
  console.log(`[Wikipedia] Cache check for "${title}" (${Date.now() - tCheck}ms)`);

  if (snap.exists()) {
    const data = snap.data() as { fetchedAt: Timestamp; chunkCount: number };
    const ageMs = Date.now() - data.fetchedAt.toMillis();
    if (ageMs < maxAgeMs) {
      // Cache is fresh — load chunks
      const tLoad = Date.now();
      const chunks = await loadChunks(articleId, data.chunkCount);
      console.log(`[Wikipedia] Loaded ${chunks.length} cached chunks for "${title}" (${Date.now() - tLoad}ms)`);
      return chunks;
    }
    console.log(`[Wikipedia] Cache stale for "${title}" (${Math.round(ageMs / 86400000)}d old), refreshing`);
  } else {
    console.log(`[Wikipedia] No cache for "${title}", fetching`);
  }

  // Fetch and (re)cache the article
  return fetchAndCacheArticle(articleId, title, articleRef);
}

/** Load all chunks from the Firestore subcollection. */
async function loadChunks(articleId: string, chunkCount: number): Promise<CachedChunk[]> {
  const chunksRef = collection(db, 'wikipedia_cache', articleId, 'chunks');
  const snap = await getDocs(chunksRef);
  return snap.docs
    .map((d) => d.data() as CachedChunk)
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
    .slice(0, chunkCount); // guard against extra docs
}

/** Fetch article text, chunk it, embed all chunks, and store in Firestore. */
async function fetchAndCacheArticle(
  articleId: string,
  title: string,
  articleRef: ReturnType<typeof doc>,
): Promise<CachedChunk[]> {
  // Fetch article text
  const tFetch = Date.now();
  const text = await fetchArticleText(title);
  console.log(`[Wikipedia] Fetched article "${title}" (${Date.now() - tFetch}ms)`);
  if (!text) return [];

  // Chunk the text
  const rawChunks = chunkText(text);
  if (rawChunks.length === 0) return [];
  console.log(`[Wikipedia] Split into ${rawChunks.length} chunks`);

  // Batch-embed all chunks
  const tEmbed = Date.now();
  const embeddings = await embedTexts(rawChunks);
  console.log(`[Wikipedia] Batch-embedded ${rawChunks.length} chunks (${Date.now() - tEmbed}ms)`);

  // Store article metadata
  await setDoc(articleRef, {
    title,
    fetchedAt: Timestamp.now(),
    chunkCount: rawChunks.length,
  });

  // Store each chunk
  const chunks: CachedChunk[] = [];
  const chunksRef = collection(db, 'wikipedia_cache', articleId, 'chunks');
  const tStore = Date.now();
  await Promise.all(
    rawChunks.map(async (text, i) => {
      const embedding = embeddings[i] ?? [];
      const chunk: CachedChunk = { text, chunkIndex: i, embedding };
      await setDoc(doc(chunksRef, String(i)), chunk);
      chunks.push(chunk);
    }),
  );
  console.log(`[Wikipedia] Stored ${chunks.length} chunks for "${title}" (${Date.now() - tStore}ms)`);

  return chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

/**
 * Batch-embed a list of texts using text-embedding-004.
 * Returns one embedding vector per input text, in the same order.
 * Returns empty arrays for any inputs that fail.
 */
async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const { geminiApiKey } = getConfig();
  const ai = new GoogleGenAI({ apiKey: geminiApiKey });

  const response = await ai.models.embedContent({
    model: EMBED_MODEL,
    contents: texts,
  });

  return (response.embeddings ?? []).map((e) => e.values ?? []);
}

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

/** Cosine similarity between two vectors. Returns 0 if either is zero-length. */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
