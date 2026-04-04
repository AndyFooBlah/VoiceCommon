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
 * CreateFamily — form to create a new family.
 * Creates family doc + admin member doc + updates user.familyIds.
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { createFamily } from '../../hooks/useFamily';

export const CreateFamily: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('The Smith Family');
  const [creating, setCreating] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !user) return;

    setCreating(true);
    try {
      const familyId = await createFamily(
        name.trim(),
        user.uid,
        user.email ?? '',
        user.displayName ?? user.email ?? 'Anonymous',
      );
      // Refresh the ID token so the new familyIds custom claim is included.
      // onMemberWritten sets the claim server-side; getIdToken(true) fetches it.
      await user.getIdToken(true);
      navigate(`/family/${familyId}`, { replace: true });
    } catch (err) {
      console.error('[CreateFamily] Error:', err);
      setCreating(false);
    }
  }

  return (
    <div className="max-w-md mx-auto p-8 mt-20 space-y-8">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-bold text-slate-800">Create a Family</h2>
        <p className="text-slate-400 text-sm">
          Give your family a name. You'll be the first admin.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. The Smith Family"
          autoFocus
          className="w-full p-4 bg-white border border-slate-200 rounded-2xl text-lg outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <button
          type="submit"
          disabled={!name.trim() || creating}
          className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-bold text-lg hover:bg-indigo-700 transition-colors shadow-lg disabled:opacity-50"
        >
          {creating ? 'Creating...' : 'Create Family'}
        </button>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="w-full py-3 text-slate-500 font-medium hover:text-slate-700 transition-colors"
        >
          Back
        </button>
      </form>
    </div>
  );
};
