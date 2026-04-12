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
 * Gemini Live API session management for VoiceCommon.
 *
 * Provides a generic system instruction builder and tool registry for
 * voice AI sessions powered by Gemini Live. Applications built on
 * VoiceCommon supply their own system instruction; this module provides
 * the helpers and tool definitions they can compose with.
 *
 * Tool integrations are imported from src/services/tools/ and registered
 * via the allTools export for use in Gemini Live sessions.
 */

import { weatherTool } from './tools/weather';
import { mapsTool } from './tools/maps';
import { jokeTool } from './tools/jokes';
import { wikipediaTool } from './tools/wikipedia';

// ---------------------------------------------------------------------------
// Available Gemini voice presets
// ---------------------------------------------------------------------------

export type VoicePreset = 'Kore' | 'Puck' | 'Charon' | 'Fenrir' | 'Zephyr';

// ---------------------------------------------------------------------------
// System instruction builder
// ---------------------------------------------------------------------------

export interface BuildSessionInstructionOptions {
  /** The assistant's name, spoken aloud during sessions. */
  assistantName: string;
  /** Application-specific context injected into the system instruction. */
  appContext?: string;
  /** Current date/time string for temporal awareness (e.g. "Wednesday, April 8, 2026 at 2:30 PM"). */
  currentDateTime?: string;
}

/**
 * Build a generic session instruction for a VoiceCommon voice session.
 *
 * Applications should extend or replace this with their own instructions.
 * The built-in instruction establishes good conversational defaults and
 * wires up the standard tool descriptions.
 */
export function buildSessionInstruction(options: BuildSessionInstructionOptions): string {
  const { assistantName, appContext, currentDateTime } = options;

  return `
You are ${assistantName}, a helpful voice AI assistant.

CONVERSATION STYLE:
- Keep your responses concise — 1–3 sentences before asking a follow-up or waiting.
- Listen carefully and respond to what the user actually says.
- Do not repeat yourself. If there is silence, wait — do not re-ask.
- Match the user's energy and tone.

ENDING THE SESSION:
- When the user signals they are done (e.g. "goodbye", "that's all", "let's stop"), say a brief closing word then call 'endSession'.
- Example: "Great talking with you — take care!"
- Do not call 'endSession' on a brief pause.

TIME AWARENESS:
- Current date and time: ${currentDateTime ?? 'Unknown'}

KNOWLEDGE TOOLS:
- If the user asks about a historical event, person, or place, call 'searchWikipedia' to look it up. Do not read the raw result aloud — use it to give an informed, natural answer.
- For location context (where a place is, distance between places), call 'searchPlace' or 'getDistanceBetweenPlaces'.
- If the user asks for a joke or the moment calls for levity, call 'getJoke' and share it naturally.
- If the user asks about the weather, call 'getWeather' with the relevant location and share it conversationally.
${appContext ? `\nAPPLICATION CONTEXT:\n${appContext}` : ''}
  `.trim();
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

/**
 * All standard VoiceCommon tools, ready to pass to the Gemini Live API.
 * Applications can use a subset or extend with their own tool definitions.
 */
export const allTools = [
  weatherTool,
  mapsTool,
  jokeTool,
  wikipediaTool,
];
