/**
 * StorytellerProfile — editable profile section within the Dossier editor.
 *
 * Contains two fields:
 *   - Storyteller Name (required) — used by the bot to greet them personally
 *   - Storyteller Context (free text) — background info like age, location,
 *     life era, personality notes, etc.
 *
 * The name is validated on blur — it cannot be empty. Changes are propagated
 * to the parent DossierEditor via the onChange callback, which debounces
 * writes to Firestore.
 *
 * References: product_requirements.md §3.3 | GitHub Issue #5
 */

import React from 'react';
import { Dossier } from '../../types';

interface StorytellerProfileProps {
  dossier: Dossier;
  onChange: (updates: Partial<Dossier>) => void;
}

export const StorytellerProfile: React.FC<StorytellerProfileProps> = ({
  dossier,
  onChange,
}) => {
  return (
    <section className="space-y-4">
      <h3 className="font-bold text-slate-700 flex items-center gap-2">
        <svg className="w-5 h-5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
        Storyteller Profile
      </h3>

      <div className="space-y-3">
        {/* Name field (required) */}
        <div>
          <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">
            Name *
          </label>
          <input
            type="text"
            value={dossier.storytellerName}
            onChange={(e) => onChange({ storytellerName: e.target.value })}
            placeholder="e.g. Margaret"
            className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        {/* Free-text context */}
        <div>
          <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">
            Background &amp; Context
          </label>
          <textarea
            value={dossier.storytellerContext}
            onChange={(e) => onChange({ storytellerContext: e.target.value })}
            placeholder="Age, location, personality, key life events... anything to help the interviewer."
            rows={3}
            className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
          />
        </div>
      </div>
    </section>
  );
};
