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
 * TranscriptViewer — read-only view of a past session's transcript and audio.
 */

import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../services/firebase';
import { useAuth } from '../../hooks/useAuth';
import { TranscriptEntry, SessionMetadata } from '../../types';
import { AudioPlayer } from './AudioPlayer';
import { getTranscriptEntries, getSession } from '../../services/storage';

export const TranscriptViewer: React.FC = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [session, setSession] = useState<SessionMetadata | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sessionId) return;

    async function load() {
      try {
        const [sessionData, transcriptData] = await Promise.all([
          getSession(sessionId!),
          getTranscriptEntries(sessionId!),
        ]);
        setSession(sessionData);
        setEntries(transcriptData);
      } catch (err) {
        console.error('[TranscriptViewer] load error:', err);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [sessionId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="max-w-3xl mx-auto p-8 text-center">
        <p className="text-slate-400">Session not found.</p>
        <button onClick={() => navigate('/sessions')} className="mt-4 text-indigo-600 font-medium hover:underline">
          &larr; Back to sessions
        </button>
      </div>
    );
  }

  const startDate = session.startTime?.toDate?.();

  return (
    <div className="max-w-3xl mx-auto p-8 space-y-6">
      <div>
        <button
          onClick={() => navigate('/sessions')}
          className="text-sm text-indigo-600 font-medium hover:underline mb-2"
        >
          &larr; Session History
        </button>
        <h2 className="text-2xl font-bold text-slate-800">
          {startDate
            ? startDate.toLocaleDateString(undefined, {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })
            : 'Session Transcript'}
        </h2>
        {startDate && (
          <p className="text-slate-400 text-sm mt-1">
            {startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {session.durationSeconds > 0 &&
              ` · ${Math.floor(session.durationSeconds / 60)}m ${session.durationSeconds % 60}s`}
          </p>
        )}
      </div>

      {/* Audio playback */}
      {session.audioUrl && (
        <AudioPlayer audioUrl={session.audioUrl} durationSeconds={session.durationSeconds} />
      )}

      {/* Transcript */}
      <div className="space-y-4">
        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Transcript</h3>

        {entries.length === 0 ? (
          <p className="text-slate-400 italic">No transcript available for this session.</p>
        ) : (
          entries
            .filter((e) => e.role !== 'tool')
            .map((entry, idx) => (
              <div
                key={idx}
                className={`flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] px-5 py-3 rounded-3xl text-sm leading-relaxed ${
                    entry.role === 'user'
                      ? 'bg-indigo-600 text-white rounded-br-none'
                      : 'bg-white text-slate-700 border border-slate-200 rounded-bl-none shadow-sm'
                  }`}
                >
                  <p className={`text-[9px] font-bold uppercase tracking-wider mb-1 ${
                    entry.role === 'user' ? 'text-indigo-200' : 'text-slate-400'
                  }`}>
                    {entry.role === 'user' ? 'You' : 'Assistant'}
                  </p>
                  {entry.text}
                  {entry.timestamp?.toDate?.() && (
                    <div className={`text-[9px] mt-1.5 opacity-50 ${
                      entry.role === 'user' ? 'text-white' : 'text-slate-400'
                    }`}>
                      {entry.timestamp.toDate().toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                  )}
                </div>
              </div>
            ))
        )}
      </div>

      {/* Tool calls summary */}
      {entries.some((e) => e.role === 'tool') && (
        <div className="space-y-2">
          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Tools Used</h3>
          <div className="flex flex-wrap gap-2">
            {entries
              .filter((e) => e.role === 'tool')
              .map((entry, idx) => (
                <span key={idx} className="px-3 py-1 bg-slate-100 text-slate-500 text-xs rounded-full font-mono">
                  {entry.toolName ?? entry.text}
                </span>
              ))}
          </div>
        </div>
      )}
    </div>
  );
};
