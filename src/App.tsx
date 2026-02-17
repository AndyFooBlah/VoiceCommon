/**
 * App — the root component with client-side routing and auth guard.
 *
 * Route structure:
 *   /                              → DossierList (select a Storyteller)
 *   /dossier/:dossierId            → DossierEditor (configure Dossier)
 *   /dossier/:dossierId/session    → SessionView (live recording)
 *   /dossier/:dossierId/history    → SessionList (browse past sessions)
 *   /dossier/:dossierId/history/:sessionId → TranscriptViewer (review transcript)
 *
 * The Layout component wraps all routes and handles:
 *   - Auth guard (unauthenticated → LoginScreen)
 *   - Navigation bar (hidden during live sessions)
 *
 * References: design.md §4 | GitHub Issue #19
 */

import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/shared/Layout';
import { ErrorBoundary } from './components/shared/ErrorBoundary';
import { DossierList } from './components/dossier/DossierList';
import { DossierEditor } from './components/dossier/DossierEditor';
import { SessionView } from './components/session/SessionView';
import { SessionList } from './components/history/SessionList';
import { TranscriptViewer } from './components/history/TranscriptViewer';

const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<DossierList />} />
            <Route path="/dossier/:dossierId" element={<DossierEditor />} />
            <Route path="/dossier/:dossierId/session" element={<SessionView />} />
            <Route path="/dossier/:dossierId/history" element={<SessionList />} />
            <Route path="/dossier/:dossierId/history/:sessionId" element={<TranscriptViewer />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
};

export default App;
