/**
 * TranscriptViewer — read-only view of a past session's transcript.
 *
 * Loads the transcript from Firestore and displays it as a conversation
 * with speaker labels (Storyteller vs Bot) and timestamps. Styled
 * similarly to the live transcript feed but clearly marked as a
 * past recording.
 *
 * Includes the AudioPlayer component for playback of the session's
 * archived audio alongside the transcript.
 *
 * References: product_requirements.md §3.6 | GitHub Issue #14
 */

import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../services/firebase';
import { useAuth } from '../../hooks/useAuth';
import { TranscriptEntry, SessionMetadata } from '../../types';
import { AudioPlayer } from './AudioPlayer';

export const TranscriptViewer: React.FC = () => {
  const { dossierId, sessionId } = useParams<{
    dossierId: string;
    sessionId: string;
  }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [session, setSession] = useState<SessionMetadata | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.uid || !dossierId || !sessionId) return;

    async function loadData() {
      // Load session metadata (for audio URL and date)
      const sessionRef = doc(
        db,
        'users',
        user!.uid,
        'dossiers',
        dossierId!,
        'sessions',
        sessionId!,
      );
      const sessionSnap = await getDoc(sessionRef);
      if (sessionSnap.exists()) {
        setSession({ ...sessionSnap.data(), id: sessionSnap.id } as SessionMetadata);
      }

      // Load transcript entries
      const transcriptRef = doc(
        db,
        'users',
        user!.uid,
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

      setLoading(false);
    }

    loadData();
  }, [user?.uid, dossierId, sessionId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-8 space-y-6">
      {/* Header */}
      <div>
        <button
          onClick={() => navigate(`/dossier/${dossierId}/history`)}
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

      {/* Audio Player */}
      {session?.audioUrl && <AudioPlayer audioUrl={session.audioUrl} />}
      {session && !session.audioUrl && (
        <div className="bg-slate-50 rounded-xl p-4 text-sm text-slate-400 italic text-center">
          Audio not available for this session.
        </div>
      )}

      {/* Transcript entries */}
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
    </div>
  );
};
