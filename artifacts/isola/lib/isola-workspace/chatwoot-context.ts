/**
 * Isola Workspace — the Chatwoot Dashboard App trust boundary.
 *
 * THIS FILE IS THE UNTRUSTED EDGE. Everything it returns is a HINT, never an authorization.
 *
 * WHAT THE SUBSTRATE ACTUALLY DOES (verified read-only against the running Chatwoot
 * 4.16.1-CE image and its SERVED bundle on 2026-08-06, not from documentation):
 *
 *   - Chatwoot posts to the embedded iframe with `targetOrigin: '*'`.
 *   - The payload is a JSON **string** (`JSON.stringify`), not an object:
 *         { "event": "appContext",
 *           "data": { "conversation": <full conversation object>,
 *                     "contact": <contact record, or {}>,
 *                     "currentAgent": { "id", "name", "email" } } }
 *   - Chatwoot re-sends on receiving the PLAIN STRING `'chatwoot-dashboard-app:fetch-info'`
 *     from the frame, and it does NOT validate the origin of that inbound request.
 *   - Nothing in the payload is signed. There is no HMAC, no nonce, no timestamp.
 *
 * Consequences this file is built around:
 *
 *   1. The payload is attacker-shaped input. Any page that can get itself loaded in that
 *      iframe — or any script in this frame — can post an identical message. It therefore
 *      carries NO authority whatsoever.
 *   2. We validate the sender's origin OURSELVES, because Chatwoot does not. That is a
 *      necessary hygiene measure and explicitly NOT a security control: an attacker who
 *      controls a frame on the expected origin passes it. Authorization always comes from
 *      the Foundation session.
 *   3. We extract the MINIMUM: account id, inbox id, conversation display id. Nothing else
 *      crosses this boundary. Name, phone, email, labels, custom attributes and the whole
 *      `currentAgent` object are deliberately discarded — we re-read what we need
 *      server-side under our own identity.
 *
 * THE RULE, from dec-chatwoot-tenant-daily-workspace-foundation-saas-control-plane-2026-08-06:
 *   "Do not trust a tenant_id, customer_id, Odoo partner ID, role or permission supplied by
 *    the browser or Chatwoot payload."
 *
 * So this module cannot even REPRESENT those. `ChatwootContextHint` has no field for a
 * tenant, a role or a permission — the type system refuses to carry them, which is stronger
 * than a convention that a future edit could forget.
 */

/**
 * The only three values we accept from the browser. Deliberately a distinct type from
 * `ResolvedConversationRef` so an unverified hint can never be passed where a verified
 * reference is required — the compiler enforces the boundary that a reviewer would
 * otherwise have to notice.
 */
export interface ChatwootContextHint {
  readonly accountIdHint: number
  readonly inboxIdHint: number
  /** Chatwoot's `display_id`, which is what its UI and API path use — NOT the DB key. */
  readonly conversationDisplayIdHint: number
}

export type ChatwootContextParseResult =
  | { ok: true; hint: ChatwootContextHint }
  | { ok: false; reason: ChatwootContextRejection }

export type ChatwootContextRejection =
  | 'not-a-string'
  | 'malformed-json'
  | 'wrong-event'
  | 'missing-conversation'
  | 'missing-identifiers'
  | 'identifier-not-a-positive-integer'

/** The exact handshake string Chatwoot listens for. Verified in the served bundle. */
export const CHATWOOT_FETCH_INFO_REQUEST = 'chatwoot-dashboard-app:fetch-info'

/** The exact event name Chatwoot sends. Verified in the served bundle. */
export const CHATWOOT_APP_CONTEXT_EVENT = 'appContext'

/**
 * Accept a Chatwoot identifier only if it is a positive, safe integer.
 *
 * Chatwoot serializes these as JSON numbers, but a hostile poster can send a string, a
 * float, a negative, `0`, or something past `Number.MAX_SAFE_INTEGER`. Each of those would
 * otherwise flow into a URL or a query and become someone else's problem downstream, so
 * they are rejected at the edge where the failure is cheap and legible.
 */
function toPositiveInt(value: unknown): number | null {
  if (typeof value !== 'number') return null
  if (!Number.isInteger(value)) return null
  if (value <= 0) return null
  if (!Number.isSafeInteger(value)) return null
  return value
}

/**
 * Parse a raw `postMessage` payload into a hint.
 *
 * PURE and synchronous, so it is fully testable under vitest's `node` environment with no
 * DOM. The DOM plumbing lives in `use-chatwoot-context.ts`; the decision logic lives here.
 */
export function parseChatwootAppContext(raw: unknown): ChatwootContextParseResult {
  // Chatwoot sends a JSON string. We accept ONLY a string: taking an object too would
  // widen the surface for no benefit, since the real sender never sends one.
  if (typeof raw !== 'string') return { ok: false, reason: 'not-a-string' }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'malformed-json' }
  }

  if (!isRecord(parsed)) return { ok: false, reason: 'malformed-json' }
  if (parsed.event !== CHATWOOT_APP_CONTEXT_EVENT) return { ok: false, reason: 'wrong-event' }

  const data = parsed.data
  if (!isRecord(data)) return { ok: false, reason: 'missing-conversation' }

  const conversation = data.conversation
  if (!isRecord(conversation)) return { ok: false, reason: 'missing-conversation' }

  // `conversation.id` is display_id — Chatwoot's jbuilder emits `json.id conversation.display_id`.
  // Anything correlating back to Chatwoot's API must use this, not the primary key.
  const rawConversationId = conversation.id
  const rawInboxId = conversation.inbox_id
  const rawAccountId = conversation.account_id

  if (
    rawConversationId === undefined ||
    rawInboxId === undefined ||
    rawAccountId === undefined
  ) {
    return { ok: false, reason: 'missing-identifiers' }
  }

  const conversationDisplayIdHint = toPositiveInt(rawConversationId)
  const inboxIdHint = toPositiveInt(rawInboxId)
  const accountIdHint = toPositiveInt(rawAccountId)

  if (
    conversationDisplayIdHint === null ||
    inboxIdHint === null ||
    accountIdHint === null
  ) {
    return { ok: false, reason: 'identifier-not-a-positive-integer' }
  }

  // Everything else in the payload — contact, currentAgent, labels, custom_attributes,
  // meta.sender, messages — is DISCARDED here and never returned. We re-read what we need
  // server-side under Foundation's own narrow identity. Widening this return value is the
  // single most likely way to reintroduce the trust bug this file exists to prevent.
  return {
    ok: true,
    hint: { accountIdHint, inboxIdHint, conversationDisplayIdHint },
  }
}

/**
 * Whether a message origin is the expected Chatwoot host.
 *
 * NOT A SECURITY CONTROL. Chatwoot posts with `targetOrigin: '*'` and does not validate the
 * origin of the inbound fetch-info request, so this check is hygiene: it stops us acting on
 * stray messages from unrelated frames and makes the expected sender explicit. An attacker
 * with a foothold on the expected origin passes it trivially. Authorization is the
 * Foundation session, always.
 *
 * Compares parsed ORIGINS, never a string prefix: `startsWith('https://inbox.epic.dm')`
 * would happily accept `https://inbox.epic.dm.attacker.example`.
 */
export function isExpectedChatwootOrigin(
  messageOrigin: string,
  expectedBaseUrl: string,
): boolean {
  if (!messageOrigin || !expectedBaseUrl) return false
  try {
    const actual = new URL(messageOrigin)
    const expected = new URL(expectedBaseUrl)
    return actual.origin === expected.origin
  } catch {
    return false
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
