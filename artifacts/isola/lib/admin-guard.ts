/**
 * lib/admin-guard.ts — single admin-access check shared by every admin-only
 * route handler and server-component page, so "am I an admin" can never
 * diverge between the two call sites (getSession()/getSessionFromCookie()
 * already delegate to the same resolveSession(), but the isAdmin check
 * itself was previously duplicated ad hoc at each call site).
 */
import { getSession, type SessionCtx } from './session';

export type AdminGuardResult =
  | { ok: true; session: SessionCtx }
  | { ok: false; status: 401 | 403; error: string };

export async function requireAdmin(): Promise<AdminGuardResult> {
  const session = await getSession();
  if (!session) return { ok: false, status: 401, error: 'Unauthorized' };
  if (!session.isAdmin) return { ok: false, status: 403, error: 'Forbidden' };
  return { ok: true, session };
}
