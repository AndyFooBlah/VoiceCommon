/**
 * FamilyHome — role-based landing page within a family.
 * Admin: shows DossierList
 * Storyteller-only: auto-redirects to their session page
 * Both: shows DossierList (admin view) with storyteller access
 */

import React, { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useCurrentRoles } from '../../hooks/useFamily';
import { useDossierList } from '../../hooks/useDossier';
import { DossierList } from '../dossier/DossierList';

export const FamilyHome: React.FC = () => {
  const { familyId } = useParams<{ familyId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { isAdmin, isStoryteller, loading } = useCurrentRoles(familyId, user?.uid);

  // For storytellers, load their dossier so we can redirect to session
  const { dossiers, loading: dossiersLoading } = useDossierList(
    !isAdmin && isStoryteller ? familyId : undefined,
    user?.uid,
  );

  // Auto-redirect storyteller-only users to their session page
  useEffect(() => {
    if (loading || dossiersLoading || isAdmin || !isStoryteller) return;
    if (dossiers.length > 0) {
      navigate(`/family/${familyId}/dossier/${dossiers[0].id}/session`, { replace: true });
    }
  }, [loading, dossiersLoading, isAdmin, isStoryteller, dossiers, familyId, navigate]);

  if (loading || (!isAdmin && isStoryteller && dossiersLoading)) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  // Admins (even with dual role) see the full admin view
  if (isAdmin) {
    return <DossierList />;
  }

  // Storyteller with no dossier yet
  if (isStoryteller && dossiers.length === 0) {
    return (
      <div className="max-w-md mx-auto p-8 mt-20 text-center space-y-4">
        <h2 className="text-2xl font-bold text-slate-800">Welcome!</h2>
        <p className="text-slate-400">
          Your family admin hasn&apos;t set things up for you yet.
          Check back soon!
        </p>
      </div>
    );
  }

  // Storyteller with dossier — redirect is handled by the effect above,
  // render nothing while navigating
  if (isStoryteller) return null;

  // Not a member — shouldn't happen, but handle gracefully
  return (
    <div className="max-w-md mx-auto p-8 mt-20 text-center space-y-4">
      <h2 className="text-xl font-bold text-slate-800">Access Denied</h2>
      <p className="text-slate-400">You are not a member of this family.</p>
    </div>
  );
};
