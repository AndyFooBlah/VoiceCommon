/**
 * SessionList — browse past recording sessions for a Storyteller.
 *
 * Displays all sessions for a given Dossier, sorted newest-first.
 * Each session card shows:
 *   - Date and time
 *   - Duration
 *   - Status badge (completed / interrupted)
 *
 * Clicking a session navigates to the TranscriptViewer for that session.
 *
 * References: product_requirements.md §3.6 | GitHub Issue #13
 */

import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore';
import { db } from '../../services/firebase';
import { useAuth } from '../../hooks/useAuth';
import { SessionMetadata } from '../../types';

export const SessionList: React.FC = () => {
  const { dossierId } = useParams<{ dossierId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.uid || !dossierId) return;

    const colRef = collection(
      db,
      'users',
      user.uid,
      'dossiers',
      dossierId,
      'sessions',
    );
    const q = query(colRef, orderBy('startTime', 'desc'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const items = snapshot.docs.map((doc) => ({
        ...doc.data(),
        id: doc.id,
      })) as SessionMetadata[];
      setSessions(items);
      setLoading(false);
    });

    return unsubscribe;
  }, [user?.uid, dossierId]);

  /** Format a duration in seconds to a human-readable string. */
  function formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins === 0) return `${secs}s`;
    return `${mins}m ${secs}s`;
  }

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
          onClick={() => navigate(`/dossier/${dossierId}`)}
          className="text-sm text-indigo-600 font-medium hover:underline mb-1"
        >
          &larr; Back to Dossier
        </button>
        <h2 className="text-2xl font-bold text-slate-800">Session History</h2>
      </div>

      {sessions.length === 0 ? (
        <div className="text-center py-16 space-y-3">
          <p className="text-slate-400 text-lg">No sessions recorded yet.</p>
          <button
            onClick={() => navigate(`/dossier/${dossierId}/session`)}
            className="text-indigo-600 font-semibold hover:underline"
          >
            Start the first session &rarr;
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {sessions.map((session) => (
            <div
              key={session.id}
              onClick={() =>
                navigate(`/dossier/${dossierId}/history/${session.id}`)
              }
              className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition-shadow cursor-pointer flex items-center justify-between"
            >
              <div className="space-y-1">
                <p className="font-semibold text-slate-800">
                  {session.startTime?.toDate?.()
                    ? session.startTime.toDate().toLocaleDateString(undefined, {
                        weekday: 'long',
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                      })
                    : 'Unknown date'}
                </p>
                <p className="text-sm text-slate-400">
                  {session.startTime?.toDate?.()
                    ? session.startTime.toDate().toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : ''}{' '}
                  &middot; {formatDuration(session.durationSeconds)}
                </p>
              </div>

              {/* Status badge */}
              <span
                className={`text-xs font-bold px-3 py-1 rounded-full uppercase ${
                  session.status === 'completed'
                    ? 'bg-green-100 text-green-600'
                    : session.status === 'interrupted'
                      ? 'bg-amber-100 text-amber-600'
                      : 'bg-blue-100 text-blue-600'
                }`}
              >
                {session.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
