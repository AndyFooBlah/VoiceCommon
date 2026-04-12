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
 * Joke tool for VoiceCommon.
 *
 * Fetches a random safe-for-work joke from the JokeAPI (jokeapi.dev).
 * No API key required. Returns a setup + punchline or single-part joke
 * formatted for natural delivery in voice conversation.
 */

import { FunctionDeclaration, Type } from '@google/genai';

/** Gemini function declaration for the joke tool. */
export const jokeTool: FunctionDeclaration = {
  name: 'getJoke',
  description: 'Get a random joke to share with the user. Call when the user asks for a joke or levity is called for.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      category: {
        type: Type.STRING,
        description: 'Optional joke category: "general", "pun", "programming", or "misc". Defaults to random.',
      },
    },
    required: [],
  },
};

/** Fetch a random joke and return it as a string suitable for voice delivery. */
export async function getJoke(category?: string): Promise<string> {
  try {
    const categories = ['general', 'pun', 'programming', 'misc'];
    const cat = category && categories.includes(category) ? category : 'Any';
    const url = `https://v2.jokeapi.dev/joke/${cat}?safe-mode&type=twopart,single`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.error) return "I couldn't think of a joke right now — sorry!";

    if (data.type === 'twopart') {
      return `${data.setup} ... ${data.delivery}`;
    }
    return data.joke ?? "I couldn't think of a joke right now — sorry!";
  } catch {
    return "I couldn't fetch a joke right now — my comedy database seems to be offline!";
  }
}
