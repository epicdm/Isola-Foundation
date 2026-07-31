/**
 * The transport-free half of GET /api/v1/activity.
 *
 * Everything this endpoint DECIDES lives here: parse the query, run the feed,
 * map the answer onto a status code. There is no Next.js import in this file
 * and there must not be one — the route is a thin adapter, and every rule below
 * is exercised by `handler.test.ts` without starting a server.
 *
 * THE RULE THAT IS EASIEST TO GET WRONG
 * -------------------------------------
 * A source-level `forbidden` is NOT a request-level 403. A manager who may not
 * read the audit trail is still entitled to their feed: the audit source is
 * reported `forbidden`, contributes zero rows, and the other four answer
 * normally. Turning that into a 403 would delete four working sources because
 * of one the caller was never going to see.
 *
 * Only a refusal about the CALLER — an unknown or inactive actor, or a company
 * they may not see — is a 403, and its wording never lets the caller tell
 * "not yours" from "does not exist".
 *
 * THE SECOND EASIEST
 * ------------------
 * `unavailable` is not `available_empty`. Every source down is a 503, because
 * "nothing happened today" and "we could not find out what happened" look
 * identical on screen and mean opposite things.
 *
 * WHAT NEVER LEAVES THIS FILE
 * ---------------------------
 * Exception text, stack frames, hostnames, connection strings and query text.
 * Source `detail` is passed through EXACTLY as the adapter produced it — the
 * adapters sanitise through `safeFailure`, and re-deriving detail here would
 * quietly reopen the leak the adapters closed.
 */

import {
  getActivityFeed,
  type ACTIVITY_FEED_VERSION,
  type ActivityFeedItem,
  type ActivityPermissions,
  type ActivitySource,
  type DataMode,
  type DataState,
  type SourceReport,
} from './feed'
import { encodeActivityCursor, parseActivityQuery, type QueryRejection } from './query'

/** A source's own answer, reported per source and never flattened into one. */
export interface ActivitySourceReport {
  source: string
  state: SourceReport['state']
  detail?: string
  fetchedAt?: string
  mode?: DataMode
}

export interface ActivityResponseBody {
  version: typeof ACTIVITY_FEED_VERSION
  dataState: DataState
  containsFixture: boolean
  generatedAt: string
  items: ActivityFeedItem[]
  nextCursor: string | null
  sources: ActivitySourceReport[]
}

export interface ActivityHandlerDeps {
  sources: readonly ActivitySource[]
  permissions: ActivityPermissions
  now(): Date
  /** The source names the parser will accept in `?source=`. */
  knownSources: readonly string[]
}

export type ActivityHandlerResult =
  | { kind: 'ok'; status: 200; body: ActivityResponseBody }
  | {
      kind: 'invalid_query'
      status: 400
      body: { error: 'invalid_query'; parameter: string; code: QueryRejection; detail: string }
    }
  | { kind: 'forbidden'; status: 403; body: { error: string } }
  | { kind: 'unavailable'; status: 503; body: { error: 'activity_unavailable' } }
  | { kind: 'failed'; status: 500; body: { error: 'internal_error' } }

const invalid = (
  parameter: string,
  code: QueryRejection,
  detail: string,
): ActivityHandlerResult => ({
  kind: 'invalid_query',
  status: 400,
  body: { error: 'invalid_query', parameter, code, detail },
})

/**
 * Copies a source report field by field. A spread would carry anything a future
 * feed version adds onto the wire without anyone deciding it should be there.
 */
function reportOf(r: SourceReport): ActivitySourceReport {
  return {
    source: r.source,
    state: r.state,
    // Already sanitised by the adapter. Passed through, never rebuilt.
    ...(r.detail !== undefined ? { detail: r.detail } : {}),
    ...(r.fetchedAt !== undefined ? { fetchedAt: r.fetchedAt } : {}),
    ...(r.mode !== undefined ? { mode: r.mode } : {}),
  }
}

export function buildActivityHandler(deps: ActivityHandlerDeps): {
  handle(params: URLSearchParams, scope: { companyId: string }): Promise<ActivityHandlerResult>
} {
  return {
    async handle(params, scope) {
      try {
        const parsed = parseActivityQuery(params, {
          companyId: scope.companyId,
          knownSources: deps.knownSources,
        })
        if (!parsed.ok) {
          // Name the parameter. A caller who filtered wrongly must be told which
          // filter, or they will believe the empty screen.
          return invalid(parsed.parameter, parsed.rejection, parsed.detail)
        }

        const feed = await getActivityFeed(parsed.query, {
          sources: deps.sources,
          permissions: deps.permissions,
          now: deps.now,
        })

        if (!feed.ok) {
          switch (feed.refusal) {
            case 'unauthorized_company':
            case 'unknown_or_inactive_actor':
              // The feed's own wording, which is deliberately identical for a
              // company that is forbidden and one that does not exist.
              return { kind: 'forbidden', status: 403, body: { error: feed.detail } }
            case 'invalid_cursor':
              return invalid('cursor', 'malformed_cursor', feed.detail)
            case 'invalid_filter':
            default:
              // Belt and braces: the parser already refuses every filter shape
              // the feed rejects, so reaching here means the two disagreed.
              return invalid('filter', 'malformed_identifier', feed.detail)
          }
        }

        if (feed.dataState === 'unavailable') {
          // Nothing answered. Returning 200 with an empty list here is the
          // single failure this whole contract exists to prevent.
          return { kind: 'unavailable', status: 503, body: { error: 'activity_unavailable' } }
        }

        return {
          kind: 'ok',
          status: 200,
          body: {
            version: feed.version,
            dataState: feed.dataState,
            containsFixture: feed.containsFixture,
            generatedAt: deps.now().toISOString(),
            items: feed.items,
            // Re-wrapped against the fingerprint of the filters that produced
            // it, so it cannot be replayed against a different question.
            nextCursor: feed.nextCursor
              ? encodeActivityCursor(feed.nextCursor, parsed.fingerprint)
              : null,
            sources: feed.sources.map(reportOf),
          },
        }
      } catch {
        // Deliberately discards the exception. Its message can carry a
        // connection string, a hostname, SQL or a stack trace, and none of that
        // is the caller's business.
        return { kind: 'failed', status: 500, body: { error: 'internal_error' } }
      }
    },
  }
}
