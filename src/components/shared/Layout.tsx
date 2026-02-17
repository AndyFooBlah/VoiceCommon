/**
 * Layout — the app shell with navigation and auth guard.
 *
 * Wraps all routes in a consistent layout:
 *   - Top nav bar with the LegacyBot brand and sign-out button
 *   - Auth guard: if the user is not signed in, renders LoginScreen
 *   - Loading spinner while Firebase auth state is being determined
 *
 * The Storyteller view (live session) intentionally hides the nav bar
 * to provide a distraction-free experience — that's handled by the
 * SessionView component itself.
 *
 * References: design.md §4 | GitHub Issues #2, #19
 */

import React from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { LoginScreen } from '../auth/LoginScreen';

export const Layout: React.FC = () => {
  const { user, loading, signInWithGoogle, signInWithEmail, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Show a simple loading spinner while auth state is being determined
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  // Auth guard: unauthenticated users only see the login screen
  if (!user) {
    return (
      <LoginScreen
        onGoogleSignIn={signInWithGoogle}
        onEmailSignIn={signInWithEmail}
      />
    );
  }

  // Check if we're in a live session — hide nav for distraction-free experience
  const isInSession = location.pathname.includes('/session/');

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Navigation bar — hidden during live sessions */}
      {!isInSession && (
        <nav className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
          >
            <h1 className="text-xl font-bold text-slate-800 tracking-tight font-display">
              LegacyBot
            </h1>
          </button>

          <div className="flex items-center gap-4">
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

      {/* Route content */}
      <Outlet />
    </div>
  );
};
