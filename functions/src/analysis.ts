/**
 * Server-side life-story gap analysis for LegacyBot.
 *
 * Reads all transcripts, events, and questions for a dossier and asks
 * Gemini to identify what is missing from the storyteller's life narrative.
 * Results are written to:
 *   families/{familyId}/dossiers/{dossierId}/analysis/gapAnalysis
 *
 * Triggered by onSessionCompleted (see index.ts).
 * References: GitHub Issues #81, #82
 */

import * as admin from 'firebase-admin';
import { GoogleGenAI } from '@google/genai';

// Lazy getter so we don't call admin.firestore() before initializeApp()
const db = () => admin.firestore();

// ---------------------------------------------------------------------------
// Firestore helpers (Admin SDK versions of the client-side storage functions)
// ---------------------------------------------------------------------------

interface TranscriptEntry {
  role: 'user' | 'bot';
  text: string;
}

interface StoryEvent {
  title: string;
  date: string | null;
  description: string;
  themes: string[];
  people: string[];
  location: string | null;
}

interface InterviewQuestion {
  id: string;
  text: string;
  status: 'Unasked' | 'InProgress' | 'Completed';
  findings: string;
  order: number;
}

export interface GapAnalysisResult {
  questions: Array<{ text: string; rationale: string; priority: 'high' | 'medium' | 'low' }>;
  gaps: {
    timeline: string[];   // e.g. ["childhood (before age 12)", "years 1975–1985"]
    themes: string[];     // e.g. ["career", "friendships outside family"]
    implied: string[];    // e.g. ["brother Sam — mentioned twice, never explored"]
  };
  narrativeSummary: string; // 2–3 sentence plain-English summary for the digest email
  analyzedAt: admin.firestore.Timestamp;
  sessionId: string;
}

async function getAllTranscripts(
  familyId: string,
  dossierId: string,
): Promise<{ sessionId: string; entries: TranscriptEntry[] }[]> {
  const sessionsSnap = await db()
    .collection('families').doc(familyId)
    .collection('dossiers').doc(dossierId)
    .collection('sessions')
    .where('status', '==', 'completed')
    .orderBy('startTime', 'asc')
    .get();

  const results: { sessionId: string; entries: TranscriptEntry[] }[] = [];
  for (const sessionDoc of sessionsSnap.docs) {
    const transcriptDoc = await db()
      .collection('families').doc(familyId)
      .collection('dossiers').doc(dossierId)
      .collection('sessions').doc(sessionDoc.id)
      .collection('transcript').doc('entries')
      .get();
    const entries: TranscriptEntry[] = transcriptDoc.exists
      ? (transcriptDoc.data()?.entries ?? [])
      : [];
    if (entries.length > 0) {
      results.push({ sessionId: sessionDoc.id, entries });
    }
  }
  return results;
}

async function getEvents(familyId: string, dossierId: string): Promise<StoryEvent[]> {
  const snap = await db()
    .collection('families').doc(familyId)
    .collection('dossiers').doc(dossierId)
    .collection('events')
    .orderBy('createdAt', 'asc')
    .get();
  return snap.docs.map((d) => d.data() as StoryEvent);
}

async function getQuestions(familyId: string, dossierId: string): Promise<InterviewQuestion[]> {
  const snap = await db()
    .collection('families').doc(familyId)
    .collection('dossiers').doc(dossierId)
    .collection('questions')
    .orderBy('order', 'asc')
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as InterviewQuestion);
}

// ---------------------------------------------------------------------------
// Gemini gap analysis
// ---------------------------------------------------------------------------

function formatTranscriptBlock(
  sessions: { sessionId: string; entries: TranscriptEntry[] }[],
): string {
  return sessions
    .map((s, i) =>
      `--- Session ${i + 1} ---\n` +
      s.entries
        .map((e) => `${e.role === 'user' ? 'Storyteller' : 'Bot'}: ${e.text}`)
        .join('\n'),
    )
    .join('\n\n');
}

