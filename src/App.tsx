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
 * App — the root component with client-side routing and auth guard.
 *
 * Route structure:
 *   /                                        → FamilySelector (create family or enter invite)
 *   /create-family                           → CreateFamily
 *   /invite?token=...                        → AcceptInvite
 *   /family/:familyId                        → Admin: FamilyPage | Storyteller: StorytellerDashboard
 *   /family/:familyId/storyteller            → StorytellerDashboard (direct link for admin+storyteller)
 *   /family/:familyId/dossier/:dossierId     → Admin: DossierEditor
 *   /family/:familyId/dossier/:dossierId/session    → SessionView (both roles)
 *   /family/:familyId/dossier/:dossierId/history    → SessionList
 *   /family/:familyId/dossier/:dossierId/history/:sessionId → TranscriptViewer
 */

import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/shared/Layout';
import { ErrorBoundary } from './components/shared/ErrorBoundary';
import { FamilySelector } from './components/family/FamilySelector';
import { CreateFamily } from './components/family/CreateFamily';
import { AcceptInvite } from './components/auth/AcceptInvite';
import { DossierEditor } from './components/dossier/DossierEditor';
import { SessionView } from './components/session/SessionView';
import { SessionList } from './components/history/SessionList';
import { TranscriptViewer } from './components/history/TranscriptViewer';
import { EventsTimeline } from './components/history/EventsTimeline';
import { MemoirViewer } from './components/memoir/MemoirViewer';
import { MediaGallery } from './components/media/MediaGallery';
import { StorytellerDashboard } from './components/storyteller/StorytellerDashboard';
import { FamilyHome } from './components/family/FamilyHome';
import { FamilyEventDetail } from './components/family/FamilyEventDetail';

const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<FamilySelector />} />
            <Route path="/create-family" element={<CreateFamily />} />
            <Route path="/invite" element={<AcceptInvite />} />
            <Route path="/family/:familyId" element={<FamilyHome />} />
            <Route path="/family/:familyId/storyteller" element={<StorytellerDashboard />} />
            <Route path="/family/:familyId/events/:eventId" element={<FamilyEventDetail />} />
            <Route path="/family/:familyId/dossier/:dossierId" element={<DossierEditor />} />
            <Route path="/family/:familyId/dossier/:dossierId/session" element={<SessionView />} />
            <Route path="/family/:familyId/dossier/:dossierId/memoir" element={<MemoirViewer />} />
            <Route path="/family/:familyId/dossier/:dossierId/events" element={<EventsTimeline />} />
            <Route path="/family/:familyId/dossier/:dossierId/media" element={<MediaGallery />} />
            <Route path="/family/:familyId/dossier/:dossierId/history" element={<SessionList />} />
            <Route path="/family/:familyId/dossier/:dossierId/history/:sessionId" element={<TranscriptViewer />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
};

export default App;
