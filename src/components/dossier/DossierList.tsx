/**
 * DossierList — the Archivist's landing page after login.
 *
 * Displays all Dossiers owned by the current user as cards. Each card
 * shows the Storyteller's name and provides navigation to the Dossier
 * editor / session view. The Archivist can also create new Dossiers
 * and delete existing ones (with confirmation).
 *
 * This is the primary entry point for multi-Storyteller support —
 * an Archivist working with multiple family members selects which
 * Storyteller to interview from this screen.
 *
 * References: product_requirements.md §3.5 | GitHub Issue #4
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useDossierList } from '../../hooks/useDossier';

export const DossierList: React.FC = () => {
  const { user } = useAuth();
  const { dossiers, loading, createDossier, deleteDossier } = useDossierList(user?.uid);
  const navigate = useNavigate();

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  async function handleCreate() {
    if (!newName.trim()) return;
    const id = await createDossier(newName.trim());
    setNewName('');
    setShowCreateForm(false);
    navigate(`/dossier/${id}`);
  }

  async function handleDelete(dossierId: string) {
    await deleteDossier(dossierId);
    setDeleteConfirmId(null);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold text-slate-800 tracking-tight">
            Your Storytellers
          </h2>
          <p className="text-slate-400 mt-1">
            Select a Storyteller to begin or review their oral history.
          </p>
        </div>
        <button
          onClick={() => setShowCreateForm(true)}
          className="px-5 py-2.5 bg-indigo-600 text-white rounded-xl font-semibold hover:bg-indigo-700 transition-colors shadow-lg"
        >
          + New Storyteller
        </button>
      </div>

      {/* Create form (inline) */}
      {showCreateForm && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-4">
          <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider">
            Storyteller&apos;s Name (required)
          </label>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Grandma Margaret"
            autoFocus
            className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500"
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <div className="flex gap-3">
            <button
              onClick={handleCreate}
              disabled={!newName.trim()}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg font-semibold text-sm disabled:opacity-50 hover:bg-indigo-700 transition-colors"
            >
              Create
            </button>
            <button
              onClick={() => {
                setShowCreateForm(false);
                setNewName('');
              }}
              className="px-4 py-2 text-slate-500 hover:text-slate-700 text-sm font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Dossier cards */}
      {dossiers.length === 0 && !showCreateForm ? (
        <div className="text-center py-20 space-y-4">
          <div className="text-6xl opacity-30">📖</div>
          <h3 className="text-xl font-semibold text-slate-500">
            No Storytellers yet
          </h3>
          <p className="text-slate-400 max-w-md mx-auto">
            Create a new Storyteller to set up their Dossier — family tree,
            questions, and personality — then start recording their stories.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {dossiers.map((d) => (
            <div
              key={d.id}
              className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm hover:shadow-md transition-shadow group relative"
            >
              {/* Delete confirmation overlay */}
              {deleteConfirmId === d.id && (
                <div className="absolute inset-0 bg-white/95 rounded-2xl flex flex-col items-center justify-center gap-3 z-10">
                  <p className="text-sm font-semibold text-slate-700">
                    Delete {d.storytellerName}&apos;s Dossier?
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleDelete(d.id!)}
                      className="px-4 py-1.5 bg-red-500 text-white text-sm rounded-lg font-semibold"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setDeleteConfirmId(null)}
                      className="px-4 py-1.5 text-slate-500 text-sm font-medium"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div
                className="cursor-pointer"
                onClick={() => navigate(`/dossier/${d.id}`)}
              >
                <h3 className="text-lg font-bold text-slate-800">
                  {d.storytellerName}
                </h3>
                {d.storytellerContext && (
                  <p className="text-sm text-slate-400 mt-1 line-clamp-2">
                    {d.storytellerContext}
                  </p>
                )}
                <div className="flex items-center gap-3 mt-4">
                  <span className="text-xs text-slate-400 bg-slate-50 px-2 py-1 rounded-md">
                    {d.personality}
                  </span>
                  <span className="text-xs text-slate-400 bg-slate-50 px-2 py-1 rounded-md">
                    {d.selectedVoice}
                  </span>
                </div>
              </div>

              {/* Delete button — visible on hover */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteConfirmId(d.id!);
                }}
                className="absolute top-4 right-4 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                title="Delete Dossier"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
