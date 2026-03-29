/**
 * Post-session analysis service for LegacyBot.
 *
 * After a session completes, runs three analyses using Gemini text API:
 *   1. Event extraction — structured life events from the transcript (#35)
 *   2. Engagement assessment — comfort/engagement metrics (#45)
 *   3. Question suggestions — new Story Queue topics (#41)
 *
 * All analyses are stored to Firestore and displayed in the admin UI.
 *
 * Uses Gemini 2.5 Flash (text) for cost-efficient analysis.
 */

import { GoogleGenAI } from '@google/genai';
import { Timestamp } from 'firebase/firestore';
import {
  TranscriptEntry,
  InterviewQuestion,
  StoryEvent,
  EventSource,
  SessionEngagement,
  SuggestedQuestion,
  Dossier,
} from '../types';

const getAI = () => new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });

/** Format transcript entries into readable text for the LLM (no indices). */
function formatTranscript(entries: TranscriptEntry[]): string {
  return entries
    .map((e) => `${e.role === 'user' ? 'Storyteller' : 'Bot'}: ${e.text}`)
    .join('\n');
}

/** Format transcript entries with [index] prefix for event extraction. */
function formatTranscriptIndexed(entries: TranscriptEntry[]): string {
  return entries
    .map((e, idx) => `[${idx}] ${e.role === 'user' ? 'Storyteller' : 'Bot'}: ${e.text}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Event Extraction (#35)
// ---------------------------------------------------------------------------

export async function extractEvents(
  entries: TranscriptEntry[],
  sessionId: string,
  existingEvents: StoryEvent[],
): Promise<Omit<StoryEvent, 'id' | 'createdAt' | 'updatedAt'>[]> {
  const ai = getAI();
  const transcript = formatTranscriptIndexed(entries);

  const existingEventsContext = existingEvents.length > 0
    ? `\nExisting events already extracted from previous sessions:\n${JSON.stringify(existingEvents.map(e => ({ title: e.title, date: e.date, description: e.description })), null, 2)}\n\nDo NOT duplicate these. Only extract NEW events or provide additional details for existing events.`
    : '';

  const response = await ai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    config: { thinkingConfig: { thinkingLevel: 'high' } },
    contents: `You are an expert oral historian analyzing an interview transcript.
Extract discrete life events mentioned in this conversation. Each event should be a specific moment, period, or experience — not a vague topic.

Each line of the transcript is prefixed with [index]. Use these indices to record which lines mention each event.

For each event provide:
- title: Short descriptive title (e.g. "First day at Lincoln Elementary")
- description: 2-3 sentence narrative summary
- date: ISO date, partial date, or fuzzy description (e.g. "1962", "summer 1962", "early 1970s"). null if unknown.
- datePrecision: "exact" | "month" | "year" | "decade" | "approximate"
- location: Place name or null if not mentioned
- themes: Array of themes (e.g. ["childhood", "education"])
- people: Names of people mentioned in connection with this event
- entryIndices: Array of transcript line indices (numbers) that mention or describe this event

${existingEventsContext}

Respond with a JSON array of events. If no new events are found, respond with [].

TRANSCRIPT:
${transcript}`,
  });

  const text = response.text ?? '[]';
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const rawEvents = JSON.parse(jsonMatch[0]);
    return rawEvents.map((e: any) => ({
      title: e.title ?? 'Untitled event',
      description: e.description ?? '',
      date: e.date ?? null,
      datePrecision: e.datePrecision ?? 'approximate',
      location: e.location ?? null,
      themes: Array.isArray(e.themes) ? e.themes : [],
      people: Array.isArray(e.people) ? e.people : [],
      sources: [{
        sessionId,
        entryIndices: Array.isArray(e.entryIndices) ? (e.entryIndices as number[]) : [],
      }] as EventSource[],
    }));
  } catch {
    console.error('[PostSession] Failed to parse events JSON');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Engagement Assessment (#45)
// ---------------------------------------------------------------------------

/** Compute text-based engagement metrics from a transcript. */
export function computeEngagementMetrics(
  entries: TranscriptEntry[],
): Pick<SessionEngagement, 'speakingRatio' | 'avgResponseLength'> {
  const userEntries = entries.filter((e) => e.role === 'user');
  const botEntries = entries.filter((e) => e.role === 'bot');

  const userWords = userEntries.reduce((sum, e) => sum + e.text.split(/\s+/).length, 0);
  const botWords = botEntries.reduce((sum, e) => sum + e.text.split(/\s+/).length, 0);
  const totalWords = userWords + botWords;

  return {
    speakingRatio: totalWords > 0 ? userWords / totalWords : 0,
    avgResponseLength: userEntries.length > 0 ? userWords / userEntries.length : 0,
  };
}

/** Use Gemini to assess sentiment and comfort from the transcript. */
export async function assessEngagement(
  entries: TranscriptEntry[],
  questions: InterviewQuestion[],
): Promise<Omit<SessionEngagement, 'analyzedAt'>> {
  const basicMetrics = computeEngagementMetrics(entries);
  const ai = getAI();
  const transcript = formatTranscript(entries);

  const questionContext = questions.length > 0
    ? `\nStory Queue topics discussed:\n${questions.map(q => `- "${q.text}" (${q.status})`).join('\n')}`
    : '';

  const response = await ai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    config: { thinkingConfig: { thinkingLevel: 'high' } },
    contents: `You are an expert at analyzing interview dynamics. Assess the storyteller's engagement and emotional comfort in this interview transcript.

Provide your assessment as JSON with these fields:
- sentiment: "positive" | "neutral" | "guarded" | "distressed"
- comfortScore: 0-100 (100 = very comfortable and engaged)
- topicEngagement: object mapping topic/question text to a 0-100 engagement score
- flags: array of concern flags (e.g. "topic_avoidance:military", "short_responses", "declining_engagement", "emotional_distress:war_stories")

Consider:
- Response length and detail (longer, more detailed = more engaged)
- Emotional language and enthusiasm
- Topic avoidance or deflection
- Storytelling flow vs terse Q&A responses
- Signs of fatigue or discomfort
${questionContext}

TRANSCRIPT:
${transcript}`,
  });

  const text = response.text ?? '{}';
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  let aiAssessment = {
    sentiment: 'neutral' as const,
    comfortScore: 50,
    topicEngagement: {} as Record<string, number>,
    flags: [] as string[],
  };

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      aiAssessment = {
        sentiment: parsed.sentiment ?? 'neutral',
        comfortScore: typeof parsed.comfortScore === 'number' ? parsed.comfortScore : 50,
        topicEngagement: parsed.topicEngagement ?? {},
        flags: Array.isArray(parsed.flags) ? parsed.flags : [],
      };
    } catch {
      console.error('[PostSession] Failed to parse engagement JSON');
    }
  }

  return {
    ...basicMetrics,
    ...aiAssessment,
  };
}

// ---------------------------------------------------------------------------
// Question Suggestions (#41)
// ---------------------------------------------------------------------------

/** Suggest new Story Queue questions based on transcript analysis. */
export async function suggestQuestions(
  entries: TranscriptEntry[],
  existingQuestions: InterviewQuestion[],
  dossier: Dossier,
): Promise<SuggestedQuestion[]> {
  const ai = getAI();
  const transcript = formatTranscript(entries);

  const response = await ai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    config: { thinkingConfig: { thinkingLevel: 'high' } },
    contents: `You are an expert oral historian helping plan the next interview session. Based on this transcript, suggest 3-5 new questions for the Story Queue.

Look for:
- People mentioned but never explored ("You mentioned your brother Sam...")
- Events referenced but not elaborated on ("You said there was a fire...")
- Time periods with no coverage (gaps in the life story)
- Interesting threads the storyteller seemed eager to discuss
- Topics the storyteller deflected that might be worth revisiting gently

Do NOT suggest questions that overlap with existing ones.

Existing Story Queue:
${existingQuestions.map(q => `- "${q.text}" (${q.status}: ${q.findings || 'no findings yet'})`).join('\n')}

Storyteller: ${dossier.storytellerName}
Background: ${dossier.storytellerContext || 'Not provided'}
Family: ${JSON.stringify(dossier.familyTree)}

Respond with a JSON array of objects: [{ "text": "the question", "rationale": "why this is a good follow-up" }]

TRANSCRIPT:
${transcript}`,
  });

  const text = response.text ?? '[]';
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed
      .filter((q: any) => q.text && q.rationale)
      .map((q: any) => ({ text: q.text, rationale: q.rationale }));
  } catch {
    console.error('[PostSession] Failed to parse suggestions JSON');
    return [];
  }
}
