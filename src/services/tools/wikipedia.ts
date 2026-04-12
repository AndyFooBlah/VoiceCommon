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
 * Wikipedia search tool for VoiceCommon.
 *
 * Uses the Wikipedia REST API to search for articles and return a brief
 * summary. No API key required. The AI should use this result to inform
 * its own responses rather than reading the content aloud verbatim.
 */

import { FunctionDeclaration, Type } from '@google/genai';

/** Gemini function declaration for Wikipedia search. */
export const wikipediaTool: FunctionDeclaration = {
  name: 'searchWikipedia',
  description: 'Look up a topic on Wikipedia. Use when the user mentions a historical event, person, or place you want more context on. Use the result to inform your response — do not read it aloud verbatim.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'The topic to search for on Wikipedia.',
      },
    },
    required: ['query'],
  },
};

/** Search Wikipedia and return a brief summary of the top result. */
export async function searchWikipedia(query: string): Promise<string> {
  try {
    // Use the Wikipedia search API to find the best matching article title
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=1&format=json&origin=*`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    const results = searchData?.query?.search;
    if (!results?.length) return `No Wikipedia article found for "${query}".`;

    const title = results[0].title;

    // Fetch the summary from the REST API
    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const summaryRes = await fetch(summaryUrl);
    const summaryData = await summaryRes.json();

    if (!summaryData.extract) return `Found "${title}" on Wikipedia but no summary is available.`;

    // Truncate to the first 3 sentences to keep context manageable
    const sentences = summaryData.extract.match(/[^.!?]+[.!?]+/g) ?? [summaryData.extract];
    const brief = sentences.slice(0, 3).join(' ').trim();

    return `Wikipedia: ${title} — ${brief}`;
  } catch (err) {
    return `Unable to retrieve Wikipedia information: ${String(err)}`;
  }
}
