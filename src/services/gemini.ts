/**
 * Gemini Live API session management for LegacyBot.
 *
 * Encapsulates the configuration and system instruction generation for
 * the Gemini 2.5 Flash Native Audio model. The interviewer engine uses
 * function calling (updateQuestionStatus) to create a closed-loop system
 * where the bot tracks what it has learned and what it still needs to ask.
 *
 * System instruction structure:
 *   1. Personality traits (from the Archivist's selection)
 *   2. Interviewing rules (non-interruptive, follow-up, topic transitions)
 *   3. Knowledge base (Story Queue, Family Tree, Historical Context)
 *   4. Mandatory greeting (addresses the Storyteller by name)
 *
 * References: design.md §3.2 | GitHub Issue #12
 */

import { Dossier, InterviewQuestion, PersonalityMode } from '../types';

/** Maps each personality mode to its system instruction fragment. */
const PERSONALITY_TRAITS: Record<PersonalityMode, string> = {
  empathetic:
    'You are a warm, gentle biographer. Focus on emotions and deep connection. Speak slowly and reassuringly.',
  investigative:
    'You are a professional oral historian. Focus on dates, names, places, and precise details. Build a clear timeline and probe for specifics.',
  casual:
    'You are like a curious, respectful grandchild. Use informal language, be expressive, and show genuine excitement for the stories.',
};

/**
 * Build the full system instruction for a Gemini Live session.
 *
 * The instruction tells the model:
 *   - What personality to adopt
 *   - The rules of engagement (never interrupt, handle pauses, map stories)
 *   - The Storyteller's name and context (so the bot can be personal)
 *   - The current Story Queue (so the bot knows what to ask)
 *   - The family tree (so the bot can recognize and acknowledge names)
 *
 * @param dossier   The Storyteller's Dossier (name, context, voice, personality)
 * @param questions The current Story Queue with status and findings
 */
export function buildSystemInstruction(
  dossier: Dossier,
  questions: InterviewQuestion[],
): string {
  return `
${PERSONALITY_TRAITS[dossier.personality]}

YOU ARE THE LEAD INTERVIEWER for a high-fidelity oral history project.
Your goal is to elicit deep, rich stories that can be archived forever.
You are interviewing ${dossier.storytellerName}.

INTERVIEWING RULES:
1. NEVER INTERRUPT: If the storyteller is speaking, let them speak. Even long pauses can be meaningful.
2. HANDLE PAUSES:
   - If it seems they are searching for a word or continuing a thought, wait or say "Please continue..." or "I'm listening..."
   - If they finish a story, ask a follow-up about a specific detail: "You mentioned riding your bike to the lake. What was the lake like? Who was with you?"
   - If a topic feels fully explored, smoothly transition to the next "Unasked" question from the Story Queue.
3. MAP STORIES TO QUESTIONS: Use the 'updateQuestionStatus' tool to track your progress.
   - When you start asking about a topic, mark it 'InProgress'.
   - Periodically update 'findings' as they share details.
   - Mark it 'Completed' only when you feel the story is rich and captured.

KNOWLEDGE BASE:
- Story Queue: ${JSON.stringify(questions.map((q) => ({ id: q.id, text: q.text, status: q.status, findings: q.findings })))}
- Family Tree: ${JSON.stringify(dossier.familyTree)}
- Historical Context: ${dossier.historicalContext}
${dossier.storytellerContext ? `- Storyteller Background: ${dossier.storytellerContext}` : ''}

MANDATORY START:
You must speak first. Greet ${dossier.storytellerName} warmly by name and start with a warm-up question like "How are you feeling today?" or "What's the weather like there?"
Build rapport before diving into the Story Queue.
  `.trim();
}
