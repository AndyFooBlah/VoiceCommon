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
 * Cloud Functions for LegacyBot.
 *
 * onInvitationCreated:  Triggered on new invitation doc — sends invite email.
 * onSessionCompleted:   Triggered when session status → 'completed'.
 *                       Sends admin notification + runs deep gap analysis (#81).
 * sendDailyDigest:      Scheduled nightly — emails storytellers who haven't
 *                       recorded in 2–7 days with upcoming topics (#82).
 *
 * Environment variables (set via functions/.env or Firebase Console):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, APP_URL, GEMINI_API_KEY
 */

import * as functions from 'firebase-functions';
import { defineString, defineSecret } from 'firebase-functions/params';
import * as admin from 'firebase-admin';
import * as nodemailer from 'nodemailer';
import { runGapAnalysis, saveGapAnalysis, getGapAnalysis } from './analysis';
import { generateMemoirContent } from './memoir';

admin.initializeApp();

const db = admin.firestore();

// Environment parameters (set via functions/.env or Firebase Console)
const smtpHost = defineString('SMTP_HOST', { default: '' });
const smtpPort = defineString('SMTP_PORT', { default: '587' });
const smtpUser = defineString('SMTP_USER', { default: '' });
const smtpPass = defineSecret('SMTP_PASS');
const geminiApiKey = defineSecret('GEMINI_API_KEY');
const appUrl = defineString('APP_URL', { default: 'https://your-app.web.app' });

/**
 * Triggered when a new document is created in the invitations collection.
 * Sends an invitation email with a link to join the family.
 */
export const onInvitationCreated = functions
  .runWith({ secrets: [smtpPass] })
  .firestore.document('invitations/{inviteId}')
  .onCreate(async (snapshot, context) => {
    const invitation = snapshot.data();
    const inviteId = context.params.inviteId;

    if (!invitation) {
      functions.logger.error('No invitation data found');
      return;
    }

    const { email, familyId, roles, invitedBy } = invitation;

    // Look up the family name
    let familyName = 'a family';
    try {
      const familyDoc = await db.collection('families').doc(familyId).get();
      if (familyDoc.exists) {
        familyName = familyDoc.data()?.name ?? familyName;
      }
    } catch (err) {
      functions.logger.warn('Could not look up family name:', err);
    }

    // Look up who sent the invite
    let inviterName = 'A family member';
    try {
      const inviterDoc = await db.collection('users').doc(invitedBy).get();
      if (inviterDoc.exists) {
        inviterName = inviterDoc.data()?.displayName ?? inviterName;
      }
    } catch (err) {
      functions.logger.warn('Could not look up inviter name:', err);
    }

    // Build the invitation URL
    const inviteUrl = `${appUrl.value()}/invite?token=${inviteId}`;

    // Set up email transport
    if (!smtpHost.value() || !smtpUser.value() || !smtpPass.value()) {
      functions.logger.error(
        'SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS via functions/.env or Firebase secrets.',
      );
      return;
    }

    const port = parseInt(smtpPort.value(), 10);
    const transporter = nodemailer.createTransport({
      host: smtpHost.value(),
      port,
      secure: port === 465,
      auth: {
        user: smtpUser.value(),
        pass: smtpPass.value(),
      },
    });

    const roleText = roles.join(' and ');

    const mailOptions = {
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
    };

    try {
      await transporter.sendMail(mailOptions);
      functions.logger.info(`Invitation email sent to ${email} for family ${familyId}`);
    } catch (err) {
      functions.logger.error('Failed to send invitation email:', err);
    }
  });

// ---------------------------------------------------------------------------
// Custom claims sync — keeps Firebase Auth token in sync with Firestore membership
// so Cloud Storage rules can check familyIds without a Firestore lookup (#87)
// ---------------------------------------------------------------------------

/**
 * Triggered whenever a member document is created, updated, or deleted.
 * Reads all the user's current family memberships from Firestore and writes
 * them as a `familyIds` custom claim on their Firebase Auth token.
 *
 * Storage rules check `request.auth.token.familyIds` to gate file access.
 * The client must call `user.getIdToken(true)` to get a token with fresh claims
 * after joining or leaving a family.
 */
export const onMemberWritten = functions
  .firestore.document('families/{familyId}/members/{memberId}')
  .onWrite(async (_change, context) => {
    const uid = context.params.memberId;

    try {
      // users/{uid}.familyIds is the authoritative list — kept in sync by
      // createFamily() and acceptInvitation() on the client.
      const userProfileDoc = await db.collection('users').doc(uid).get();
      const familyIds: string[] = userProfileDoc.data()?.familyIds ?? [];

      const userRecord = await admin.auth().getUser(uid);
      await admin.auth().setCustomUserClaims(uid, {
        ...userRecord.customClaims,
        familyIds,
      });

      functions.logger.info(`[Claims] Updated familyIds for ${uid}: [${familyIds.join(', ')}]`);
    } catch (err) {
      functions.logger.error(`[Claims] Failed to update claims for ${uid}:`, err);
    }
  });

// ---------------------------------------------------------------------------
// Admin User Management
// ---------------------------------------------------------------------------

/**
 * Helper: verify the caller is a family admin.
 * Throws HttpsError if not authenticated or not an admin.
 */
async function verifyFamilyAdmin(context: functions.https.CallableContext, familyId: string): Promise<void> {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  }
  const memberDoc = await db
    .collection('families')
    .doc(familyId)
    .collection('members')
    .doc(context.auth.uid)
    .get();
  if (!memberDoc.exists) {
    throw new functions.https.HttpsError('permission-denied', 'Not a family member.');
  }
  const roles: string[] = memberDoc.data()?.roles ?? [];
  if (!roles.includes('admin')) {
    throw new functions.https.HttpsError('permission-denied', 'Admin role required.');
  }
}

/**
 * Callable: update a family member's email address.
 * Requires the caller to be a family admin.
 */
export const updateMemberEmail = functions.https.onCall(async (data, context) => {
  const { familyId, targetUid, newEmail } = data;
  if (!familyId || !targetUid || !newEmail) {
    throw new functions.https.HttpsError('invalid-argument', 'familyId, targetUid, and newEmail are required.');
  }

  await verifyFamilyAdmin(context, familyId);

  // Update Firebase Auth email
  await admin.auth().updateUser(targetUid, { email: newEmail.toLowerCase() });

  // Update member doc
  await db
    .collection('families')
    .doc(familyId)
    .collection('members')
    .doc(targetUid)
    .update({ email: newEmail.toLowerCase() });

  // Update user profile doc
  await db.collection('users').doc(targetUid).update({ email: newEmail.toLowerCase() });

  return { success: true };
});

/**
 * Callable: generate a password reset link for a family member.
 * Requires the caller to be a family admin.
 */
export const resetMemberPassword = functions.https.onCall(async (data, context) => {
  const { familyId, targetUid } = data;
  if (!familyId || !targetUid) {
    throw new functions.https.HttpsError('invalid-argument', 'familyId and targetUid are required.');
  }

  await verifyFamilyAdmin(context, familyId);

  // Get the target user's email
  const userRecord = await admin.auth().getUser(targetUid);
  if (!userRecord.email) {
    throw new functions.https.HttpsError('not-found', 'User has no email address.');
  }

  // Generate password reset link
  const resetLink = await admin.auth().generatePasswordResetLink(userRecord.email);

  return { resetLink };
});

// ---------------------------------------------------------------------------
// Session Completion Notification + Gap Analysis (#44, #81)
// ---------------------------------------------------------------------------

/**
 * Helper: create an SMTP transporter (shared between all outbound emails).
 * Returns null if SMTP is not configured.
 */
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
 *
 * Two things happen in parallel:
 *   1. Admin notification email (opted-in admins only).
 *   2. Deep life-story gap analysis via Gemini (#81): reads all transcripts
 *      for this dossier, identifies timeline/theme gaps, and writes 3–5 new
 *      Story Queue question suggestions to analysis/gapAnalysis.
 */
export const onSessionCompleted = functions
  .runWith({ secrets: [smtpPass, geminiApiKey], timeoutSeconds: 300, maxInstances: 5 })
  .firestore.document('families/{familyId}/dossiers/{dossierId}/sessions/{sessionId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();

    // Only trigger on status transition to 'completed'
    if (before.status === 'completed' || after.status !== 'completed') return;

    const { familyId, dossierId, sessionId } = context.params;

    // Look up the dossier
    let dossierData: Record<string, any> = {};
    try {
      const dossierDoc = await db
        .collection('families').doc(familyId)
        .collection('dossiers').doc(dossierId)
        .get();
      if (dossierDoc.exists) dossierData = dossierDoc.data() ?? {};
    } catch (err) {
      functions.logger.warn('Could not look up dossier:', err);
    }

    const storytellerName: string = dossierData.storytellerName ?? 'a storyteller';
    const durationMins = Math.round((after.durationSeconds ?? 0) / 60);

    // Run admin email + gap analysis in parallel
    await Promise.allSettled([
      // --- Admin notification email ---
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
          functions.logger.info('No admins opted in for session notifications');
          return;
        }

        const transporter = createTransporter();
        if (!transporter) {
          functions.logger.error('SMTP not configured — cannot send session notification');
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
            functions.logger.info(`Session notification sent to ${email}`);
          } catch (err) {
            functions.logger.error(`Failed to send notification to ${email}:`, err);
          }
        }
      })(),

      // --- Deep life-story gap analysis (#81) ---
      (async () => {
        const apiKey = geminiApiKey.value();
        if (!apiKey) {
          functions.logger.warn('GEMINI_API_KEY not set — skipping gap analysis');
          return;
        }
        try {
          functions.logger.info(
            `[GapAnalysis] Starting for dossier ${dossierId} after session ${sessionId}`,
          );
          const result = await runGapAnalysis(
            familyId,
            dossierId,
            sessionId,
            {
              storytellerName: dossierData.storytellerName ?? '',
              preferredName: dossierData.preferredName,
              storytellerContext: dossierData.storytellerContext,
              historicalContext: dossierData.historicalContext,
            },
            apiKey,
          );
          await saveGapAnalysis(familyId, dossierId, result);
          functions.logger.info(
            `[GapAnalysis] Complete: ${result.questions.length} suggestions, ` +
            `${result.gaps.timeline.length} timeline gaps, ` +
            `${result.gaps.themes.length} theme gaps`,
          );
        } catch (err) {
          functions.logger.error('[GapAnalysis] Failed:', err);
        }
      })(),
    ]);
  });

