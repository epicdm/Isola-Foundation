/**
 * POST /api/isola-360/actions/send-document
 *
 * S8-W1: send an EXISTING Odoo quotation or invoice into the customer's Chatwoot
 * conversation, through the shared governed write layer.
 *
 * TWO MODES, ONE COMPOSER
 * -----------------------
 *   preview: true   → compose and return the exact text. Touches no ledger,
 *                     sends nothing.
 *   preview: false  → compose again, prove it still matches what the operator
 *                     reviewed, then run the governed action.
 *
 * Both modes call the SAME `composeDocumentMessage`. That is the point: the text
 * shown in the confirm dialog is not a client-side approximation of what will be
 * sent, it is produced by the identical server-side function. The panel never
 * composes a customer-facing word.
 *
 * WHY A FINGERPRINT
 * -----------------
 * A human confirms a specific sentence. If the document changes in Odoo between
 * preview and confirm, the honest outcome is to refuse and re-show — not to send
 * a different message than the one that was approved. `previewFingerprint` binds
 * the confirmation to the exact bytes.
 *
 * WHY A FAILED SEND STILL ANSWERS 200
 * -----------------------------------
 * Same rule as `/api/v1/customers/:customerId/actions`: the status line
 * describes the REQUEST, the body describes the ACTION. `success` is an explicit
 * field from the presentation contract, and only a verified readback carries it.
 * 4xx is reserved for the request itself being wrong. A conflict is
 * `lifecycle: 'argument_conflict'` in a 200 body, never a 409.
 *
 * THE TENANT BOUNDARY IS PROVEN BEFORE ANYTHING IS PROPOSED
 * --------------------------------------------------------
 * Three checks, all against this session's tenant, and — since 2026-08-28 — each
 * one CHAINED to the previous rather than merely passing beside it:
 *
 *   1. the conversation must exist in this workspace's mirror;
 *   2. the Chatwoot door is resolved FROM THAT CONVERSATION, never from the
 *      browser, and the caller's hint may only disagree and cause a refusal;
 *   3. the document must appear in the Odoo snapshot for THAT conversation's
 *      customer.
 *
 * The chaining is the point. An earlier version ran 1 and 2 independently, with
 * the door taken from the browser hint, so all three could pass while the door
 * and the conversation belonged to DIFFERENT customers — and the message was
 * delivered to the wrong one. See def-c360-send-target-not-bound-to-
 * conversation-binding-2026-08-28.
 */

import { NextRequest, NextResponse } from 'next/server'

import { getSessionFromCookie } from '@/lib/session'
import { getMembershipRole } from '@/lib/permissions'
import { prisma } from '@/lib/prisma'
import { resolveOdooConfigForTenant } from '@/lib/engine-bindings'
import { readCustomer360 } from '@/lib/customer-360/odoo-projection'
import {
  composeDocumentMessage,
  isSendableKind,
  type SendableKind,
} from '@/lib/customer-360/document-message'
import { runCustomerAction } from '@/lib/governed/customer-actions'
import { buildConversationExecutors } from '@/lib/governed/executors/conversation'
import { createChatwootConversationSystem } from './chatwoot-conversation-system'
import { prismaLedgerStore } from '@/lib/operations/ledger'
import type { ChatwootContextHint } from '@/lib/customer-360/chatwoot-context'
import {
  LIFECYCLE_PRESENTATION,
  type ActionLifecycleState,
} from '@/lib/customer-workspace/contract'

export const revalidate = 0

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

function positiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(str(value))
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function parseHint(value: unknown): ChatwootContextHint | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const accountIdHint = positiveInt(input.accountIdHint)
  const inboxIdHint = positiveInt(input.inboxIdHint)
  const conversationDisplayIdHint = positiveInt(input.conversationDisplayIdHint)
  return accountIdHint && inboxIdHint && conversationDisplayIdHint
    ? { accountIdHint, inboxIdHint, conversationDisplayIdHint }
    : null
}

/** Session role → the governed runtime's role vocabulary. Defaults DOWN. */
function actorRoleFor(isAdmin: boolean, homeOwner: boolean, membershipRole: string | null): string {
  if (isAdmin || homeOwner) return 'owner'
  return membershipRole === 'manager' || membershipRole === 'owner' ? 'manager' : 'staff'
}

