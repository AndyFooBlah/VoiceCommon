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
 * Cloud Functions for LegacyBot (firebase-functions v2 API).
 *
 * onInvitationCreated:  Triggered on new invitation doc — sends invite email.
 * onMemberWritten:      Triggered on member write — syncs familyIds custom claims.
 * onSessionCompleted:   Triggered when session status → 'completed'.
 *                       Sends admin notification + runs deep gap analysis.
 * sendDailyDigest:      Scheduled hourly — emails storytellers who haven't
 *                       recorded in 2–7 days with upcoming topics.
 * updateMemberEmail:    Callable — update a family member's email (admin only).
 * resetMemberPassword:  Callable — generate a password reset link (admin only).
 * triggerDigestForDossier: Callable — manually send digest email (admin only).
 * generateMemoir:       Callable — generate a memoir via Gemini (admin only).
 *
 * Environment variables (set via functions/.env or Firebase Console):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, APP_URL
 * Secrets (set via firebase functions:secrets:set):
 *   SMTP_PASS, GEMINI_API_KEY
 */

import { defineString, defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import {
  onDocumentCreated,
  onDocumentUpdated,
  onDocumentWritten,
} from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import * as nodemailer from 'nodemailer';
import { runGapAnalysis, saveGapAnalysis, getGapAnalysis } from './analysis';
import { generateMemoirContent } from './memoir';

admin.initializeApp();

const db = admin.firestore();

// Environment parameters
const smtpHost = defineString('SMTP_HOST', { default: '' });
const smtpPort = defineString('SMTP_PORT', { default: '587' });
const smtpUser = defineString('SMTP_USER', { default: '' });
const smtpPass = defineSecret('SMTP_PASS');
const geminiApiKey = defineSecret('GEMINI_API_KEY');
const appUrl = defineString('APP_URL', { default: 'https://your-app.web.app' });

// ---------------------------------------------------------------------------
// Invitation email
// ---------------------------------------------------------------------------

/**
 * Triggered when a new invitation document is created.
 * Sends an invitation email with a link to join the family.
 */
export const onInvitationCreated = onDocumentCreated(
  { document: 'invitations/{inviteId}', secrets: [smtpPass] },
  async (event) => {
    const snapshot = event.data;
    const inviteId = event.params.inviteId;
    const invitation = snapshot?.data();

    if (!invitation) {
      logger.error('No invitation data found');
      return;
    }

    const { email, familyId, roles, invitedBy } = invitation;

    let familyName = 'a family';
    try {
      const familyDoc = await db.collection('families').doc(familyId).get();
      if (familyDoc.exists) familyName = familyDoc.data()?.name ?? familyName;
    } catch (err) {
      logger.warn('Could not look up family name:', err);
    }

    let inviterName = 'A family member';
    try {
      const inviterDoc = await db.collection('users').doc(invitedBy).get();
      if (inviterDoc.exists) inviterName = inviterDoc.data()?.displayName ?? inviterName;
    } catch (err) {
      logger.warn('Could not look up inviter name:', err);
    }

    const inviteUrl = `${appUrl.value()}/invite?token=${inviteId}`;

    if (!smtpHost.value() || !smtpUser.value() || !smtpPass.value()) {
      logger.error('SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS.');
      return;
    }

    const port = parseInt(smtpPort.value(), 10);
    const transporter = nodemailer.createTransport({
      host: smtpHost.value(),
      port,
      secure: port === 465,
      auth: { user: smtpUser.value(), pass: smtpPass.value() },
    });

    const roleText = roles.join(' and ');

    try {
      await transporter.sendMail({
        from: `"LegacyBot" <${smtpUser.value()}>`,
        to: email,
        subject: `${inviterName} invited you to ${familyName} on LegacyBot`,
        html: `
          <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
            <h1 style="font-size: 24px; color: #1e293b;">You're Invited!</h1>
            <p style="color: #64748b; line-height: 1.6;">
              <strong>${inviterName}</strong> has invited you to join
              <strong>${familyName}</strong> on LegacyBot as a <strong>${roleText}</strong>.
            </p>
            <p style="color: #64748b; line-height: 1.6;">
              LegacyBot helps families preserve their stories through AI-guided
              oral history sessions.
            </p>
            <a href="${inviteUrl}"
               style="display: inline-block; margin-top: 16px; padding: 14px 28px;
                      background: #4f46e5; color: white; text-decoration: none;
                      border-radius: 12px; font-weight: bold; font-size: 16px;">
              Accept Invitation
            </a>
            <p style="margin-top: 24px; font-size: 12px; color: #94a3b8;">
              If you didn't expect this email, you can safely ignore it.
            </p>
          </div>
        `,
      });
      logger.info(`Invitation email sent to ${email} for family ${familyId}`);
    } catch (err) {
      logger.error('Failed to send invitation email:', err);
    }
  },
);

// ---------------------------------------------------------------------------
// Custom claims sync
// ---------------------------------------------------------------------------

/**
 * Triggered whenever a member document is created, updated, or deleted.
 * Reads all the user's current family memberships and writes them as a
 * `familyIds` custom claim on their Firebase Auth token.
 */
export const onMemberWritten = onDocumentWritten(
  'families/{familyId}/members/{memberId}',
  async (event) => {
    const uid = event.params.memberId;
    try {
      const userProfileDoc = await db.collection('users').doc(uid).get();
      const familyIds: string[] = userProfileDoc.data()?.familyIds ?? [];
      const userRecord = await admin.auth().getUser(uid);
      await admin.auth().setCustomUserClaims(uid, {
        ...userRecord.customClaims,
        familyIds,
      });
      logger.info(`[Claims] Updated familyIds for ${uid}: [${familyIds.join(', ')}]`);
    } catch (err) {
      logger.error(`[Claims] Failed to update claims for ${uid}:`, err);
    }
  },
);

// ---------------------------------------------------------------------------
// Admin helpers
// ---------------------------------------------------------------------------

async function verifyFamilyAdmin(request: CallableRequest, familyId: string): Promise<void> {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in.');
  }
  const memberDoc = await db
    .collection('families').doc(familyId)
    .collection('members').doc(request.auth.uid)
    .get();
  if (!memberDoc.exists) {
    throw new HttpsError('permission-denied', 'Not a family member.');
  }
  const roles: string[] = memberDoc.data()?.roles ?? [];
  if (!roles.includes('admin')) {
    throw new HttpsError('permission-denied', 'Admin role required.');
  }
}

