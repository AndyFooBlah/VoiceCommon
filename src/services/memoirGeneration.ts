/**
 * Memoir generation service for LegacyBot.
 *
 * Synthesizes a storyteller's interview transcripts, extracted events,
 * and Story Queue findings into a cohesive memoir document organized
 * into chapters with citations to source transcripts.
 *
 * Uses Gemini 2.5 Flash (text) for generation.
 * The memoir is written in third person ("Biography style").
 */

import { GoogleGenAI } from '@google/genai';
import {
  TranscriptEntry,
  InterviewQuestion,
  StoryEvent,
  Dossier,
  MemoirChapter,
  ChapterCitation,
} from '../types';

const getAI = () => new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });

interface MemoirSource {
  sessionId: string;
  entries: TranscriptEntry[];
}

export interface GenerateMemoirOptions {
  dossier: Dossier;
  questions: InterviewQuestion[];
  events: StoryEvent[];
  sessions: MemoirSource[];
}

/**
 * Generate chapter outline from available material.
 * Returns an array of chapter titles with brief summaries.
 */
export async function generateOutline(
  options: GenerateMemoirOptions,
): Promise<{ title: string; summary: string; relevantEventIds: string[] }[]> {
  const ai = getAI();
  const { dossier, questions, events, sessions } = options;

  const transcriptSummaries = sessions.map((s, i) => {
    const words = s.entries.map(e => `${e.role === 'user' ? 'Storyteller' : 'Bot'}: ${e.text}`).join('\n');
    return `SESSION ${i + 1} (${s.sessionId}):\n${words.slice(0, 3000)}${words.length > 3000 ? '\n...[truncated]' : ''}`;
  }).join('\n\n');

  const eventSummary = events.map(e =>
    `- ${e.title} (${e.date ?? 'undated'}): ${e.description}`
  ).join('\n');

  const questionFindings = questions
    .filter(q => q.findings)
    .map(q => `- ${q.text}: ${q.findings}`)
    .join('\n');

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: `You are an expert biographer creating a memoir outline for ${dossier.storytellerName}.

Based on the interview transcripts, extracted events, and topic findings below, create a chapter outline for a third-person biography.

GUIDELINES:
- Organize chronologically where possible
- 3-8 chapters depending on material available
- Each chapter should cover a distinct period or theme of their life
- Include a brief summary (2-3 sentences) of what each chapter will cover
- Note which event IDs are relevant to each chapter

STORYTELLER: ${dossier.storytellerName}
BACKGROUND: ${dossier.storytellerContext || 'Not provided'}
HISTORICAL CONTEXT: ${dossier.historicalContext || 'Not provided'}

EXTRACTED EVENTS:
${eventSummary || 'No events extracted yet.'}

TOPIC FINDINGS:
${questionFindings || 'No findings yet.'}

TRANSCRIPTS:
${transcriptSummaries || 'No transcripts available.'}

Respond with a JSON array:
[{ "title": "Chapter Title", "summary": "Brief description of chapter content", "relevantEventIds": ["id1", "id2"] }]`,
  });

  const text = response.text ?? '[]';
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    console.error('[Memoir] Failed to parse outline JSON');
    return [];
  }
}

/**
 * Generate full chapter content with inline citations.
 */
export async function generateChapter(
  chapterTitle: string,
  chapterSummary: string,
  dossier: Dossier,
  events: StoryEvent[],
  sessions: MemoirSource[],
): Promise<{ content: string; citations: ChapterCitation[] }> {
  const ai = getAI();

  // Build transcript context for this chapter
  const allTranscriptText = sessions.map((s, i) => {
    return s.entries.map((e, idx) =>
      `[S${i}:E${idx}] ${e.role === 'user' ? 'Storyteller' : 'Bot'}: ${e.text}`
    ).join('\n');
  }).join('\n\n');

  const eventContext = events.map(e =>
    `- ${e.title} (${e.date ?? 'undated'}): ${e.description}`
  ).join('\n');

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: `You are writing a chapter of a third-person biography about ${dossier.storytellerName}.

CHAPTER: "${chapterTitle}"
CHAPTER FOCUS: ${chapterSummary}

Write 500-1500 words for this chapter. Guidelines:
- Write in third person ("${dossier.storytellerName} remembered...")
- Use a warm, literary but accessible tone
- Weave in direct quotes from the storyteller where impactful (cite using [S#:E#] format)
- Include specific details from the interviews: names, places, dates
- Create smooth narrative transitions between topics
- End the chapter with a thematic closing that connects to the storyteller's character

When quoting the storyteller directly, use the [S#:E#] citation format from the transcript entries. For example: "${dossier.storytellerName} smiled as she recalled, 'We used to play by the creek every summer' [S0:E5]."

RELEVANT EVENTS:
${eventContext || 'None'}

TRANSCRIPTS (with citation markers):
${allTranscriptText.slice(0, 8000)}

Respond with just the chapter text in markdown format.`,
  });

  const content = response.text ?? '';

  // Extract citations from [S#:E#] markers
  const citations: ChapterCitation[] = [];
  const citationRegex = /\[S(\d+):E(\d+)\]/g;
  let match;
  while ((match = citationRegex.exec(content)) !== null) {
    const sessionIdx = parseInt(match[1], 10);
    const entryIdx = parseInt(match[2], 10);
    if (sessionIdx < sessions.length) {
      const session = sessions[sessionIdx];
      const entry = session.entries[entryIdx];
      citations.push({
        sessionId: session.sessionId,
        entryIndex: entryIdx,
        quote: entry?.text?.slice(0, 200) ?? '',
      });
    }
  }

  return { content, citations };
}

/**
 * Generate a complete memoir from all available material.
 * Returns chapter array ready to save to Firestore.
 */
export async function generateFullMemoir(
  options: GenerateMemoirOptions,
): Promise<{ title: string; chapters: MemoirChapter[] }> {
  const { dossier, events, sessions } = options;

  // Step 1: Generate outline
  const outline = await generateOutline(options);
  if (outline.length === 0) {
    return {
      title: `The Story of ${dossier.storytellerName}`,
      chapters: [{
        title: 'Introduction',
        content: `Not enough material has been collected to generate a full memoir for ${dossier.storytellerName}. Continue conducting interview sessions to build the story.`,
        eventIds: [],
        citations: [],
        order: 0,
      }],
    };
  }

  // Step 2: Generate each chapter
  const chapters: MemoirChapter[] = [];
  for (let i = 0; i < outline.length; i++) {
    const chapter = outline[i];
    const relevantEvents = events.filter(e => chapter.relevantEventIds?.includes(e.id ?? ''));
    const { content, citations } = await generateChapter(
      chapter.title,
      chapter.summary,
      dossier,
      relevantEvents.length > 0 ? relevantEvents : events,
      sessions,
    );
    chapters.push({
      title: chapter.title,
      content,
      eventIds: chapter.relevantEventIds ?? [],
      citations,
      order: i,
    });
  }

  return {
    title: `The Story of ${dossier.storytellerName}`,
    chapters,
  };
}
