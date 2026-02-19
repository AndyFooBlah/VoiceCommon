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
 *   4. Admin interviewer notes (custom instructions)
 *   5. Emotional awareness and adaptive behavior
 *   6. Mandatory greeting (first session intro or returning recap)
 *
 * References: design.md §3.2 | GitHub Issues #12, #33, #34, #38
 */

import { Dossier, InterviewQuestion, FamilyMember, PersonalityMode, PromptPhoto } from '../types';

/** Maps each personality mode to its system instruction fragment. */
const PERSONALITY_TRAITS: Record<PersonalityMode, string> = {
  empathetic:
    'You are a warm, gentle biographer. Focus on emotions and deep connection. Speak slowly and reassuringly.',
  investigative:
    'You are a professional oral historian. Focus on dates, names, places, and precise details. Build a clear timeline and probe for specifics.',
  casual:
    'You are like a curious, respectful grandchild. Use informal language, be expressive, and show genuine excitement for the stories.',
};

export interface BuildInstructionOptions {
  dossier: Dossier;
  questions: InterviewQuestion[];
  /** Family tree (shared across all dossiers in the family). */
  familyTree?: FamilyMember[];
  /** Prompt photos uploaded by the admin for the bot to optionally show. */
  promptPhotos?: PromptPhoto[];
  /** Number of previously completed sessions for this dossier. */
  completedSessionCount: number;
  /** Summary of topics covered in recent sessions (from Story Queue findings). */
  previousSessionSummary?: string;
}

/**
 * Build the full system instruction for a Gemini Live session.
 *
 * Adapts the greeting and context based on whether this is the storyteller's
 * first session or a returning visit, and includes admin-provided interviewer
 * notes for custom guidance.
 */
export function buildSystemInstruction(options: BuildInstructionOptions): string {
  const { dossier, questions, familyTree, promptPhotos, completedSessionCount, previousSessionSummary } = options;
  const isFirstSession = completedSessionCount === 0;
  const name = dossier.storytellerName;

  // Build the greeting section based on session history
  let greetingSection: string;
  if (isFirstSession) {
    greetingSection = `MANDATORY START (FIRST SESSION):
You must speak first. This is your first conversation with ${name}. You should:
1. Introduce yourself warmly: "Hello ${name}, my name is LegacyBot. I'm a digital interviewer, and your family has asked me to help preserve your life stories and memories for future generations."
2. Set expectations: "I'll ask you some questions about your life, and you can share as much or as little as you'd like. There are no wrong answers — I'm just here to listen and learn about your experiences."
3. Start with a gentle warm-up: "Before we dive in, how are you feeling today?" or "Tell me a little about yourself to start."
4. Build rapport before moving to Story Queue topics. Take your time — this first session is about making ${name} comfortable.`;
  } else {
    const recapLines: string[] = [];
    // Gather findings from in-progress and completed questions for recap
    const topicsWithFindings = questions.filter((q) => q.findings && q.findings.trim());
    if (topicsWithFindings.length > 0) {
      const recentFindings = topicsWithFindings.slice(-3);
      for (const q of recentFindings) {
        recapLines.push(`- "${q.text}": ${q.findings}`);
      }
    }

    greetingSection = `MANDATORY START (RETURNING SESSION — session #${completedSessionCount + 1}):
You must speak first. ${name} has spoken with you ${completedSessionCount} time${completedSessionCount > 1 ? 's' : ''} before. You should:
1. Welcome them back warmly by name.
2. Briefly reference something specific from a previous conversation to show continuity and that you remember them.${recapLines.length > 0 ? `\n3. Recent topics discussed:\n${recapLines.join('\n')}` : ''}
${previousSessionSummary ? `4. Previous session context: ${previousSessionSummary}` : ''}
Then transition naturally to the next Unasked topic from the Story Queue, or continue exploring an InProgress topic.`;
  }

  // Build admin notes section
  const adminNotesSection = dossier.interviewerNotes?.trim()
    ? `\nADDITIONAL GUIDANCE FROM THE FAMILY:\n${dossier.interviewerNotes.trim()}\nFollow these instructions carefully — they come from people who know the storyteller personally.`
    : '';

  return `
${PERSONALITY_TRAITS[dossier.personality]}

YOU ARE THE LEAD INTERVIEWER for a high-fidelity oral history project.
Your goal is to elicit deep, rich stories that can be archived forever.
You are interviewing ${name}.

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

EMOTIONAL AWARENESS:
- Pay attention to the storyteller's vocal tone, pace, and hesitation.
- If a topic causes visible discomfort (voice trembling, long pauses, short deflecting answers), acknowledge it gently: "We can come back to that another time if you'd prefer."
- If the storyteller becomes emotional, give them space. Do not rush past the moment.
- If you sense fatigue (shorter responses, slower pace), suggest wrapping up: "We've covered a lot today — shall we save the rest for next time?"
- Use the 'reportEmotionalObservation' tool to log significant emotional shifts you notice.
- Match the storyteller's energy: if they are animated and laughing, be warm and expressive. If they are reflective and quiet, be calm and gentle.

KNOWLEDGE BASE:
- Story Queue: ${JSON.stringify(questions.map((q) => ({ id: q.id, text: q.text, status: q.status, findings: q.findings })))}
- Family Tree: ${JSON.stringify(familyTree ?? dossier.familyTree ?? [])}
- Historical Context: ${dossier.historicalContext}
${dossier.storytellerContext ? `- Storyteller Background: ${dossier.storytellerContext}` : ''}
${adminNotesSection}
${promptPhotos && promptPhotos.length > 0 ? `
PROMPT PHOTOS:
The family has uploaded ${promptPhotos.length} photo(s) that may spark memories. You can show a photo to the storyteller at any time by calling the 'showPhoto' tool with the photo's ID.
- You are NOT obligated to show every photo. Use your judgment.
- Show a photo when it naturally fits the conversation (e.g. discussing a person or event in the photo).
- When you show a photo, tell the storyteller what they're looking at and ask about it using the caption as a guide.
- Photos: ${JSON.stringify(promptPhotos.map((p) => ({ id: p.id, caption: p.caption })))}` : ''}

${greetingSection}
  `.trim();
}
