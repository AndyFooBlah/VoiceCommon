/**
 * FamilyHome — role-based landing page within a family.
 * Admin: shows FamilyPage (unified member management + storytellers)
 * Storyteller-only: shows StorytellerDashboard (history + start session)
 * Both: shows FamilyPage (admin view)
 */

import React from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useCurrentRoles } from '../../hooks/useFamily';
import { FamilyPage } from './FamilyPage';
import { StorytellerDashboard } from '../storyteller/StorytellerDashboard';

export const FamilyHome: React.FC = () => {
  const { familyId } = useParams<{ familyId: string }>();
  const { user } = useAuth();
  const { isAdmin, isStoryteller, loading } = useCurrentRoles(familyId, user?.uid);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  // Admins (even with dual role) see the full admin view
  if (isAdmin) {
    return <FamilyPage />;
  }

  // Storyteller-only: show their dashboard with history + start session
  if (isStoryteller) {
    return <StorytellerDashboard />;
  }

  // Not a member — shouldn't happen, but handle gracefully
  return (
    <div className="max-w-md mx-auto p-8 mt-20 text-center space-y-4">
      <h2 className="text-xl font-bold text-slate-800">Access Denied</h2>
      <p className="text-slate-400">You are not a member of this family.</p>
    </div>
  );
};
