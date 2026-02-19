/**
 * StorytellerDashboard — simplified view for storytellers.
 * Shows a welcome message with direct actions to start a session or view history.
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
          Your family admin hasn't set things up for you yet.
          Check back soon!
        </p>
      </div>
    );
  }

  // Storytellers typically have one dossier — show it prominently
  const dossier = dossiers[0];

  return (
    <div className="max-w-lg mx-auto p-8 mt-8 space-y-8">
      <div className="text-center space-y-3">
        <h2 className="text-3xl font-bold text-slate-800 tracking-tight">
          Welcome, {dossier.storytellerName}
        </h2>
        <p className="text-slate-400">
          Ready to share more of your story?
        </p>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200 p-8 shadow-sm space-y-6">
        <button
          onClick={() => navigate(`/family/${familyId}/dossier/${dossier.id}/session`)}
          className="w-full py-5 bg-indigo-600 text-white rounded-2xl font-bold text-lg hover:bg-indigo-700 transition-colors shadow-lg"
        >
          Start Interview Session
        </button>

        <button
          onClick={() => navigate(`/family/${familyId}/dossier/${dossier.id}/history`)}
          className="w-full py-4 bg-white border border-slate-200 text-slate-600 rounded-2xl font-semibold hover:bg-slate-50 transition-colors"
        >
          View Past Sessions
        </button>
      </div>

      {/* Show additional dossiers if there are more than one */}
      {dossiers.length > 1 && (
        <div className="space-y-3">
          <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">
            Other Profiles
          </p>
          {dossiers.slice(1).map((d) => (
            <div
              key={d.id}
              className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm"
            >
              <h3 className="font-semibold text-slate-800 mb-3">{d.storytellerName}</h3>
              <div className="flex gap-3">
                <button
                  onClick={() => navigate(`/family/${familyId}/dossier/${d.id}/session`)}
                  className="flex-1 py-3 bg-indigo-600 text-white rounded-xl font-semibold hover:bg-indigo-700 transition-colors"
                >
                  Start Session
                </button>
                <button
                  onClick={() => navigate(`/family/${familyId}/dossier/${d.id}/history`)}
                  className="px-5 py-3 bg-white border border-slate-200 text-slate-600 rounded-xl font-semibold hover:bg-slate-50 transition-colors"
                >
                  History
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