// ---------------------------------------------------------------------------
// Digest email helpers (#82, #83, #84)
// ---------------------------------------------------------------------------

/** Return the local hour (0–23) for a given IANA timezone string. */
function getLocalHour(timezone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });
    return parseInt(formatter.format(new Date()), 10);
  } catch {
    return -1; // invalid timezone — caller should skip
  }
}

interface DigestOptions {
  /** When true, bypass day-range and lastDigestSentAt timing checks (manual trigger). */
  force?: boolean;
}

/**
 * Build and send a digest email for a single dossier.
 * Returns true if an email was sent, false if skipped.
 *
 * Timing gates (skipped when force=true):
 *   - Last session must be 2–7 days ago
 *   - No digest sent in the last 2 days (lastDigestSentAt)
 *   - Current local hour in the storyteller's timezone must be 7
 */
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
    // Skip if digest was sent within the last 2 days
    const lastDigestMs: number = dossierData.lastDigestSentAt?.toMillis?.() ?? 0;
    if (now - lastDigestMs < TWO_DAYS_MS) return false;
  }

  // Find the most recent completed session
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

    // Check timezone: only send at 7am local time (#83)
    let storytellerTimezone: string | undefined;
    try {
      const userDoc = await db.collection('users').doc(storytellerUid).get();
      storytellerTimezone = userDoc.data()?.timezone;
    } catch {
      // user doc not found
    }
    if (!storytellerTimezone) storytellerTimezone = 'America/Los_Angeles'; // default: US/Pacific
    const localHour = getLocalHour(storytellerTimezone);
    if (localHour !== 7) return false;
  }

  // Look up storyteller's email via Firebase Auth
  let storytellerEmail: string | undefined;
  try {
    const userRecord = await admin.auth().getUser(storytellerUid);
    storytellerEmail = userRecord.email;
  } catch {
    // user deleted or no email
  }
  if (!storytellerEmail) return false;

  // Topics come entirely from the Story Queue (Unasked questions), which now includes
  // any questions generated by gap analysis. Sorted by order, capped at 4.
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

  // Use the narrative summary (set by gap analysis) as the personalised intro if available.
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

  // Record send time to prevent repeat emails within 2 days
  await db
    .collection('families').doc(familyId)
    .collection('dossiers').doc(dossierId)
    .update({ lastDigestSentAt: admin.firestore.Timestamp.now() });

  functions.logger.info(
    `[Digest] Sent to ${storytellerEmail} for dossier ${dossierId}` +
    ` (${allTopics.length} topics, ${daysText} since last session, force=${force})`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Hourly digest sweep — sends at 7am in each storyteller's local timezone (#82, #83)
// ---------------------------------------------------------------------------

/**
 * Runs every hour. For each dossier, checks if it is currently 7am in the
 * storyteller's timezone (stored in users/{uid}.timezone on login) and sends
 * a re-engagement email if the timing and day-range gates pass.
 *
 * The lastDigestSentAt 2-day gate on the dossier is the idempotency lock —
 * even if a function run overlaps an hour boundary, the second run is a no-op.
 */
export const sendDailyDigest = functions
  .runWith({ secrets: [smtpPass], timeoutSeconds: 540, maxInstances: 2 })
  .pubsub.schedule('0 * * * *') // every hour
  .timeZone('UTC')
  .onRun(async () => {
    const transporter = createTransporter();
    if (!transporter) {
      functions.logger.warn('[Digest] SMTP not configured — skipping digest run');
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
          const didSend = await sendDigestForDossier(
            familyId, dossierDoc.id, transporter,
          );
          if (didSend) sent++;
        } catch (err) {
          functions.logger.error(
            `[Digest] Error for dossier ${dossierDoc.id}:`, err,
          );
        }
      }
    }

    functions.logger.info(`[Digest] Run complete — ${sent} email(s) sent`);
  });

