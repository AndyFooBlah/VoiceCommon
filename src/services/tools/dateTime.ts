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
 * Date/time Gemini tools for VoiceCommon voice AI agents.
 *
 * Provides two FunctionDeclarations and their implementations for natural-language
 * date/time arithmetic. Both tools use dateTimeUtils (LLM-assisted normalization
 * via Gemini) to handle vague, partial, and relative date expressions that standard
 * parsers cannot resolve — seasons, decades, relative references, circa years, etc.
 *
 * Tools:
 *   computeTimeDifferenceTool / getTimeDifference
 *     — human-readable gap between two natural-language date expressions
 *     — e.g. "about 27 years after summer 1997 (summer 2024)"
 *
 *   computeTimeOffsetTool / getTimeOffset
 *     — new date from a base expression plus an offset expression
 *     — e.g. "about 6 months later from July 4th, 1976 — around January 1977"
 *
 * Register via allTools in gemini.ts or compose a custom subset.
 */

import { FunctionDeclaration, Type } from '@google/genai';
import { getConfig } from '../config';
import { computeTimeDifference, computeTimeOffset } from '../dateTimeUtils';

/** Gemini function declaration for the time-difference tool. */
export const computeTimeDifferenceTool: FunctionDeclaration = {
  name: 'computeTimeDifference',
  description:
    'Compute the human-readable difference between two natural-language date or time expressions. ' +
    'Use this when the user asks how long ago something happened, how much time passed between two events, ' +
    'or any other question about the gap between two points in time.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      dateA: {
        type: Type.STRING,
        description:
          'The first date or time expression, in natural language ' +
          '(e.g. "summer 1997", "when I graduated", "around 3pm yesterday").',
      },
      dateB: {
        type: Type.STRING,
        description:
          'The second date or time expression, in natural language ' +
          '(e.g. "now", "2024", "when the war ended").',
      },
      currentDateTime: {
        type: Type.STRING,
        description:
          'The current date and time, used to resolve relative expressions like "now" or "last year" ' +
          '(e.g. "Sunday, April 12, 2026 at 12:00 AM PDT").',
      },
    },
    required: ['dateA', 'dateB', 'currentDateTime'],
  },
};

/** Gemini function declaration for the time-offset tool. */
export const computeTimeOffsetTool: FunctionDeclaration = {
  name: 'computeTimeOffset',
  description:
    'Compute a new point in time by adding or subtracting an offset from a natural-language base date. ' +
    'Use this when the user wants to know what date results from adding or subtracting some amount of time ' +
    '(e.g. "six months after my wedding", "2 years before I was born", "30 minutes after noon").',
  parameters: {
    type: Type.OBJECT,
    properties: {
      date: {
        type: Type.STRING,
        description:
          'The base date or time expression in natural language ' +
          '(e.g. "July 4th, 1976", "when we moved to Seattle", "noon on New Year\'s Day").',
      },
      offset: {
        type: Type.STRING,
        description:
          'The offset to apply, in natural language ' +
          '(e.g. "6 months later", "2 years earlier", "30 minutes after", "the following spring").',
      },
      currentDateTime: {
        type: Type.STRING,
        description:
          'The current date and time, used to resolve relative base date expressions ' +
          '(e.g. "Sunday, April 12, 2026 at 12:00 AM PDT").',
      },
    },
    required: ['date', 'offset', 'currentDateTime'],
  },
};

/**
 * Execute the time-difference tool.
 * Returns a human-readable string, e.g. "about 27 years after summer 1997 (summer 2024)".
 */
export async function getTimeDifference(
  dateA: string,
  dateB: string,
  currentDateTime: string,
): Promise<string> {
  const { result } = await computeTimeDifference(dateA, dateB, currentDateTime, getConfig().geminiApiKey);
  return result;
}

/**
 * Execute the time-offset tool.
 * Returns a human-readable string, e.g. "about 6 months later from July 4th, 1976 — around January 1977".
 */
export async function getTimeOffset(
  date: string,
  offset: string,
  currentDateTime: string,
): Promise<string> {
  const { result } = await computeTimeOffset(date, offset, currentDateTime, getConfig().geminiApiKey);
  return result;
}
