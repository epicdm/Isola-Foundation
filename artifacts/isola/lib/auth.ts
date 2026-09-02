/**
 * Auth helpers for the Isola Next.js frontend.
 *
 * Authentication is handled by the shared Express API server via Replit's
 * OIDC provider. The browser flow is redirect-based:
 *   Login  → GET /auth/login?returnTo=/
 *   Logout → GET /auth/logout?returnTo=/
 *
 * The current auth state is available from GET /auth/user (returns
 * { user: AuthUser | null }).
 */

import { probeAuthUser, type AuthProbe, type AuthUser } from './auth-probe';

export type { AuthProbe, AuthUser };

export interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

/**
 * The current session user, or null.
 *
 * Deliberately still two-valued, so the call sites that only ever wanted a user
 * keep compiling untouched. But null here now means "not authenticated", for
 * EITHER reason, and it is no longer the only thing on offer: anywhere a
 * redirect, a refusal or a 401 follows from the answer, use probeAuth() and act
 * on the third case rather than guessing which of the two this null was.
 */
export async function getAuthUser(
  headers: HeadersInit = {},
): Promise<AuthUser | null> {
  const probe = await probeAuthUser(headers, { fetch });
  return probe.status === 'authenticated' ? probe.user : null;
}

/**
 * The three-valued answer: authenticated, anonymous, or we could not find out.
 *
 * Express is always called directly at localhost:8080 for server-to-server auth
 * checks. In dev and production it runs in the same process group; the /auth/*
 * Next.js rewrite only applies to browser-facing requests, not to these.
 */
export async function probeAuth(headers: HeadersInit = {}): Promise<AuthProbe> {
  return probeAuthUser(headers, { fetch });
}

/** Redirect path for login — preserves the returnTo destination. */
export function loginUrl(returnTo = '/'): string {
  return `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

/** Redirect path for logout. */
export function logoutUrl(returnTo = '/'): string {
  return `/auth/logout?returnTo=${encodeURIComponent(returnTo)}`;
}