// ---------------------------------------------------------------------------
// Manual digest trigger — admin callable (#84)
// ---------------------------------------------------------------------------

/**
 * Callable function: send a digest email for a specific dossier immediately,
 * bypassing day-range and timezone timing gates.
 *
 * Requires the caller to be a family admin.
 * Useful for testing and for admins who want to send a nudge.
 */
export const triggerDigestForDossier = functions
  .runWith({ secrets: [smtpPass, geminiApiKey], timeoutSeconds: 300 })
  .https.onCall(async (data, context) => {
    const { familyId, dossierId } = data as { familyId: string; dossierId: string };
    if (!familyId || !dossierId) {
      throw new functions.https.HttpsError('invalid-argument', 'familyId and dossierId are required.');
    }

    await verifyFamilyAdmin(context, familyId);

    const transporter = createTransporter();
    if (!transporter) {
      throw new functions.https.HttpsError('internal', 'SMTP is not configured on this server.');
    }

    // If no gap analysis exists yet, run it now before sending so the email has topics.
    const existingGap = await getGapAnalysis(familyId, dossierId);
    if (!existingGap) {
      const apiKey = geminiApiKey.value();
      if (apiKey) {
        try {
          functions.logger.info(`[triggerDigest] No gap analysis found — running now for dossier ${dossierId}`);
          const dossierDoc = await db
            .collection('families').doc(familyId)
            .collection('dossiers').doc(dossierId)
            .get();
          const dossierData = dossierDoc.data() ?? {};
          const result = await runGapAnalysis(
            familyId,
            dossierId,
            'manual-trigger',
            {
              storytellerName: dossierData.storytellerName ?? '',
              preferredName: dossierData.preferredName,
              storytellerContext: dossierData.storytellerContext,
              historicalContext: dossierData.historicalContext,
            },
            apiKey,
          );
          await saveGapAnalysis(familyId, dossierId, result);
          functions.logger.info(
            `[triggerDigest] Gap analysis complete: ${result.questions.length} questions generated`,
          );
        } catch (err) {
          functions.logger.warn('[triggerDigest] Gap analysis failed — will send without topics:', err);
        }
      }
    }

    const sent = await sendDigestForDossier(familyId, dossierId, transporter, { force: true });
    if (!sent) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Could not send digest — storyteller may have no linked email or no upcoming topics.',
      );
    }
    return { sent: true };
  });

