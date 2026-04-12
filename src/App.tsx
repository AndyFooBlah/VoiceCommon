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
 * App — root component with client-side routing and auth guard.
 *
 * Route structure:
 *   /                       → Redirect to /sessions
 *   /sessions               → SessionList (session history)
 *   /sessions/new           → SessionView (live voice session)
 *   /sessions/:sessionId    → TranscriptViewer (past session detail)
 */

import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/shared/Layout';
import { ErrorBoundary } from './components/shared/ErrorBoundary';
import { SessionList } from './components/history/SessionList';
import { SessionView } from './components/session/SessionView';
import { TranscriptViewer } from './components/history/TranscriptViewer';

const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/sessions" replace />} />
          {/* Session view has its own full-screen layout */}
          <Route path="/sessions/new" element={<SessionView />} />
          {/* All other routes use the standard Layout with nav */}
          <Route element={<Layout />}>
            <Route path="/sessions" element={<SessionList />} />
            <Route path="/sessions/:sessionId" element={<TranscriptViewer />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
};

export default App;
