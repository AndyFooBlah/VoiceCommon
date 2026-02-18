/**
 * Cloud Functions for LegacyBot.
 *
 * onInvitationCreated: Triggered when a new invitation document is created.
 * Sends an email to the invitee with a link to accept the invitation.
 *
 * Environment variables (set via firebase functions:config:set):
 *   smtp.host, smtp.port, smtp.user, smtp.pass, app.url
 */

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as nodemailer from 'nodemailer';

admin.initializeApp();

const db = admin.firestore();

/**
 * Triggered when a new document is created in the invitations collection.
 * Sends an invitation email with a link to join the family.
 */
export const onInvitationCreated = functions.firestore
  .document('invitations/{inviteId}')
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
    const appUrl = functions.config().app?.url ?? 'https://legacybot.web.app';
    const inviteUrl = `${appUrl}/invite?token=${inviteId}`;

    // Set up email transport
    const smtpConfig = functions.config().smtp;
    if (!smtpConfig?.host || !smtpConfig?.user || !smtpConfig?.pass) {
      functions.logger.error(
        'SMTP not configured. Set smtp.host, smtp.port, smtp.user, smtp.pass via firebase functions:config:set',
      );
      return;
    }

    const transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: parseInt(smtpConfig.port ?? '587', 10),
      secure: smtpConfig.port === '465',
      auth: {
        user: smtpConfig.user,
        pass: smtpConfig.pass,
      },
    });

    const roleText = roles.join(' and ');

    const mailOptions = {
      from: `"LegacyBot" <${smtpConfig.user}>`,
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
