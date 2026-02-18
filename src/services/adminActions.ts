/**
 * Client-side wrappers for admin Cloud Functions.
 * These call Firebase callable functions for operations that
 * require the Admin SDK (email changes, password resets).
 */

import { getFunctions, httpsCallable, Functions } from 'firebase/functions';

let _functions: Functions | null = null;
function functions(): Functions {
  if (!_functions) _functions = getFunctions();
  return _functions;
}

/**
 * Update a family member's email address.
 * Requires the caller to be a family admin.
 */
export async function updateMemberEmail(
  familyId: string,
  targetUid: string,
  newEmail: string,
): Promise<void> {
  const fn = httpsCallable(functions(), 'updateMemberEmail');
  await fn({ familyId, targetUid, newEmail });
}

/**
 * Generate a password reset link for a family member.
 * Returns the reset link URL.
 */
export async function resetMemberPassword(
  familyId: string,
  targetUid: string,
): Promise<string> {
  const fn = httpsCallable<{ familyId: string; targetUid: string }, { resetLink: string }>(
    functions(),
    'resetMemberPassword',
  );
  const result = await fn({ familyId, targetUid });
  return result.data.resetLink;
}