/**
 * A refusal that is about the ACTION, reported the house way: 200 + lifecycle.
 *
 * `label` is included because the panel's badge formats `Not sent — ${label}`
 * and falls back to the literal 'Not sent' when the field is absent. Omitting it
 * made every route-level refusal render as "Not sent — Not sent", which names
 * nothing: a permission refusal, a stale document and an unreachable Odoo all
 * read identically on the row. The settled dialog still carries the full detail;
 * this is so the ROW says which kind of refusal it was.
 */
function refusal(lifecycle: ActionLifecycleState, detail: string) {
  // Typed, not `string`, so a lifecycle that has no presentation entry cannot be
  // introduced at a call site. Untyped, someone adding a new refusal kind gets a
  // clean typecheck, no failing test, and a silent return to "Not sent — Not
  // sent" — the exact defect this function was changed to remove.
  const label = LIFECYCLE_PRESENTATION[lifecycle]?.label ?? 'Not sent'
  return NextResponse.json(
    { lifecycle, success: false, label, detail, operationId: null, readbackProven: false },
    { status: 200 },
  )
}

interface ResolvedDoor {
  base_url: string
  account_id: string
  inbox_id: string | null
  token: string
}

type DoorResolution =
  | { ok: true; binding: ResolvedDoor }
  // `kind` is the lifecycle this refusal will be reported as, so it carries the
  // same type the refusal helper demands rather than a bare string.
  | { ok: false; kind: ActionLifecycleState; detail: string }

/**
 * Resolve the Chatwoot door for a conversation FROM THE CONVERSATION ITSELF.
 *
 * Never from the browser. The caller's hint may then be compared against this
 * result, but it can only ever DISAGREE and cause a refusal — it can never
 * select the door.
 *
 * Two sources, in order of authority:
 *   1. chatwoot_binding_id — the explicit link. Preferred whenever present.
 *   2. chatwoot_inbox_id   — the conversation's own inbox. Used when the binding
 *      link is null, which is every existing row as measured 2026-08-28. It must
 *      resolve to EXACTLY ONE binding for this tenant; two candidates means the
 *      door is genuinely ambiguous and the honest answer is to refuse, not to
 *      pick the first.
 *
 * Neither present → refuse. A conversation whose door cannot be established is
 * a conversation we cannot prove we are allowed to speak into.
 */
async function resolveConversationDoor(
  tenantId: string,
  conversation: { chatwoot_binding_id: string | null; chatwoot_inbox_id: string | null },
): Promise<DoorResolution> {
  const select = { base_url: true, account_id: true, inbox_id: true, token: true } as const

  if (conversation.chatwoot_binding_id) {
    const binding = await prisma.chatwootBinding.findFirst({
      where: { id: conversation.chatwoot_binding_id, tenant_id: tenantId },
      select,
    })
    if (!binding) {
      return {
        ok: false,
        kind: 'permission_denied',
        detail:
          'This conversation’s Chatwoot connection does not belong to the current Isola workspace. Nothing was sent.',
      }
    }
    return { ok: true, binding }
  }

  if (conversation.chatwoot_inbox_id) {
    const candidates = await prisma.chatwootBinding.findMany({
      where: { tenant_id: tenantId, inbox_id: conversation.chatwoot_inbox_id },
      select,
      take: 2,
    })
    if (candidates.length === 1) return { ok: true, binding: candidates[0] }
    return {
      ok: false,
      kind: candidates.length === 0 ? 'permission_denied' : 'validation_failed',
      detail:
        candidates.length === 0
          ? 'This conversation’s Chatwoot inbox is not linked to the current Isola workspace. Nothing was sent.'
          : 'This conversation’s Chatwoot inbox matches more than one connection, so the destination is not certain. Nothing was sent.',
    }
  }

  return {
    ok: false,
    kind: 'validation_failed',
    detail:
      'This conversation is not linked to a Chatwoot connection, so there is no verified place to send it. Nothing was sent.',
  }
}

