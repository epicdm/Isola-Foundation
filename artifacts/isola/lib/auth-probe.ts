/**
 * auth-probe@1 — the sign-in service is asked a question with THREE answers.
 *
 * "Nobody is signed in" and "the thing that knows who is signed in could not be
 * reached" are opposite facts. Collapsing them into one value is what turns a
 * dependency's cold start into a forced global logout, because every caller
 * downstream reads the collapsed value as the first meaning.
 *
 * Everything here is injected — the fetch, the endpoint, the clock — so each
 * failure mode is exercised by a test rather than described in a comment.
 */

export const AUTH_PROBE_VERSION = 'auth-probe@1' as const

export interface AuthUser {
  id: string
  email: string | null
  firstName: string | null
  lastName: string | null
  profileImageUrl: string | null
}

/**
 * Why we do not know. Each one is actionable differently: `timeout` and
 * `unreachable` are worth retrying immediately, `dependency_error` usually is
 * not, and `malformed_answer` means something answered and we could not read it,
 * which is a defect rather than an outage.
 */
export const AUTH_UNAVAILABLE_REASONS = [
  'unreachable',
  'timeout',
  'dependency_error',
  'malformed_answer',
] as const
export type AuthUnavailableReason = (typeof AUTH_UNAVAILABLE_REASONS)[number]

export type AuthProbe =
  | { status: 'authenticated'; user: AuthUser }
  | { status: 'anonymous' }
  | { status: 'unavailable'; reason: AuthUnavailableReason; detail: string }

/** Express runs in the same process group; browser-facing rewrites do not apply. */
export const DEFAULT_AUTH_ENDPOINT = 'http://localhost:8080/auth/user'
export const DEFAULT_AUTH_TIMEOUT_MS = 5_000

export interface AuthProbePorts {
  fetch: typeof fetch
  endpoint?: string
  timeoutMs?: number
}

/**
 * Sanitised for a screen. A driver or DNS message can carry hostnames, ports and
 * internal addresses, and this string is reachable by a reader who is not signed
 * in — which is precisely the reader we know least about.
 */
function safeDetail(reason: AuthUnavailableReason): string {
  switch (reason) {
    case 'timeout':
      return 'the sign-in service did not answer in time'
    case 'unreachable':
      return 'the sign-in service could not be reached'
    case 'dependency_error':
      return 'the sign-in service answered with an error'
    case 'malformed_answer':
      return 'the sign-in service answered with something we could not read'
  }
}

const unavailable = (reason: AuthUnavailableReason): AuthProbe => ({
  status: 'unavailable',
  reason,
  detail: safeDetail(reason),
})

/** An abort raised by our own deadline, as opposed to any other network fault. */
function isTimeout(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: unknown }).name
  return name === 'AbortError' || name === 'TimeoutError'
}

function readUser(body: unknown): AuthUser | null | 'unreadable' {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'unreadable'
  if (!('user' in body)) return 'unreadable'

  const user = (body as { user: unknown }).user
  // An explicit null is a real answer: the service is up and says nobody is here.
  if (user === null) return null
  if (!user || typeof user !== 'object' || Array.isArray(user)) return 'unreadable'

  const id = (user as { id?: unknown }).id
  if (typeof id !== 'string' || !id) return 'unreadable'

  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  const u = user as Record<string, unknown>
  return {
    id,
    email: str(u.email),
    firstName: str(u.firstName),
    lastName: str(u.lastName),
    profileImageUrl: str(u.profileImageUrl),
  }
}

export async function probeAuthUser(
  headers: HeadersInit,
  ports: AuthProbePorts,
): Promise<AuthProbe> {
  const endpoint = ports.endpoint ?? DEFAULT_AUTH_ENDPOINT
  const timeoutMs = ports.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS

  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), timeoutMs)

  let res: Response
  try {
    res = await ports.fetch(endpoint, {
      headers: { 'Content-Type': 'application/json', ...headers },
      cache: 'no-store',
      signal: controller.signal,
    })
  } catch (err) {
    // We never got an answer. This is the branch the old `catch { return null }`
    // swallowed, and it is the whole reason this module exists.
    return unavailable(isTimeout(err) ? 'timeout' : 'unreachable')
  } finally {
    clearTimeout(deadline)
  }

  // 401/403 is the service telling us, with authority, that nobody is here.
  if (res.status === 401 || res.status === 403) return { status: 'anonymous' }

  // Anything else non-OK is the service having a problem, not a verdict about
  // the reader. A 404 means the endpoint moved; a 502 means it is broken. In
  // neither case have we learned that this person is signed out.
  if (!res.ok) return unavailable('dependency_error')

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return unavailable('malformed_answer')
  }

  const user = readUser(body)
  if (user === 'unreadable') return unavailable('malformed_answer')
  if (user === null) return { status: 'anonymous' }
  return { status: 'authenticated', user }
}

/** True when the answer was a verdict about the reader rather than an outage. */
export function isDecisive(probe: AuthProbe): boolean {
  return probe.status !== 'unavailable'
}
