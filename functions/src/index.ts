/**
 * Cloud Functions for LegacyBot.
 *
 * onInvitationCreated: Triggered when a new invitation document is created.
 * Sends an email to the invitee with a link to accept the invitation.
 *
 * Environment variables (set via .env or .env.<project> in functions/):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, APP_URL
 */

import * as functions from 'firebase-functions';
import { defineString, defineSecret } from 'firebase-functions/params';
import * as admin from 'firebase-admin';
import * as nodemailer from 'nodemailer';

admin.initializeApp();

const db = admin.firestore();

// Environment parameters (set via functions/.env or Firebase Console)
const smtpHost = defineString('SMTP_HOST', { default: '' });
const smtpPort = defineString('SMTP_PORT', { default: '587' });
const smtpUser = defineString('SMTP_USER', { default: '' });
const smtpPass = defineSecret('SMTP_PASS');
const appUrl = defineString('APP_URL', { default: 'https://legacybot.web.app' });

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
// Session Completion Notification (#44)
// ---------------------------------------------------------------------------

/**
 * Helper: create an SMTP transporter (shared between invitation and notification emails).
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
 * Triggered when a session document is updated.
 * If the status changed to 'completed', notifies opted-in admin members.
 */
export const onSessionCompleted = functions
  .runWith({ secrets: [smtpPass] })
  .firestore.document('families/{familyId}/dossiers/{dossierId}/sessions/{sessionId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();

    // Only trigger on status transition to 'completed'
    if (before.status === 'completed' || after.status !== 'completed') return;

    const { familyId, dossierId, sessionId } = context.params;

    // Look up the dossier for storyteller name
    let storytellerName = 'a storyteller';
    try {
      const dossierDoc = await db
        .collection('families').doc(familyId)
        .collection('dossiers').doc(dossierId)
        .get();
      if (dossierDoc.exists) {
        storytellerName = dossierDoc.data()?.storytellerName ?? storytellerName;
      }
    } catch (err) {
      functions.logger.warn('Could not look up dossier:', err);
    }

    // Get duration
    const durationMins = Math.round((after.durationSeconds ?? 0) / 60);

    // Find admins who have opted into notifications
    const membersSnap = await db
      .collection('families').doc(familyId)
      .collection('members')
      .where('roles', 'array-contains', 'admin')
      .get();

    const recipients: string[] = [];
    for (const memberDoc of membersSnap.docs) {
      const data = memberDoc.data();
      if (data.notifyOnSessionComplete && data.email) {
        recipients.push(data.email);
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

    const sessionUrl = `${appUrl.value()}/family/${familyId}/dossier/${dossierId}/history/${sessionId}`;

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
                <strong>${storytellerName}</strong> just completed a ${durationMins}-minute recording session on LegacyBot.
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
  });
