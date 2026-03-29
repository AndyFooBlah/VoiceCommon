/**
 * Layout — the app shell with navigation and auth guard.
 * Extended with family context and role-based navigation.
 *   - Admin nav shows: Family, Sign Out
 *   - Storyteller nav shows: Sign Out
 *   - Hidden during live sessions for distraction-free experience
 */

import React, { useRef, useEffect } from 'react';
import { Outlet, useNavigate, useLocation, useParams } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useCurrentRoles } from '../../hooks/useFamily';
import { LoginScreen } from '../auth/LoginScreen';
import { Logo } from './Logo';

export const Layout: React.FC = () => {
  const { user, loading, signInWithGoogle, signInWithEmail, signUpWithEmail, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Redirect to / on sign-in so FamilySelector always handles post-login routing.
  // Without this, a user who opens a bookmarked URL (e.g. a session page) would land
  // directly on that page after login instead of the role-appropriate home screen.
  const showedLoginRef = useRef(false);
  useEffect(() => {
    if (!loading && !user) showedLoginRef.current = true;
  }, [loading, user]);
  useEffect(() => {
    if (!loading && user && showedLoginRef.current) {
      showedLoginRef.current = false;
      // Preserve the invite flow so invite links survive the login step.
      if (!location.pathname.startsWith('/invite')) {
        navigate('/', { replace: true });
      }
    }
  }, [loading, user, navigate, location.pathname]);

  // Extract familyId from URL if present
  const familyIdMatch = location.pathname.match(/^\/family\/([^/]+)/);
  const familyId = familyIdMatch?.[1];

  const { isAdmin, loading: rolesLoading } = useCurrentRoles(familyId, user?.uid);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  if (!user) {
    // Extract invite email from URL if on the invite page
    const inviteEmail = location.pathname === '/invite'
      ? new URLSearchParams(location.search).get('email') ?? undefined
      : undefined;

    return (
      <LoginScreen
        onGoogleSignIn={signInWithGoogle}
        onEmailSignIn={signInWithEmail}
        onEmailSignUp={signUpWithEmail}
        inviteEmail={inviteEmail}
      />
    );
  }

  const isInSession = location.pathname.includes('/session');

  return (
    <div className="min-h-screen bg-slate-50">
      {!isInSession && (
        <nav className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between">
          <button
            onClick={() => familyId ? navigate(`/family/${familyId}`) : navigate('/')}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
          >
            <Logo size={28} />
            <h1 className="text-xl font-bold text-slate-800 tracking-tight font-display">
              LegacyBot
            </h1>
          </button>

          <div className="flex items-center gap-4">
            {familyId && isAdmin && (
              <button
                onClick={() => navigate(`/family/${familyId}`)}
                className="text-sm text-slate-500 hover:text-slate-700 font-medium transition-colors"
              >
                Family
              </button>
            )}
            <span className="text-sm text-slate-500">
              {user.displayName ?? user.email}
            </span>
            <button
              onClick={signOut}
              className="text-sm text-slate-400 hover:text-slate-600 font-medium transition-colors"
            >
              Sign Out
            </button>
          </div>
        </nav>
      )}

      <Outlet />
    </div>
  );
};
