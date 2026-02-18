/**
 * TranscriptViewer — read-only view of a past session's transcript.
 * Loads the transcript from Firestore and displays it as a conversation
 * with speaker labels (Storyteller vs Bot) and timestamps.
 */

import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../services/firebase';
import { TranscriptEntry, SessionMetadata, SessionEngagement, SuggestedQuestion } from '../../types';
import { AudioPlayer } from './AudioPlayer';
import { getEngagementAssessment, getSuggestedQuestions } from '../../services/storage';

export const TranscriptViewer: React.FC = () => {
  const { familyId, dossierId, sessionId } = useParams<{
    familyId: string;
    dossierId: string;
    sessionId: string;
  }>();
  const navigate = useNavigate();

  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [session, setSession] = useState<SessionMetadata | null>(null);
  const [engagement, setEngagement] = useState<SessionEngagement | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestedQuestion[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!familyId || !dossierId || !sessionId) return;

    async function loadData() {
      const sessionRef = doc(
        db,
        'families',
        familyId!,
        'dossiers',
        dossierId!,
        'sessions',
        sessionId!,
      );
      const sessionSnap = await getDoc(sessionRef);
      if (sessionSnap.exists()) {
        setSession({ ...sessionSnap.data(), id: sessionSnap.id } as SessionMetadata);
      }

      const transcriptRef = doc(
        db,
        'families',
        familyId!,
        'dossiers',
        dossierId!,
        'sessions',
        sessionId!,
        'transcript',
        'entries',
      );
      const transcriptSnap = await getDoc(transcriptRef);
      if (transcriptSnap.exists()) {
        setEntries(transcriptSnap.data().entries ?? []);
      }

      // Load analysis data (non-blocking)
      getEngagementAssessment(familyId!, dossierId!, sessionId!).then(setEngagement).catch(() => {});
      getSuggestedQuestions(familyId!, dossierId!, sessionId!).then(setSuggestions).catch(() => {});

      setLoading(false);
    }

    loadData();
  }, [familyId, dossierId, sessionId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-8 space-y-6">
      <div>
        <button
          onClick={() => navigate(`/family/${familyId}/dossier/${dossierId}/history`)}
          className="text-sm text-indigo-600 font-medium hover:underline mb-1"
        >
          &larr; Back to Session History
        </button>
        <h2 className="text-2xl font-bold text-slate-800">Session Transcript</h2>
        {session && (
          <p className="text-sm text-slate-400 mt-1">
            {session.startTime?.toDate?.()
              ? session.startTime.toDate().toLocaleDateString(undefined, {
                  weekday: 'long',
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })
              : 'Unknown date'}{' '}
            &middot;{' '}
            <span
              className={`font-semibold ${
                session.status === 'completed' ? 'text-green-600' : 'text-amber-600'
              }`}
            >
              {session.status}
            </span>
          </p>
        )}
      </div>

      {session?.audioUrl && <AudioPlayer audioUrl={session.audioUrl} durationSeconds={session.durationSeconds} />}
      {session && !session.audioUrl && (
        <div className="bg-slate-50 rounded-xl p-4 text-sm text-slate-400 italic text-center">
          Audio not available for this session.
        </div>
      )}

      <div className="bg-white rounded-3xl border border-slate-200 p-8 space-y-6 shadow-sm">
        {entries.length === 0 ? (
          <p className="text-slate-400 italic text-center py-8">
            No transcript entries for this session.
          </p>
        ) : (
          entries.map((entry, idx) => (
            <div
              key={idx}
              className={`flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] px-5 py-3 rounded-3xl text-sm leading-relaxed ${
                  entry.role === 'user'
                    ? 'bg-indigo-600 text-white rounded-br-none'
                    : 'bg-slate-50 text-slate-700 border border-slate-200 rounded-bl-none'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={`text-[9px] font-bold uppercase ${
                      entry.role === 'user' ? 'text-indigo-200' : 'text-slate-400'
                    }`}
                  >
                    {entry.role === 'user' ? 'Storyteller' : 'LegacyBot'}
                  </span>
                  {entry.timestamp?.toDate && (
                    <span
                      className={`text-[9px] opacity-50 ${
                        entry.role === 'user' ? 'text-white' : 'text-slate-400'
                      }`}
                    >
                      {entry.timestamp.toDate().toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  )}
                </div>
                {entry.text}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Engagement Assessment */}
      {engagement && (
        <div className="bg-white rounded-3xl border border-slate-200 p-8 shadow-sm space-y-4">
          <h3 className="text-lg font-bold text-slate-800">Session Analysis</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-50 rounded-xl p-4 text-center">
              <p className="text-3xl font-bold text-indigo-600">{engagement.comfortScore}</p>
              <p className="text-xs text-slate-400 font-medium mt-1">Comfort Score</p>
            </div>
            <div className="bg-slate-50 rounded-xl p-4 text-center">
              <p className="text-3xl font-bold text-indigo-600">{Math.round(engagement.speakingRatio * 100)}%</p>
              <p className="text-xs text-slate-400 font-medium mt-1">Storyteller Speaking</p>
            </div>
            <div className="bg-slate-50 rounded-xl p-4 text-center">
              <p className="text-3xl font-bold text-indigo-600">{Math.round(engagement.avgResponseLength)}</p>
              <p className="text-xs text-slate-400 font-medium mt-1">Avg Words/Response</p>
            </div>
            <div className="bg-slate-50 rounded-xl p-4 text-center">
              <span className={`text-sm font-bold px-3 py-1 rounded-full ${
                engagement.sentiment === 'positive' ? 'bg-green-100 text-green-700'
                  : engagement.sentiment === 'guarded' ? 'bg-amber-100 text-amber-700'
                  : engagement.sentiment === 'distressed' ? 'bg-rose-100 text-rose-700'
                  : 'bg-slate-100 text-slate-700'
              }`}>
                {engagement.sentiment}
              </span>
              <p className="text-xs text-slate-400 font-medium mt-2">Sentiment</p>
            </div>
          </div>
          {engagement.flags.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-semibold text-slate-600">Flags</p>
              <div className="flex flex-wrap gap-2">
                {engagement.flags.map((flag, i) => (
                  <span key={i} className="text-xs bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-3 py-1">
                    {flag}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Suggested Questions */}
      {suggestions.length > 0 && (
        <div className="bg-white rounded-3xl border border-slate-200 p-8 shadow-sm space-y-4">
          <h3 className="text-lg font-bold text-slate-800">Suggested Follow-up Questions</h3>
          <p className="text-sm text-slate-400">Based on this session, consider adding these to the Story Queue:</p>
          <div className="space-y-3">
            {suggestions.map((s, i) => (
              <div key={i} className="bg-slate-50 rounded-xl p-4 space-y-1">
                <p className="font-medium text-slate-800">&ldquo;{s.text}&rdquo;</p>
                <p className="text-sm text-slate-400">{s.rationale}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