// ---------------------------------------------------------------------------
// Memoir generation (#90)
// ---------------------------------------------------------------------------

/**
 * Callable: generate a memoir from all interview transcripts and events.
 *
 * Requires the caller to be a family admin.
 * Creates a placeholder memoir doc with status 'generating', runs the
 * two-pass Gemini pipeline server-side (no client API key needed), then
 * updates the doc to status 'draft' on completion.
 *
 * The client listens to the memoir doc in real-time for status updates.
 */
export const generateMemoir = functions
  .runWith({ secrets: [geminiApiKey], timeoutSeconds: 540, maxInstances: 3 })
  .https.onCall(async (data, context) => {
    const { familyId, dossierId } = data as { familyId: string; dossierId: string };
    if (!familyId || !dossierId) {
      throw new functions.https.HttpsError('invalid-argument', 'familyId and dossierId are required.');
    }

    await verifyFamilyAdmin(context, familyId);

    const apiKey = geminiApiKey.value();
    if (!apiKey) {
      throw new functions.https.HttpsError('internal', 'GEMINI_API_KEY is not configured on this server.');
    }

    // Create a placeholder memoir doc so the UI can show generating state immediately
    const now = admin.firestore.Timestamp.now();
    const memoirRef = await db
      .collection('families').doc(familyId)
      .collection('dossiers').doc(dossierId)
      .collection('memoirs')
      .add({
        title: 'Generating memoir...',
        status: 'generating',
        generatedBy: context.auth!.uid,
        chapters: [],
        createdAt: now,
        updatedAt: now,
      });

    try {
      await generateMemoirContent(familyId, dossierId, memoirRef.id, apiKey);
      functions.logger.info(`[Memoir] Generated for dossier ${dossierId}, doc ${memoirRef.id}`);
    } catch (err) {
      // Mark the doc as failed so the UI can surface the error
      await memoirRef.update({
        status: 'error' as any,
        updatedAt: admin.firestore.Timestamp.now(),
      });
      functions.logger.error(`[Memoir] Generation failed for dossier ${dossierId}:`, err);
      throw new functions.https.HttpsError('internal', 'Memoir generation failed. Please try again.');
    }

    return { memoirId: memoirRef.id };
  });
