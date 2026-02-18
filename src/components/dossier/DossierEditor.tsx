/**
 * DossierEditor — the Archivist's master console for configuring a Storyteller.
 *
 * This is the full-page editor for a single Dossier. It combines:
 *   - StorytellerProfile (name + context)
 *   - Voice & Personality selection
 *   - Story Queue (question management with status badges)
 *   - Family Tree (relatives list)
 *   - Historical Context (free text)
 *   - Navigation to start a session or view session history
 *
 * All changes are saved to Firestore via the useDossier hook (debounced).
 * The Story Queue supports adding, removing, editing text, and manual
 * status override (Archivist can reset Completed → Unasked to revisit topics).
 *
 * References: design.md §4 | GitHub Issues #4, #5, #6, #7
 */

import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useDossier } from '../../hooks/useDossier';
import { useFamilyInvitations } from '../../hooks/useInvitations';
import { StorytellerProfile } from './StorytellerProfile';
import { PersonalityMode, VoicePreset, FamilyMember } from '../../types';

export const DossierEditor: React.FC = () => {
  const { familyId, dossierId } = useParams<{ familyId: string; dossierId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { createInvite } = useFamilyInvitations(familyId);
  const {
    dossier,
    questions,
    loading,
    updateDossier,
    addQuestion,
    removeQuestion,
    updateQuestion,
  } = useDossier(familyId, dossierId);

  // Invite storyteller state
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  async function handleInviteStoryteller() {
    if (!familyId || !dossierId || !inviteEmail.trim() || !user) return;
    setInviting(true);
    try {
      const inviteId = await createInvite(inviteEmail.trim(), ['storyteller'], [dossierId], user.uid);
      const link = `${window.location.origin}/invite?token=${inviteId}&email=${encodeURIComponent(inviteEmail.trim())}`;
      setInviteLink(link);
    } catch (err: any) {
      console.error('[DossierEditor] Invite error:', err);
      alert(err.message || 'Failed to create invitation');
    } finally {
      setInviting(false);
    }
  }

  if (loading || !dossier) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  /** Update a family member at a given index. */
  function handleFamilyMemberChange(index: number, updates: Partial<FamilyMember>) {
    const updated = [...dossier!.familyTree];
    updated[index] = { ...updated[index], ...updates };
    updateDossier({ familyTree: updated });
  }

  function handleAddFamilyMember() {
    updateDossier({ familyTree: [...dossier!.familyTree, { name: '', relation: '' }] });
  }

  function handleRemoveFamilyMember(index: number) {
    const updated = dossier!.familyTree.filter((_, i) => i !== index);
    updateDossier({ familyTree: updated });
  }

  return (
    <div className="max-w-3xl mx-auto p-8 space-y-8">
      {/* Header with navigation */}
      <div className="flex items-center justify-between">
        <div>
          <button
            onClick={() => navigate(`/family/${familyId}`)}
            className="text-sm text-indigo-600 font-medium hover:underline mb-1"
          >
            &larr; All Storytellers
          </button>
          <h2 className="text-2xl font-bold text-slate-800">
            {dossier.storytellerName || 'New Storyteller'}
          </h2>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => navigate(`/family/${familyId}/dossier/${dossierId}/memoir`)}
            className="px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-semibold hover:bg-slate-50 transition-colors"
          >
            Memoir
          </button>
          <button
            onClick={() => navigate(`/family/${familyId}/dossier/${dossierId}/events`)}
            className="px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-semibold hover:bg-slate-50 transition-colors"
          >
            Events
          </button>
          <button
            onClick={() => navigate(`/family/${familyId}/dossier/${dossierId}/media`)}
            className="px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-semibold hover:bg-slate-50 transition-colors"
          >
            Photos
          </button>
          <button
            onClick={() => navigate(`/family/${familyId}/dossier/${dossierId}/history`)}
            className="px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-semibold hover:bg-slate-50 transition-colors"
          >
            Session History
          </button>
          <button
            onClick={() => navigate(`/family/${familyId}/dossier/${dossierId}/session`)}
            disabled={!dossier.storytellerName.trim()}
            className="px-5 py-2 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-lg disabled:opacity-50"
          >
            Start Session
          </button>
        </div>
      </div>

      {/* Invite storyteller — shown when dossier has no linked user */}
      {!dossier.storytellerUid && (
        inviteLink ? (
          <div className="bg-green-50 rounded-2xl border border-green-200 p-6 space-y-3">
            <p className="font-semibold text-green-700">
              Invite link for {dossier.storytellerName}:
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={inviteLink}
                className="flex-1 p-3 bg-white border border-green-200 rounded-xl text-sm text-slate-700 select-all"
                onClick={(e) => (e.target as HTMLInputElement).select()}
              />
              <button
                onClick={() => navigator.clipboard.writeText(inviteLink)}
                className="px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700 transition-colors"
              >
                Copy
              </button>
            </div>
            <p className="text-xs text-green-600">
              Send this link to {inviteEmail} so they can create an account and start recording.
            </p>
            <button
              onClick={() => { setInviteLink(null); setInviteEmail(''); }}
              className="text-sm text-green-600 font-medium hover:underline"
            >
              Dismiss
            </button>
          </div>
        ) : (
          <div className="bg-amber-50 rounded-2xl border border-amber-200 p-5 space-y-3">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              <p className="font-semibold text-amber-700 text-sm">
                No storyteller linked — invite someone to record as {dossier.storytellerName}
              </p>
            </div>
            <div className="flex gap-2">
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="storyteller@email.com"
                className="flex-1 p-2.5 bg-white border border-amber-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-amber-400"
                onKeyDown={(e) => e.key === 'Enter' && handleInviteStoryteller()}
              />
              <button
                onClick={handleInviteStoryteller}
                disabled={!inviteEmail.trim() || inviting}
                className="px-4 py-2 bg-amber-500 text-white rounded-xl text-sm font-semibold hover:bg-amber-600 transition-colors disabled:opacity-50"
              >
                {inviting ? 'Sending...' : 'Send Invite'}
              </button>
            </div>
          </div>
        )
      )}

      {/* Main editor content */}
      <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8 space-y-8">
        {/* Storyteller Profile */}
        <StorytellerProfile dossier={dossier} onChange={updateDossier} />

        <hr className="border-slate-100" />

        {/* Interviewer Notes (admin instructions for the AI) */}
        <section className="space-y-2">
          <h3 className="font-bold text-slate-700 flex items-center gap-2">
            <svg className="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            Interviewer Notes
          </h3>
          <p className="text-xs text-slate-400">
            Special instructions for the AI interviewer. These are not visible to the storyteller.
          </p>
          <textarea
            value={dossier.interviewerNotes ?? ''}
            onChange={(e) => updateDossier({ interviewerNotes: e.target.value })}
            placeholder="e.g. &quot;Grandma is hard of hearing - speak slowly.&quot; or &quot;Avoid asking about Uncle Joe.&quot; or &quot;Focus on immigration stories.&quot;"
            rows={3}
            className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
          />
        </section>

        <hr className="border-slate-100" />

        {/* Voice & Personality */}
        <section className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              Interview Voice
            </label>
            <select
              value={dossier.selectedVoice}
              onChange={(e) => updateDossier({ selectedVoice: e.target.value as VoicePreset })}
              className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm"
            >
              <option value="Kore">Kore (Warm)</option>
              <option value="Zephyr">Zephyr (Bright)</option>
              <option value="Puck">Puck (Friendly)</option>
              <option value="Charon">Charon (Deep)</option>
              <option value="Fenrir">Fenrir (Steady)</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              Interviewer Style
            </label>
            <select
              value={dossier.personality}
              onChange={(e) => updateDossier({ personality: e.target.value as PersonalityMode })}
              className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm"
            >
              <option value="empathetic">Empathetic Biographer</option>
              <option value="investigative">Oral Historian</option>
              <option value="casual">Close Grandchild</option>
            </select>
          </div>
        </section>

        <hr className="border-slate-100" />

        {/* Story Queue */}
        <section className="space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="font-bold text-slate-700">Story Queue</h3>
            <button
              onClick={() => addQuestion('')}
              className="bg-indigo-600 text-white p-1.5 rounded-full hover:bg-indigo-700 shadow-sm"
              title="Add question"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>

          <div className="space-y-4">
            {questions.length === 0 && (
              <p className="text-sm text-slate-400 italic text-center py-4">
                No questions yet. Add topics you want to explore with {dossier.storytellerName}.
              </p>
            )}
            {questions.map((q) => (
              <div
                key={q.id}
                className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-3 relative group"
              >
                {/* Remove button */}
                <button
                  onClick={() => removeQuestion(q.id!)}
                  className="absolute top-2 right-2 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Remove question"
                >
                  &times;
                </button>

                {/* Status badge + manual override */}
                <div className="flex gap-2 items-center">
                  <span
                    className={`text-[9px] font-bold px-2 py-0.5 rounded-full uppercase ${
                      q.status === 'Completed'
                        ? 'bg-green-100 text-green-600'
                        : q.status === 'InProgress'
                          ? 'bg-amber-100 text-amber-600'
                          : 'bg-slate-200 text-slate-500'
                    }`}
                  >
                    {q.status}
                  </span>
                  <select
                    value={q.status}
                    onChange={(e) => updateQuestion(q.id!, { status: e.target.value as any })}
                    className="bg-transparent text-[9px] text-slate-400 font-bold border-none p-0 outline-none"
                  >
                    <option value="Unasked">Reset to Unasked</option>
                    <option value="InProgress">Mark In Progress</option>
                    <option value="Completed">Mark Completed</option>
                  </select>
                </div>

                {/* Question text */}
                <textarea
                  className="w-full bg-white p-2 border border-slate-200 rounded-xl text-sm outline-none focus:ring-1 focus:ring-indigo-500"
                  placeholder="Story prompt (e.g. Tell me about your first job...)"
                  rows={2}
                  value={q.text}
                  onChange={(e) => updateQuestion(q.id!, { text: e.target.value })}
                />

                {/* AI-generated findings */}
                {q.findings && (
                  <div className="bg-indigo-50/50 p-2 rounded-lg border border-indigo-100/50">
                    <p className="text-[10px] text-indigo-700 italic">
                      Finding: {q.findings}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        <hr className="border-slate-100" />

        {/* Family Tree */}
        <section className="space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="font-bold text-slate-700">Family Tree</h3>
            <button
              onClick={handleAddFamilyMember}
              className="text-xs text-indigo-600 font-bold hover:underline"
            >
              + Add Relative
            </button>
          </div>
          <div className="grid grid-cols-1 gap-2">
            {dossier.familyTree.map((member, idx) => (
              <div key={idx} className="flex gap-2 items-center group">
                <input
                  className="flex-1 p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs"
                  placeholder="Name"
                  value={member.name}
                  onChange={(e) => handleFamilyMemberChange(idx, { name: e.target.value })}
                />
                <input
                  className="w-28 p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs"
                  placeholder="Relation"
                  value={member.relation}
                  onChange={(e) => handleFamilyMemberChange(idx, { relation: e.target.value })}
                />
                <button
                  onClick={() => handleRemoveFamilyMember(idx)}
                  className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity text-lg"
                  title="Remove"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        </section>

        <hr className="border-slate-100" />

        {/* Historical Context */}
        <section className="space-y-2">
          <h3 className="font-bold text-slate-700">Historical Context</h3>
          <textarea
            value={dossier.historicalContext}
            onChange={(e) => updateDossier({ historicalContext: e.target.value })}
            placeholder="General background (e.g. 'Grew up in coastal Maine during the post-war era')"
            rows={3}
            className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
          />
        </section>
      </div>
    </div>
  );
};
