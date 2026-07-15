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

export interface AuthUser {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
}

export interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

/**
 * Fetch the current session user from the Express API server.
 * Call this from Server Components or API routes.
 */
export async function getAuthUser(
  headers: HeadersInit = {},
): Promise<AuthUser | null> {
  try {
    // Always call Express directly at localhost:8080 for server-to-server auth checks.
    // In dev and production Express runs in the same process group; the /auth/*
    // Next.js rewrite only applies to browser-facing requests, not these internal calls.
    const res = await fetch('http://localhost:8080/auth/user',
      {
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        cache: 'no-store',
      },
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.user ?? null;
  } catch {
    return null;
  }
}

/** Redirect path for login — preserves the returnTo destination. */
export function loginUrl(returnTo = '/'): string {
  return `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

/** Redirect path for logout. */
export function logoutUrl(returnTo = '/'): string {
  return `/auth/logout?returnTo=${encodeURIComponent(returnTo)}`;
}