/**
 * Callable: update a family member's email address (admin only).
 */
export const updateMemberEmail = onCall(async (request: CallableRequest) => {
  const { familyId, targetUid, newEmail } = request.data;
  if (!familyId || !targetUid || !newEmail) {
    throw new HttpsError('invalid-argument', 'familyId, targetUid, and newEmail are required.');
  }
  await verifyFamilyAdmin(request, familyId);
  await admin.auth().updateUser(targetUid, { email: newEmail.toLowerCase() });
  await db.collection('families').doc(familyId).collection('members').doc(targetUid)
    .update({ email: newEmail.toLowerCase() });
  await db.collection('users').doc(targetUid).update({ email: newEmail.toLowerCase() });
  return { success: true };
});

/**
 * Callable: generate a password reset link for a family member (admin only).
 */
export const resetMemberPassword = onCall(async (request: CallableRequest) => {
  const { familyId, targetUid } = request.data;
  if (!familyId || !targetUid) {
    throw new HttpsError('invalid-argument', 'familyId and targetUid are required.');
  }
  await verifyFamilyAdmin(request, familyId);
  const userRecord = await admin.auth().getUser(targetUid);
  if (!userRecord.email) {
    throw new HttpsError('not-found', 'User has no email address.');
  }
  const resetLink = await admin.auth().generatePasswordResetLink(userRecord.email);
  return { resetLink };
});

// ---------------------------------------------------------------------------
// Session completion — admin notification + gap analysis
// ---------------------------------------------------------------------------

function createTransporter(): nodemailer.Transporter | null {
  if (!smtpHost.value() || !smtpUser.value() || !smtpPass.value()) return null;
  const port = parseInt(smtpPort.value(), 10);
  return nodemailer.createTransport({
    host: smtpHost.value(),
    port,
    secure: port === 465,
    auth: { user: smtpUser.value(), pass: smtpPass.value() },
  });
}

/**
 * Triggered when a session document is updated to status 'completed'.
 * Sends admin notification email and runs gap analysis via Gemini.
 */
