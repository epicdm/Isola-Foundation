/**
 * Shared plumbing for the database-backed activity sources.
 *
 * Two rules everything here exists to enforce:
 *
 * 1. A query that THREW is `unavailable`. It is never an empty list. "Nothing
 *    happened today" and "we could not find out" look identical on screen and
 *    mean opposite things.
 * 2. Rows carry only what the caller is allowed to know. Database columns hold
 *    approved parameters, failure detail and free text; none of it reaches the
 *    projection unless deliberately allowed through.
 *
 * Every adapter reads through an injected port, so tests need no database and
 * the failure paths are exercised rather than described.
 */

import type {
  ActivityItem,
  ActivitySource,
  DataMode,
  NativeLink,
  ResolvedQuery,
  SourceResult,
} from '../feed'

/** Thrown by a port when the CALLER may not read this source at all. */
export class SourceForbidden extends Error {
  constructor(message = 'not permitted') {
    super(message)
    this.name = 'SourceForbidden'
  }
}

export interface SourceDeps<Row> {
  /** Reads the rows. May throw; that is the point. */
  list(query: ResolvedQuery): Promise<Row[]>
  now(): Date
  /** Set when this source is serving seeded rather than production data. */
  mode?: DataMode
  /** Non-null when the read is known to be older than it should be. */
  staleReason?: () => string | null
}

/**
 * Failure detail from a database or a driver is written for engineers and can
 * carry connection strings, SQL and identifiers. Operators need to know a source
 * failed and roughly why; they do not need the raw text.
 */
export function safeFailure(err: unknown): string {
  if (err instanceof SourceForbidden) return err.message
  const raw = err instanceof Error ? err.message : String(err)
  if (/timeout|timed out|ETIMEDOUT/i.test(raw)) return 'the source did not answer in time'
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket/i.test(raw)) {
    return 'the source could not be reached'
  }
  if (/permission|denied|not authori[sz]ed/i.test(raw)) return 'the source refused the read'
  return 'the source failed to answer'
}

/** Trim free text to something a row can show without becoming a document. */
export function summarise(value: unknown, max = 240): string {
  const s = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (!s) return ''
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

/** Anything shaped like a credential never reaches a screen, whatever it is. */
const SECRET_SHAPED =
  /(^EAA[A-Za-z0-9]{20,})|(^gh[pousr]_[A-Za-z0-9]{20,})|(^sk-[A-Za-z0-9]{16,})|(^Bearer\s)|(^eyJ[A-Za-z0-9_-]+\.)/

export function isSecretShaped(v: unknown): boolean {
  return typeof v === 'string' && (SECRET_SHAPED.test(v.trim()) || v.trim().length > 400)
}

/**
 * Copies only the named keys, and drops any value that looks like a credential.
 * A whitelist rather than a blacklist: a column added next year is excluded by
 * default instead of leaking by default.
 */
export function pickSafe(
  source: unknown,
  keys: readonly string[],
): Record<string, string> {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {}
  const row = source as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const key of keys) {
    const v = row[key]
    if (v === null || v === undefined) continue
    if (typeof v === 'object') continue
    const s = String(v)
    if (isSecretShaped(s)) continue
    out[key] = s
  }
  return out
}

export const iso = (d: unknown): string =>
  d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date(0).toISOString()

/** An actor reference tells us what kind of thing acted. */
export function actorKindOf(ref: string): ActivityItem['actor']['kind'] {
  if (!ref || ref === 'system') return 'system'
  if (ref.startsWith('agent:')) return 'agent'
  if (ref.startsWith('customer:') || ref.startsWith('contact:')) return 'customer'
  return 'staff'
}

/**
 * A deep link is only offered when we actually have a base URL for that system.
 * A fabricated link that 404s is worse than no link, because it looks checked.
 */
export function deepLink(
  system: string,
  label: string,
  baseUrl: string | null | undefined,
  path: string,
): NativeLink[] {
  if (!baseUrl) return []
  return [{ system, label, href: `${baseUrl.replace(/\/+$/, '')}${path}` }]
}

/**
 * Wraps a port into an ActivitySource, applying the two rules at the top of this
 * file to every adapter identically.
 */
export function buildSource<Row>(
  name: string,
  deps: SourceDeps<Row>,
  project: (row: Row, query: ResolvedQuery) => ActivityItem | null,
): ActivitySource {
  return {
    name,
    async read(query): Promise<SourceResult> {
      let rows: Row[]
      try {
        rows = await deps.list(query)
      } catch (err) {
        if (err instanceof SourceForbidden) return { status: 'forbidden' }
        return { status: 'unavailable', reason: safeFailure(err) }
      }

      const fetchedAt = deps.now().toISOString()
      const items: ActivityItem[] = []
      for (const row of rows) {
        // A single malformed row must not take the whole source down with it.
        try {
          const item = project(row, query)
          if (item) items.push(item)
        } catch {
          continue
        }
      }

      const stale = deps.staleReason?.() ?? null
      if (stale) return { status: 'stale', items, fetchedAt, reason: stale, mode: deps.mode }
      return { status: 'ok', items, fetchedAt, mode: deps.mode }
    },
  }
}
