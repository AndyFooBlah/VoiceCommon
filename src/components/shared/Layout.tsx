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
 * Layout — the app shell with navigation and auth guard.
 *
 * Renders the top navigation bar with the VoiceCommon logo, a link to
 * session history, and a sign-out button. Shows the LoginScreen for
 * unauthenticated users.
 */

import React from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { LoginScreen } from '../auth/LoginScreen';
import { Logo } from './Logo';

export const Layout: React.FC = () => {
  const { user, loading, signInWithGoogle, signInWithEmail, signUpWithEmail, signOut } = useAuth();
  const navigate = useNavigate();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  if (!user) {
    return (
      <LoginScreen
        onGoogleSignIn={signInWithGoogle}
        onEmailSignIn={signInWithEmail}
        onEmailSignUp={signUpWithEmail}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between">
        <button
          onClick={() => navigate('/sessions')}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <Logo size={28} />
          <h1 className="text-xl font-bold text-slate-800 tracking-tight">VoiceCommon</h1>
        </button>

        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/sessions')}
            className="text-sm text-slate-500 hover:text-slate-700 font-medium transition-colors"
          >
            Sessions
          </button>
          <span className="text-sm text-slate-400">
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

      <Outlet />
    </div>
  );
};