export const onSessionCompleted = onDocumentUpdated(
  {
    document: 'families/{familyId}/dossiers/{dossierId}/sessions/{sessionId}',
    secrets: [smtpPass, geminiApiKey],
    timeoutSeconds: 300,
    maxInstances: 5,
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();

    if (!before || !after) return;
    if (before.status === 'completed' || after.status !== 'completed') return;

    const { familyId, dossierId, sessionId } = event.params;

    let dossierData: Record<string, any> = {};
    try {
      const dossierDoc = await db
        .collection('families').doc(familyId)
        .collection('dossiers').doc(dossierId)
        .get();
      if (dossierDoc.exists) dossierData = dossierDoc.data() ?? {};
    } catch (err) {
      logger.warn('Could not look up dossier:', err);
    }

    const storytellerName: string = dossierData.storytellerName ?? 'a storyteller';
    const durationMins = Math.round((after.durationSeconds ?? 0) / 60);

    await Promise.allSettled([
      // Admin notification email
      (async () => {
        const membersSnap = await db
          .collection('families').doc(familyId)
          .collection('members')
          .where('roles', 'array-contains', 'admin')
          .get();

        const recipients: string[] = [];
        for (const memberDoc of membersSnap.docs) {
          const mData = memberDoc.data();
          if (mData.notifyOnSessionComplete && mData.email) {
            recipients.push(mData.email);
          }
        }

        if (recipients.length === 0) {
          logger.info('No admins opted in for session notifications');
          return;
        }

        const transporter = createTransporter();
        if (!transporter) {
          logger.error('SMTP not configured — cannot send session notification');
          return;
        }

        const sessionUrl =
          `${appUrl.value()}/family/${familyId}/dossier/${dossierId}/history/${sessionId}`;

        for (const email of recipients) {
          try {
            await transporter.sendMail({
              from: `"LegacyBot" <${smtpUser.value()}>`,
              to: email,
              subject: `${storytellerName} completed a recording session`,
              html: `
                <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
                  <h1 style="font-size: 24px; color: #1e293b;">Session Complete</h1>
                  <p style="color: #64748b; line-height: 1.6;">
                    <strong>${storytellerName}</strong> just completed a
                    ${durationMins}-minute recording session on LegacyBot.
                  </p>
                  <a href="${sessionUrl}"
                     style="display: inline-block; margin-top: 16px; padding: 14px 28px;
                            background: #4f46e5; color: white; text-decoration: none;
                            border-radius: 12px; font-weight: bold; font-size: 16px;">
                    View Transcript
                  </a>
                  <p style="margin-top: 24px; font-size: 12px; color: #94a3b8;">
                    You're receiving this because you opted in to session notifications.
                  </p>
                </div>
              `,
            });
            logger.info(`Session notification sent to ${email}`);
          } catch (err) {
            logger.error(`Failed to send notification to ${email}:`, err);
          }
        }
      })(),

      // Gap analysis
      (async () => {
        const apiKey = geminiApiKey.value();
        if (!apiKey) {
          logger.warn('GEMINI_API_KEY not set — skipping gap analysis');
          return;
        }
        try {
          logger.info(`[GapAnalysis] Starting for dossier ${dossierId} after session ${sessionId}`);
          const result = await runGapAnalysis(
            familyId, dossierId, sessionId,
            {
              storytellerName: dossierData.storytellerName ?? '',
              preferredName: dossierData.preferredName,
              storytellerContext: dossierData.storytellerContext,
              historicalContext: dossierData.historicalContext,
            },
            apiKey,
          );
          await saveGapAnalysis(familyId, dossierId, result);
          logger.info(
            `[GapAnalysis] Complete: ${result.questions.length} suggestions, ` +
            `${result.gaps.timeline.length} timeline gaps, ` +
            `${result.gaps.themes.length} theme gaps`,
          );
        } catch (err) {
          logger.error('[GapAnalysis] Failed:', err);
        }
      })(),
    ]);
  },
);

// ---------------------------------------------------------------------------
// Digest email helpers
// ---------------------------------------------------------------------------

function getLocalHour(timezone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });
    return parseInt(formatter.format(new Date()), 10);
  } catch {
    return -1;
  }
}

interface DigestOptions {
  force?: boolean;
}