export async function POST(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '')
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const membershipRole = await getMembershipRole(ctx.identityId, ctx.effectiveTenantId)
  const homeOwner = ctx.user.tenant_id === ctx.effectiveTenantId && ctx.isOwner
  if (!ctx.isAdmin && !homeOwner && !membershipRole) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const tenantId = ctx.effectiveTenantId

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 })

  const hint = parseHint(body.hint)
  if (!hint) return NextResponse.json({ error: 'Invalid Chatwoot context' }, { status: 400 })

  const documentId = positiveInt(body.documentId)
  if (documentId === null) {
    return NextResponse.json({ error: 'documentId is required' }, { status: 400 })
  }

  const documentKind = str(body.documentKind)
  if (!isSendableKind(documentKind)) {
    return NextResponse.json(
      { error: 'documentKind must be quotation or invoice' },
      { status: 400 },
    )
  }

  const preview = body.preview === true

  // Required for a send, meaningless for a preview. Demanded rather than minted:
  // a key generated here would be new on every retry, which is the opposite of
  // what a key is for.
  const idempotencyKey = str(body.idempotencyKey)
  if (!preview && !idempotencyKey) {
    return NextResponse.json({ error: 'idempotencyKey is required' }, { status: 400 })
  }

  // ── Boundary 1: the conversation exists in THIS workspace's mirror. ────────
  //
  // Resolved FIRST, because the conversation — not the browser — is the
  // authority on which Chatwoot door this customer's messages belong behind.
  const conversation = await prisma.conversation.findFirst({
    where: { tenant_id: tenantId, chatwoot_conversation_id: hint.conversationDisplayIdHint },
    select: {
      customer_phone: true,
      chatwoot_binding_id: true,
      chatwoot_inbox_id: true,
      messages: {
        where: { role: 'user' },
        orderBy: { created_at: 'desc' },
        take: 1,
        select: { content: true },
      },
    },
  })
  if (!conversation) {
    return refusal(
      'permission_denied',
      'This conversation has not reached the Isola customer mirror. Nothing was sent.',
    )
  }

  // ── Boundary 2: the door is THE CONVERSATION'S OWN door. ───────────────────
  //
  // This route previously resolved the binding by tenant + account + inbox with
  // BOTH the account and the inbox taken from the browser hint, and never
  // compared the result against the conversation. Each check passed alone and
  // nothing tied them together: a tenant may hold more than one active binding
  // (ChatwootBinding's CW00 note), so a caller could pair door B with a
  // conversation belonging to door A and the message would be delivered into a
  // DIFFERENT customer's conversation while every tenant check still passed.
  //
  // schema.prisma states the rule for Conversation.chatwoot_binding_id: resolve
  // "the Chatwoot account/inbox from chatwoot_binding_id only, and fail closed
  // when it is null (legacy row) or inconsistent". app/api/customer/escalate/
  // route.ts already does this, after two live incidents in July 2026.
  //
  // MEASURED 2026-08-28: chatwoot_binding_id is NULL on every existing mirror
  // row, so binding-id-only would refuse every send including the working path.
  // chatwoot_inbox_id IS populated and is equally the conversation's own record,
  // so it is the documented fallback. What is never accepted is the hint.
  const doorFromConversation = await resolveConversationDoor(tenantId, conversation)
  if (!doorFromConversation.ok) return refusal(doorFromConversation.kind, doorFromConversation.detail)
  const binding = doorFromConversation.binding

  // The hint is now only a CLAIM about where the caller believes they are. If it
  // disagrees with the conversation's own door, that is caller confusion or an
  // attempt — never something to resolve silently in either direction.
  if (
    binding.account_id !== String(hint.accountIdHint) ||
    (binding.inbox_id ?? '') !== String(hint.inboxIdHint)
  ) {
    return refusal(
      'validation_failed',
      'This conversation belongs to a different Chatwoot inbox than the one this panel is open on. Nothing was sent.',
    )
  }

  // ── Boundary 3: the document belongs to THAT conversation's customer. ──────
  let snapshot
  try {
    const config = await resolveOdooConfigForTenant(tenantId)
    snapshot = await readCustomer360(config, conversation.customer_phone, {
      displayId: hint.conversationDisplayIdHint,
      currentRequest: conversation.messages[0]?.content ?? null,
    })
  } catch {
    return refusal(
      'dependency_unavailable',
      'Odoo is not answering, so the document could not be verified. Nothing was sent.',
    )
  }
  if (!snapshot) {
    return refusal(
      'validation_failed',
      'No Odoo customer matched this conversation. Nothing was sent.',
    )
  }

  const document = snapshot.documents.find(
    (d) => d.id === documentId && d.kind === (documentKind as SendableKind),
  )
  if (!document) {
    // "Not this customer's" and "does not exist" collapse into ONE wording, so a
    // caller cannot use this endpoint to enumerate another customer's records.
    return refusal(
      'validation_failed',
      'That document is not available on this customer. Nothing was sent.',
    )
  }

  const composed = composeDocumentMessage(document, snapshot.customer.name, snapshot.customer.isCompany)
  if (!composed) {
    return refusal(
      'validation_failed',
      'This document is missing a verified amount or currency, so it cannot be sent. Open it in Odoo and check the total.',
    )
  }

  // ── Preview stops here. Nothing claimed, nothing written, nothing sent. ────
  if (preview) {
    return NextResponse.json(
      {
        preview: true,
        body: composed.body,
        fingerprint: composed.fingerprint,
        documentReference: composed.documentReference,
        documentKind: composed.documentKind,
        customerName: snapshot.customer.name,
        conversationDisplayId: hint.conversationDisplayIdHint,
      },
      { status: 200 },
    )
  }

  // ── The confirmation is bound to the exact bytes that were reviewed. ───────
  //
  // REQUIRED, not merely checked-when-present. This guard was previously
  // `if (previewFingerprint && ...)`, so omitting the field skipped it entirely
  // — and since a preview is not required either, a caller could execute a send
  // with NO HUMAN HAVING SEEN ANY VERSION OF THE TEXT. The action catalogue did
  // not list this field either, so anything built from the catalogue omitted it
  // by construction, which is the opposite of a guard: it protected exactly the
  // callers that already had a human in front of them, and nothing else.
  //
  // It is now required in three places that must agree — here, in the catalogue,
  // and in the executor's validate() — and the fingerprint travels IN the payload
  // so the ledger hashes it as part of the authorised arguments.
  //
  // A rule that names a consequence the system does not produce is a wish.
  const previewFingerprint = str(body.previewFingerprint)
  if (!previewFingerprint) {
    return refusal(
      'validation_failed',
      'This send was not confirmed against a reviewed message, so nothing was sent. Open the document and review the message before sending.',
    )
  }
  if (previewFingerprint !== composed.fingerprint) {
    return refusal(
      'argument_conflict',
      'This document changed in Odoo since you reviewed it, so nothing was sent. Close this and open it again to review the current version.',
    )
  }

  // An a2-mode binding stores '' and uses a bot token elsewhere. Sending with an
  // empty token would 401 at Chatwoot; refusing here names the real reason.
  if (!binding.token) {
    return refusal(
      'dependency_unavailable',
      'This workspace has no Chatwoot send credential configured. Nothing was sent.',
    )
  }

  const conversationSystem = createChatwootConversationSystem({
    baseUrl: binding.base_url,
    accountId: binding.account_id,
    token: binding.token,
  })

  const outcome = await runCustomerAction(
    {
      tenantId,
      companyId: tenantId,
      customerId: String(snapshot.customer.id),
      actionType: 'document.send',
      payload: {
        conversationId: hint.conversationDisplayIdHint,
        documentId: composed.documentId,
        documentKind: composed.documentKind,
        documentReference: composed.documentReference,
        body: composed.body,
        // Part of the authorised arguments, so the ledger's requestHash covers
        // the exact text a human approved — not just the document it was about.
        previewFingerprint: composed.fingerprint,
      },
      actorPrincipalId: ctx.user.id,
      actorRole: actorRoleFor(ctx.isAdmin, homeOwner, membershipRole),
      idempotencyKey,
      correlationId:
        str(body.correlationId) ||
        `s8w1-${hint.conversationDisplayIdHint}-${composed.documentId}`,
    },
    {
      ledger: prismaLedgerStore,
      executors: buildConversationExecutors(conversationSystem),
      now: () => new Date(),
    },
  )

  return NextResponse.json(
    {
      version: outcome.version,
      actionType: outcome.actionType,
      correlationId: outcome.correlationId,
      operationId: outcome.operationId,
      auditRef: outcome.auditRef,
      lifecycle: outcome.lifecycle,
      success: outcome.presentation.success,
      label: outcome.presentation.label,
      detail: outcome.detail,
      marker: outcome.presentation.marker,
      tone: outcome.presentation.tone,
      terminal: outcome.presentation.terminal,
      retryWrite: outcome.presentation.retryWrite,
      retryReadback: outcome.presentation.retryReadback,
      readbackProven: outcome.readbackProven,
      // On a replay, the message the customer already received and when. The
      // panel shows it instead of asserting it happened.
      priorReadback: outcome.priorReadback,
      documentReference: composed.documentReference,
    },
    { status: 200 },
  )
}
