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
 * Cloud Functions for VoiceCommon (firebase-functions v2 API).
 *
 * onSessionCompleted: Triggered when a session document transitions to
 *   status 'completed'. Add your own post-session logic here — e.g.
 *   transcript analysis, notifications, or archival processing.
 *
 * Environment variables (set via functions/.env):
 *   APP_URL — base URL of the deployed frontend
 *
 * Secrets (set via firebase functions:secrets:set):
 *   GEMINI_API_KEY — for any server-side Gemini calls
 */

import { defineString, defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';

admin.initializeApp();

const appUrl = defineString('APP_URL', { default: 'https://your-app.web.app' });
const geminiApiKey = defineSecret('GEMINI_API_KEY');

// ---------------------------------------------------------------------------
// Session completion hook
// ---------------------------------------------------------------------------

/**
 * Triggered when a session document is updated to status 'completed'.
 *
 * Add your own post-session processing here. Common uses:
 *   - Run transcript analysis via Gemini
 *   - Send a notification email
 *   - Generate a session summary
 *   - Export the transcript to an external system
 */
export const onSessionCompleted = onDocumentUpdated(
  {
    document: 'sessions/{sessionId}',
    secrets: [geminiApiKey],
    timeoutSeconds: 300,
    maxInstances: 5,
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();

    if (!before || !after) return;
    if (before.status === 'completed' || after.status !== 'completed') return;

    const { sessionId } = event.params;
    const userId: string = after.userId ?? 'unknown';
    const durationSeconds: number = after.durationSeconds ?? 0;

    logger.info(
      `[onSessionCompleted] Session ${sessionId} completed for user ${userId}` +
      ` (${Math.round(durationSeconds / 60)} min)`,
    );

    // TODO: Add post-session processing here.
    // Example: transcript analysis, email notification, summary generation.
    // The transcript is stored at sessions/{sessionId}/transcript/entries.
    // The session audio URL is at after.audioUrl.

    // Reference: appUrl.value() is the frontend base URL if you need to
    // construct deep links for notifications.
    void appUrl;
  },
);