export async function runGapAnalysis(
  familyId: string,
  dossierId: string,
  sessionId: string,
  dossierData: {
    storytellerName: string;
    preferredName?: string;
    storytellerContext?: string;
    historicalContext?: string;
  },
  apiKey: string,
): Promise<GapAnalysisResult> {
  const [allTranscripts, events, questions] = await Promise.all([
    getAllTranscripts(familyId, dossierId),
    getEvents(familyId, dossierId),
    getQuestions(familyId, dossierId),
  ]);

  const name = dossierData.preferredName ?? dossierData.storytellerName;
  const transcriptText = formatTranscriptBlock(allTranscripts);

  const eventsSummary = events.length > 0
    ? events.map((e) => `- ${e.date ?? 'date unknown'}: ${e.title} (themes: ${e.themes.join(', ') || 'none'})`).join('\n')
    : '(no events extracted yet)';

  const questionsSummary = questions.length > 0
    ? questions.map((q) =>
        `- [${q.status}] "${q.text}"${q.findings ? ` → ${q.findings}` : ''}`
      ).join('\n')
    : '(no questions in Story Queue yet)';

  const incompleteCount = questions.filter((q) => q.status !== 'Completed').length;

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `You are an expert oral historian and biographer reviewing the complete interview archive for a storytelling project.

STORYTELLER: ${name}
BACKGROUND: ${dossierData.storytellerContext || 'Not provided'}
HISTORICAL CONTEXT: ${dossierData.historicalContext || 'Not provided'}

YOUR TASK:
Analyze the full transcript archive and identify gaps in ${name}'s life narrative. The goal is to compile memories that span the full story of their life — in terms of BOTH themes and TIMELINE.

EXTRACTED LIFE EVENTS (so far):
${eventsSummary}

STORY QUEUE (interview questions):
${questionsSummary}

INCOMPLETE QUESTIONS REMAINING: ${incompleteCount}

FULL TRANSCRIPT ARCHIVE (${allTranscripts.length} session${allTranscripts.length !== 1 ? 's' : ''}):
${transcriptText || '(no transcripts yet)'}

---

ANALYSIS INSTRUCTIONS:

1. TIMELINE GAPS: Identify decades or life periods that have few or no events. Consider the arc from birth to present: childhood, adolescence, young adulthood (20s), 30s, 40s, 50s, 60s+.

2. THEME GAPS: Identify life themes that are underrepresented. Common themes: childhood home/family, education, first jobs/career, romance and marriage, raising children, friendships, travel/places lived, hardship or loss, joy and celebration, health, faith or values, community involvement, retirement.

3. IMPLIED BUT UNEXPLORED: Find people, places, or events mentioned in passing in the transcripts that were never followed up on (e.g. "my brother Sam" mentioned once, a "difficult year" referenced but not explained, a town name dropped without context).

4. NEW QUESTIONS: ${incompleteCount <= 3
    ? `The Story Queue has only ${incompleteCount} incomplete questions — it needs replenishing. Suggest 5 high-quality new questions.`
    : `Suggest 3–4 new questions that target the most significant gaps not covered by existing questions.`} Focus on specific times and places, not vague themes. Good question: "You mentioned growing up near the river — what was your neighborhood like as a kid?" Bad question: "Tell me about your childhood."

5. NARRATIVE SUMMARY: Write 2–3 sentences (plain English, warm tone) summarizing what you're most curious to learn next — as if you were the interviewer writing a note before the next session. This will be included in a re-engagement email to the storyteller.

Respond with a single JSON object matching this exact structure:
{
  "questions": [
    { "text": "...", "rationale": "...", "priority": "high" | "medium" | "low" }
  ],
  "gaps": {
    "timeline": ["..."],
    "themes": ["..."],
    "implied": ["..."]
  },
  "narrativeSummary": "..."
}`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });

  const text = response.text ?? '{}';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Gap analysis returned no parseable JSON');
  }

  const parsed = JSON.parse(jsonMatch[0]);

  return {
    questions: (parsed.questions ?? []).map((q: any) => ({
      text: String(q.text ?? ''),
      rationale: String(q.rationale ?? ''),
      priority: (['high', 'medium', 'low'].includes(q.priority) ? q.priority : 'medium') as 'high' | 'medium' | 'low',
    })),
    gaps: {
      timeline: Array.isArray(parsed.gaps?.timeline) ? parsed.gaps.timeline : [],
      themes: Array.isArray(parsed.gaps?.themes) ? parsed.gaps.themes : [],
      implied: Array.isArray(parsed.gaps?.implied) ? parsed.gaps.implied : [],
    },
    narrativeSummary: String(parsed.narrativeSummary ?? ''),
    analyzedAt: admin.firestore.Timestamp.now(),
    sessionId,
  };
}

/**
 * Write gap analysis results to Firestore.
 * Path: families/{familyId}/dossiers/{dossierId}/analysis/gapAnalysis
 */
export async function saveGapAnalysis(
  familyId: string,
  dossierId: string,
  result: GapAnalysisResult,
): Promise<void> {
  await db()
    .collection('families').doc(familyId)
    .collection('dossiers').doc(dossierId)
    .collection('analysis').doc('gapAnalysis')
    .set(result);
}

/**
 * Read the current gap analysis for a dossier (used by digest email).
 */
export async function getGapAnalysis(
  familyId: string,
  dossierId: string,
): Promise<GapAnalysisResult | null> {
  const snap = await db()
    .collection('families').doc(familyId)
    .collection('dossiers').doc(dossierId)
    .collection('analysis').doc('gapAnalysis')
    .get();
  return snap.exists ? (snap.data() as GapAnalysisResult) : null;
}
