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
 * Provides a generic system instruction builder for voice AI sessions powered
 * by Gemini Live. Applications built on VoiceCommon supply their own system
 * instruction; this module provides a composable baseline.
 *
 * Knowledge tools (Wikipedia, Maps, Weather, Jokes, Date/Time) have been moved
 * to @andyfooblah/knowledgecommon. Import allKnowledgeTools from there and
 * pass them to your session alongside any application-specific tools.
 */

import type { FunctionDeclaration } from '@google/genai';

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
 * The built-in instruction establishes good conversational defaults.
 * Tool guidance should be injected via `appContext` based on which tools
 * the application has registered.
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
${appContext ? `\nAPPLICATION CONTEXT:\n${appContext}` : ''}
  `.trim();
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

/**
 * All VoiceCommon-specific tools. Currently empty — knowledge tools have moved
 * to @andyfooblah/knowledgecommon. Applications compose their own tool list:
 *
 * @example
 * ```ts
 * import { allKnowledgeTools } from '@andyfooblah/knowledgecommon';
 * const sessionTools = [...allKnowledgeTools, ...myAppTools];
 * ```
 */
export const allTools: FunctionDeclaration[] = [];