async function sendDigestForDossier(
  familyId: string,
  dossierId: string,
  transporter: nodemailer.Transporter,
  options: DigestOptions = {},
): Promise<boolean> {
  const { force = false } = options;
  const now = Date.now();
  const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

  const dossierDoc = await db
    .collection('families').doc(familyId)
    .collection('dossiers').doc(dossierId)
    .get();

  if (!dossierDoc.exists) return false;
  const dossierData = dossierDoc.data()!;

  const storytellerUid: string | null = dossierData.storytellerUid ?? null;
  const preferredName: string = dossierData.preferredName ?? dossierData.storytellerName ?? 'there';

  if (!storytellerUid) return false;

  if (!force) {
    const lastDigestMs: number = dossierData.lastDigestSentAt?.toMillis?.() ?? 0;
    if (now - lastDigestMs < TWO_DAYS_MS) return false;
  }

  const recentSessionSnap = await db
    .collection('families').doc(familyId)
    .collection('dossiers').doc(dossierId)
    .collection('sessions')
    .where('status', '==', 'completed')
    .orderBy('startTime', 'desc')
    .limit(1)
    .get();

  if (recentSessionSnap.empty) return false;

  const lastSessionMs: number =
    recentSessionSnap.docs[0].data().startTime?.toMillis?.() ?? 0;
  const daysSince = (now - lastSessionMs) / (24 * 60 * 60 * 1000);

  if (!force) {
    if (daysSince < 2 || daysSince > 7) return false;

    let storytellerTimezone: string | undefined;
    try {
      const userDoc = await db.collection('users').doc(storytellerUid).get();
      storytellerTimezone = userDoc.data()?.timezone;
    } catch {
      // user doc not found
    }
    if (!storytellerTimezone) storytellerTimezone = 'America/Los_Angeles';
    const localHour = getLocalHour(storytellerTimezone);
    if (localHour !== 7) return false;
  }

  let storytellerEmail: string | undefined;
  try {
    const userRecord = await admin.auth().getUser(storytellerUid);
    storytellerEmail = userRecord.email;
  } catch {
    // user deleted or no email
  }
  if (!storytellerEmail) return false;

  const questionsSnap = await db
    .collection('families').doc(familyId)
    .collection('dossiers').doc(dossierId)
    .collection('questions')
    .where('status', '==', 'Unasked')
    .orderBy('order', 'asc')
    .limit(4)
    .get();

  const allTopics: string[] = questionsSnap.docs.map((d) => d.data().text as string);
  if (allTopics.length === 0) return false;

  const daysText =
    daysSince < 3 ? 'a couple of days' :
    daysSince < 5 ? 'a few days' :
    'about a week';

  const gapAnalysis = await getGapAnalysis(familyId, dossierId);
  const introText = gapAnalysis?.narrativeSummary
    ?? `It's been ${daysText} since we last spoke, and I've been looking forward to our next conversation.`;

  const topicListHtml = allTopics
    .map((t) => `<li style="margin-bottom: 8px; color: #475569; line-height: 1.5;">${t}</li>`)
    .join('');

  const sessionUrl = `${appUrl.value()}/family/${familyId}`;

  await transporter.sendMail({
    from: `"LegacyBot" <${smtpUser.value()}>`,
    to: storytellerEmail,
    subject: `I've been thinking about what to ask you next, ${preferredName}`,
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px;">
        <h1 style="font-size: 22px; color: #1e293b; margin-bottom: 8px;">
          Ready when you are, ${preferredName}
        </h1>
        <p style="color: #64748b; line-height: 1.6;">${introText} Here are a few things I'd love to explore with you:</p>
        <ul style="padding-left: 20px; margin: 16px 0;">
          ${topicListHtml}
        </ul>
        <a href="${sessionUrl}"
           style="display: inline-block; margin-top: 20px; padding: 14px 28px;
                  background: #4f46e5; color: white; text-decoration: none;
                  border-radius: 12px; font-weight: bold; font-size: 16px;">
          Continue My Story
        </a>
        <p style="margin-top: 28px; font-size: 12px; color: #94a3b8; line-height: 1.5;">
          You're receiving this because you have an active story archive on LegacyBot.
          There's no obligation to record — whenever you're ready, I'll be here.
        </p>
      </div>
    `,
  });

  await db
    .collection('families').doc(familyId)
    .collection('dossiers').doc(dossierId)
    .update({ lastDigestSentAt: admin.firestore.Timestamp.now() });

  logger.info(
    `[Digest] Sent to ${storytellerEmail} for dossier ${dossierId}` +
    ` (${allTopics.length} topics, ${daysText} since last session, force=${force})`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Hourly digest sweep
// ---------------------------------------------------------------------------

export const sendDailyDigest = onSchedule(
  { schedule: '0 * * * *', timeZone: 'UTC', secrets: [smtpPass], timeoutSeconds: 540, maxInstances: 2 },
  async (_event) => {
    const transporter = createTransporter();
    if (!transporter) {
      logger.warn('[Digest] SMTP not configured — skipping digest run');
      return;
    }

    const familiesSnap = await db.collection('families').get();
    let sent = 0;

    for (const familyDoc of familiesSnap.docs) {
      const familyId = familyDoc.id;
      const dossiersSnap = await db
        .collection('families').doc(familyId)
        .collection('dossiers')
        .get();

      for (const dossierDoc of dossiersSnap.docs) {
        try {
          const didSend = await sendDigestForDossier(familyId, dossierDoc.id, transporter);
          if (didSend) sent++;
        } catch (err) {
          logger.error(`[Digest] Error for dossier ${dossierDoc.id}:`, err);
        }
      }
    }

    logger.info(`[Digest] Run complete — ${sent} email(s) sent`);
  },
);

// ---------------------------------------------------------------------------
// Manual digest trigger
// ---------------------------------------------------------------------------

export const triggerDigestForDossier = onCall(
  { secrets: [smtpPass, geminiApiKey], timeoutSeconds: 300 },
  async (request: CallableRequest) => {
    const { familyId, dossierId } = request.data as { familyId: string; dossierId: string };
    if (!familyId || !dossierId) {
      throw new HttpsError('invalid-argument', 'familyId and dossierId are required.');
    }

    await verifyFamilyAdmin(request, familyId);

    const transporter = createTransporter();
    if (!transporter) {
      throw new HttpsError('internal', 'SMTP is not configured on this server.');
    }

    const existingGap = await getGapAnalysis(familyId, dossierId);
    if (!existingGap) {
      const apiKey = geminiApiKey.value();
      if (apiKey) {
        try {
          logger.info(`[triggerDigest] No gap analysis found — running now for dossier ${dossierId}`);
          const dossierDoc = await db
            .collection('families').doc(familyId)
            .collection('dossiers').doc(dossierId)
            .get();
          const dossierData = dossierDoc.data() ?? {};
          const result = await runGapAnalysis(
            familyId, dossierId, 'manual-trigger',
            {
              storytellerName: dossierData.storytellerName ?? '',
              preferredName: dossierData.preferredName,
              storytellerContext: dossierData.storytellerContext,
              historicalContext: dossierData.historicalContext,
            },
            apiKey,
          );
          await saveGapAnalysis(familyId, dossierId, result);
          logger.info(`[triggerDigest] Gap analysis complete: ${result.questions.length} questions generated`);
        } catch (err) {
          logger.warn('[triggerDigest] Gap analysis failed — will send without topics:', err);
        }
      }
    }

    const sent = await sendDigestForDossier(familyId, dossierId, transporter, { force: true });
    if (!sent) {
      throw new HttpsError(
        'failed-precondition',
        'Could not send digest — storyteller may have no linked email or no upcoming topics.',
      );
    }
    return { sent: true };
  },
);

// ---------------------------------------------------------------------------
// Memoir generation
// ---------------------------------------------------------------------------

/**
 * Callable: generate a memoir from all interview transcripts and events.
 * Requires admin role. Creates a placeholder doc, runs the two-pass Gemini
 * pipeline server-side, then updates to 'draft' on completion.
 */
export const generateMemoir = onCall(
  { secrets: [geminiApiKey], timeoutSeconds: 540, maxInstances: 3 },
  async (request: CallableRequest) => {
    const { familyId, dossierId } = request.data as { familyId: string; dossierId: string };
    if (!familyId || !dossierId) {
      throw new HttpsError('invalid-argument', 'familyId and dossierId are required.');
    }

    await verifyFamilyAdmin(request, familyId);

    const apiKey = geminiApiKey.value();
    if (!apiKey) {
      throw new HttpsError('internal', 'GEMINI_API_KEY is not configured on this server.');
    }

    const now = admin.firestore.Timestamp.now();
    const memoirRef = await db
      .collection('families').doc(familyId)
      .collection('dossiers').doc(dossierId)
      .collection('memoirs')
      .add({
        title: 'Generating memoir...',
        status: 'generating',
        generatedBy: request.auth!.uid,
        chapters: [],
        createdAt: now,
        updatedAt: now,
      });

    try {
      await generateMemoirContent(familyId, dossierId, memoirRef.id, apiKey);
      logger.info(`[Memoir] Generated for dossier ${dossierId}, doc ${memoirRef.id}`);
    } catch (err) {
      await memoirRef.update({
        status: 'error' as any,
        updatedAt: admin.firestore.Timestamp.now(),
      });
      logger.error(`[Memoir] Generation failed for dossier ${dossierId}:`, err);
      throw new HttpsError('internal', 'Memoir generation failed. Please try again.');
    }

    return { memoirId: memoirRef.id };
  },
);
