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
 * MemoirViewer — displays a generated memoir with chapters and citations.
 * Admins can view, edit status, and regenerate. Storytellers can read only.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useDossier } from '../../hooks/useDossier';
import { Memoir } from '../../types';
import {
  getMemoirs,
  createMemoir,
  updateMemoir,
  getEvents,
  getAllSessionTranscripts,
} from '../../services/storage';
import { generateFullMemoir } from '../../services/memoirGeneration';
import { exportMemoirAsPdf } from '../../services/memoirExport';

export const MemoirViewer: React.FC = () => {
  const { familyId, dossierId } = useParams<{ familyId: string; dossierId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { dossier, questions } = useDossier(familyId, dossierId);

  const [memoirs, setMemoirs] = useState<Memoir[]>([]);
  const [activeMemoirId, setActiveMemoirId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [activeChapter, setActiveChapter] = useState(0);

  useEffect(() => {
    if (!familyId || !dossierId) return;
    getMemoirs(familyId, dossierId)
      .then((m) => {
        setMemoirs(m);
        if (m.length > 0) setActiveMemoirId(m[0].id ?? null);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [familyId, dossierId]);

  const activeMemoir = memoirs.find((m) => m.id === activeMemoirId);

  const handleGenerate = useCallback(async () => {
    if (!familyId || !dossierId || !dossier || !user) return;
    setGenerating(true);
    try {
      // Create placeholder memoir doc
      const memoirId = await createMemoir(familyId, dossierId, {
        title: `The Story of ${dossier.storytellerName}`,
        status: 'generating',
        generatedBy: user.uid,
        chapters: [],
      });

      // Gather all material
      const [events, sessions] = await Promise.all([
        getEvents(familyId, dossierId),
        getAllSessionTranscripts(familyId, dossierId),
      ]);

      // Generate memoir
      const result = await generateFullMemoir({
        dossier,
        questions,
        events,
        sessions,
      });

      // Update with generated content
      await updateMemoir(familyId, dossierId, memoirId, {
        title: result.title,
        chapters: result.chapters,
        status: 'draft',
      });

      // Refresh the list
      const updated = await getMemoirs(familyId, dossierId);
      setMemoirs(updated);
      setActiveMemoirId(memoirId);
      setActiveChapter(0);
    } catch (err) {
      console.error('[Memoir] Generation error:', err);
      alert('Memoir generation failed. Please try again.');
    } finally {
      setGenerating(false);
    }
  }, [familyId, dossierId, dossier, questions, user]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <button
            onClick={() => navigate(`/family/${familyId}/dossier/${dossierId}`)}
            className="text-sm text-indigo-600 font-medium hover:underline mb-1"
          >
            &larr; Back to Dossier
          </button>
          <h2 className="text-2xl font-bold text-slate-800">
            {activeMemoir?.title ?? 'Memoir'}
          </h2>
          {activeMemoir && (
            <div className="flex items-center gap-3 mt-1">
              <span className="text-sm text-slate-400">Status:</span>
              <select
                value={activeMemoir.status}
                onChange={async (e) => {
                  if (!familyId || !dossierId || !activeMemoir.id) return;
                  const newStatus = e.target.value as Memoir['status'];
                  await updateMemoir(familyId, dossierId, activeMemoir.id, { status: newStatus });
                  setMemoirs((prev) => prev.map((m) =>
                    m.id === activeMemoir.id ? { ...m, status: newStatus } : m
                  ));
                }}
                className={`text-sm font-semibold rounded-full px-3 py-1 border-0 cursor-pointer ${
                  activeMemoir.status === 'published' ? 'bg-green-100 text-green-700'
                    : activeMemoir.status === 'review' ? 'bg-amber-100 text-amber-700'
                    : activeMemoir.status === 'generating' ? 'bg-slate-100 text-slate-500'
                    : 'bg-indigo-100 text-indigo-700'
                }`}
                disabled={activeMemoir.status === 'generating'}
              >
                <option value="draft">Draft</option>
                <option value="review">Review</option>
                <option value="published">Published</option>
              </select>
            </div>
          )}
        </div>
        <div className="flex gap-3">
          {activeMemoir && activeMemoir.chapters.length > 0 && (
            <button
              onClick={() => exportMemoirAsPdf(activeMemoir, dossier?.storytellerName ?? 'Storyteller')}
              className="px-5 py-2.5 bg-white border border-slate-200 text-slate-700 rounded-xl font-semibold hover:bg-slate-50 transition-colors"
            >
              Export PDF
            </button>
          )}
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="px-5 py-2.5 bg-indigo-600 text-white rounded-xl font-semibold hover:bg-indigo-700 transition-colors shadow-lg disabled:opacity-50"
          >
            {generating ? 'Generating...' : memoirs.length === 0 ? 'Generate Memoir' : 'Regenerate Memoir'}
          </button>
        </div>
      </div>

      {generating && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-center space-y-3">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-600 mx-auto" />
          <p className="text-amber-700 font-medium">
            Generating memoir from interview transcripts...
          </p>
          <p className="text-sm text-amber-600">
            This may take a few minutes depending on the number of sessions.
          </p>
        </div>
      )}

      {activeMemoir && activeMemoir.chapters.length > 0 && (
        <div className="flex gap-6">
          {/* Chapter navigation */}
          <div className="w-64 shrink-0 space-y-2">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">
              Chapters
            </p>
            {activeMemoir.chapters.map((chapter, i) => (
              <button
                key={i}
                onClick={() => setActiveChapter(i)}
                className={`w-full text-left px-4 py-3 rounded-xl text-sm transition-colors ${
                  activeChapter === i
                    ? 'bg-indigo-600 text-white font-semibold'
                    : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
                }`}
              >
                {chapter.title}
              </button>
            ))}
          </div>

          {/* Chapter content */}
          <div className="flex-1 bg-white rounded-3xl border border-slate-200 p-10 shadow-sm">
            <h3 className="text-2xl font-bold text-slate-800 mb-6 font-display">
              {activeMemoir.chapters[activeChapter]?.title}
            </h3>
            <div className="prose prose-slate max-w-none text-slate-700 leading-relaxed whitespace-pre-wrap">
              {activeMemoir.chapters[activeChapter]?.content}
            </div>
            {activeMemoir.chapters[activeChapter]?.citations.length > 0 && (
              <div className="mt-8 pt-6 border-t border-slate-200">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">
                  Source Citations
                </p>
                <div className="space-y-2">
                  {activeMemoir.chapters[activeChapter].citations.map((c, i) => (
                    <div key={i} className="text-xs text-slate-500 bg-slate-50 rounded-lg p-3">
                      <span className="font-medium text-slate-600">[{i + 1}]</span>{' '}
                      &ldquo;{c.quote.slice(0, 150)}...&rdquo;{' '}
                      <button
                        onClick={() => navigate(
                          `/family/${familyId}/dossier/${dossierId}/history/${c.sessionId}`
                        )}
                        className="text-indigo-600 hover:underline"
                      >
                        View session
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {!activeMemoir && !generating && (
        <div className="text-center py-16 space-y-4">
          <p className="text-slate-400 text-lg">
            No memoir has been generated yet.
          </p>
          <p className="text-sm text-slate-400">
            Complete some interview sessions first, then click &ldquo;Generate Memoir&rdquo; above.
          </p>
        </div>
      )}
    </div>
  );
};
