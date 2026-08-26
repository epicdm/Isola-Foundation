'use client'

/**
 * Isola Workspace — receiving the Chatwoot Dashboard App context.
 *
 * This is the DOM plumbing only. Every decision lives in
 * `lib/isola-workspace/chatwoot-context.ts`, which is pure and fully tested; this file just
 * wires it to `window`. That split is deliberate: the app has no jsdom and no
 * testing-library, so anything with real logic in a hook would be untestable.
 *
 * WHAT THIS HOOK RETURNS IS A HINT, NOT AN IDENTITY.
 *
 * Verified against the running Chatwoot 4.16.1-CE served bundle on 2026-08-06:
 *   - Chatwoot posts `{event:'appContext', data:{...}}` as a JSON STRING.
 *   - It uses `targetOrigin: '*'`.
 *   - It re-sends when the frame posts the plain string
 *     `'chatwoot-dashboard-app:fetch-info'`, and it does NOT validate that request's origin.
 *   - Nothing is signed.
 *
 * So the three integers this returns are only good enough to ASK the server a question. The
 * server must independently resolve the tenant from the Foundation session, re-read the
 * conversation under its own narrow identity, and confirm the account/inbox/conversation
 * actually belong to that tenant before returning a single field.
 */

import { useEffect, useState } from 'react'

import {
  CHATWOOT_FETCH_INFO_REQUEST,
  isExpectedChatwootOrigin,
  parseChatwootAppContext,
  type ChatwootContextHint,
  type ChatwootContextRejection,
} from '@/lib/isola-workspace/chatwoot-context'

export type ChatwootContextStatus =
  /** Mounted, asked, nothing back yet. */
  | { phase: 'waiting' }
  /** A hint arrived. Still not an authorization. */
  | { phase: 'received'; hint: ChatwootContextHint }
  /** Something posted at us that we would not accept. */
  | { phase: 'rejected'; reason: ChatwootContextRejection | 'unexpected-origin' }

export interface UseChatwootContextOptions {
  /**
   * The Chatwoot base URL this panel expects to be embedded by.
   *
   * When provided, messages from any other origin are ignored. This is HYGIENE, NOT A
   * SECURITY CONTROL — Chatwoot broadcasts with `targetOrigin: '*'` and validates nothing on
   * its side, so anyone able to host a frame on the expected origin passes. It exists to
   * stop us acting on stray messages, not to establish trust.
   */
  expectedOrigin?: string
}

export function useChatwootContext(
  options: UseChatwootContextOptions = {},
): ChatwootContextStatus {
  const { expectedOrigin } = options
  const [status, setStatus] = useState<ChatwootContextStatus>({ phase: 'waiting' })

  useEffect(() => {
    if (typeof window === 'undefined') return

    function onMessage(event: MessageEvent) {
      if (expectedOrigin && !isExpectedChatwootOrigin(event.origin, expectedOrigin)) {
        // Do not surface a rejection for unrelated chatter — a page can receive messages
        // from analytics frames, extensions and devtools. Only report a rejection when the
        // message actually looked like ours.
        if (typeof event.data === 'string' && event.data.includes('appContext')) {
          setStatus({ phase: 'rejected', reason: 'unexpected-origin' })
        }
        return
      }

      const result = parseChatwootAppContext(event.data)
      if (result.ok) {
        setStatus({ phase: 'received', hint: result.hint })
      } else if (typeof event.data === 'string' && event.data.includes('appContext')) {
        setStatus({ phase: 'rejected', reason: result.reason })
      }
      // Anything else is ignored in silence: it was not addressed to us.
    }

    window.addEventListener('message', onMessage)

    // Ask for the context. Chatwoot also pushes it on iframe load, but that push races the
    // listener being attached, so the explicit request is what makes this reliable.
    //
    // Chatwoot matches this with `event.data === 'chatwoot-dashboard-app:fetch-info'` — a
    // PLAIN STRING, not an object, and not JSON. Sending anything else is silently ignored.
    // Note Chatwoot's own re-send handler is hardcoded to dashboard-app index 0 and only
    // fires when that tab is visible, so a panel mounted in a second dashboard app will not
    // be answered.
    window.parent?.postMessage(CHATWOOT_FETCH_INFO_REQUEST, '*')

    return () => window.removeEventListener('message', onMessage)
  }, [expectedOrigin])

  return status
}
