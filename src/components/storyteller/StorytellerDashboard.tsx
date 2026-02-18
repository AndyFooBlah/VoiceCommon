/**
 * StorytellerDashboard — simplified view for storytellers.
 * Shows their dossier(s), large "Start Session" button, and link to session history.
 */

import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useDossierList } from '../../hooks/useDossier';

export const StorytellerDashboard: React.FC = () => {
  const { familyId } = useParams<{ familyId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { dossiers, loading } = useDossierList(familyId, user?.uid);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  if (dossiers.length === 0) {
    return (
      <div className="max-w-md mx-auto p-8 mt-20 text-center space-y-4">
        <h2 className="text-2xl font-bold text-slate-800">Welcome!</h2>
        <p className="text-slate-400">
          Your family admin hasn't assigned you to a dossier yet.
          Check back soon!
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-8 space-y-8">
      <div className="text-center space-y-2">
        <h2 className="text-3xl font-bold text-slate-800 tracking-tight">
          Your Stories
        </h2>
        <p className="text-slate-400">
          Select a profile to start sharing your memories.
        </p>
      </div>

      <div className="space-y-4">
        {dossiers.map((d) => (
          <div
            key={d.id}
            className="bg-white rounded-3xl border border-slate-200 p-8 shadow-sm space-y-6"
          >
            <div>
              <h3 className="text-xl font-bold text-slate-800">{d.storytellerName}</h3>
              {d.storytellerContext && (
                <p className="text-sm text-slate-400 mt-1">{d.storytellerContext}</p>
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => navigate(`/family/${familyId}/dossier/${d.id}/session`)}
                className="flex-1 py-4 bg-indigo-600 text-white rounded-2xl font-bold text-lg hover:bg-indigo-700 transition-colors shadow-lg"
              >
                Start Session
              </button>
              <button
                onClick={() => navigate(`/family/${familyId}/dossier/${d.id}/history`)}
                className="px-6 py-4 bg-white border border-slate-200 text-slate-600 rounded-2xl font-semibold hover:bg-slate-50 transition-colors"
              >
                History
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
