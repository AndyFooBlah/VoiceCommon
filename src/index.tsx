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
 * Application entry point.
 * Mounts the React app to the #root DOM element.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { initializeVoiceCommon } from './services/config';

initializeVoiceCommon({
  firebase: {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  },
  // The demo app does NOT carry a Gemini key — VoiceCommon never accepts
  // long-lived keys in browser config. To run the demo end-to-end against
  // Gemini Live, point this at your own broker: an authenticated HTTPS
  // endpoint (e.g. a Firebase callable Cloud Function) that holds
  // GEMINI_API_KEY server-side (Secret Manager), calls Gemini's
  // authTokens.create API, and returns a single-use ephemeral token as
  // { token: string, expireTime: string }. See design.md §5 for the full
  // broker contract.
  tokenProvider: () => {
    throw new Error(
      'VoiceCommon demo: no tokenProvider wired up. To run the demo against ' +
        'Gemini Live, replace this with a call to your own server-side ' +
        'mintGeminiLiveToken Cloud Function. See design.md §5.',
    );
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Could not find root element to mount to');
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
