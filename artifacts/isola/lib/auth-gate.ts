/**
 * auth-gate@1 — what a guarded page should DO about an auth probe.
 *
 * Kept apart from the layout on purpose. A layout is an async server component
 * pulling in sidebars, preferences and authz; a decision buried in one is a
 * decision nobody writes a test for. The interesting assertion here — "a reader
 * whose sign-in service is down is NOT sent to a consent screen" — is one line
 * against this function and a small ordeal against the tree.
 */

import type { AuthProbe, AuthUnavailableReason, AuthUser } from './auth-probe'

export const AUTH_GATE_VERSION = 'auth-gate@1' as const

export const DEFAULT_LANDING = '/dashboard'

export type AuthGate =
  /** Signed in. Render the page. */
  | { kind: 'allow'; user: AuthUser }
  /**
   * Genuinely signed out, on the authority of the sign-in service. This is the
   * ONLY kind that produces a destination for the browser to follow.
   */
  | { kind: 'sign_in'; to: string }
  /**
   * We do not know who this is, because the service that knows could not be
   * reached. Nothing about the reader has been established, so nothing about
   * the reader's session should be discarded.
   */
  | {
      kind: 'unavailable'
      reason: AuthUnavailableReason
      detail: string
      /** Where a retry control should point: back at what they asked for. */
      retryTo: string
    }

/**
 * The same rules `artifacts/api-server/src/routes/auth.ts::getSafeReturnTo`
 * applies, kept in step deliberately. Rejected in order: not a string; not
 * rooted at '/'; protocol-relative '//evil.example'; any backslash, because
 * several browsers normalise '/\evil.example' into '//evil.example' and it
 * would otherwise slip past the '//' check; and control characters, which can
 * smuggle a newline into a Location header.
 */
export function safePath(value: unknown, fallback: string = DEFAULT_LANDING): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    Array.from(value).some((ch) => (ch.codePointAt(0) ?? 0) < 0x20 || ch.codePointAt(0) === 0x7f)
  ) {
    return fallback
  }
  return value
}

export function loginDestination(requestedPath: unknown): string {
  return `/auth/login?returnTo=${encodeURIComponent(safePath(requestedPath))}`
}

/**
 * Total over the probe union. There is no default branch, so a probe status
 * added later fails to compile here rather than quietly inheriting the redirect.
 */
export function decideAuthGate(probe: AuthProbe, requestedPath: unknown): AuthGate {
  if (probe.status === 'authenticated') {
    return { kind: 'allow', user: probe.user }
  }

  if (probe.status === 'anonymous') {
    return { kind: 'sign_in', to: loginDestination(requestedPath) }
  }

  return {
    kind: 'unavailable',
    reason: probe.reason,
    detail: probe.detail,
    retryTo: safePath(requestedPath),
  }
}

/**
 * The two sentences that must never be swapped. The first is a fact about the
 * reader; the second is a fact about us.
 */
export const AUTH_GATE_COPY = {
  signedOut: 'You are not signed in.',
  serviceUnavailable: 'The sign-in service cannot be reached.',
  serviceUnavailableBody:
    'This is a problem on our side, not with your account. You have not been signed out — nothing about your session has changed. Try again in a moment.',
  retryLabel: 'Try again',
} as const
