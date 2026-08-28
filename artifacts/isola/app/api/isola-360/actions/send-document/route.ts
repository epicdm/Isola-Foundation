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
 * Three independent checks, all against this session's tenant and none against a
 * value the browser supplied: the Chatwoot door must be bound to this workspace,
 * the conversation must exist in this workspace's mirror, and the document must
 * appear in the Odoo snapshot for THAT conversation's customer. A document id
 * belonging to another customer is therefore unsendable even if guessed.
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
import { createChatwootConversationSystem } from '@/lib/governed/executors/chatwoot-conversation-system'
import { prismaLedgerStore } from '@/lib/operations/ledger'
import type { ChatwootContextHint } from '@/lib/customer-360/chatwoot-context'

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

/** A refusal that is about the ACTION, reported the house way: 200 + lifecycle. */
function refusal(lifecycle: string, detail: string) {
  return NextResponse.json(
    { lifecycle, success: false, detail, operationId: null, readbackProven: false },
    { status: 200 },
  )
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

  // ── Boundary 1: the Chatwoot door belongs to THIS workspace. ───────────────
  const binding = await prisma.chatwootBinding.findFirst({
    where: {
      tenant_id: tenantId,
      account_id: String(hint.accountIdHint),
      inbox_id: String(hint.inboxIdHint),
    },
    select: { base_url: true, account_id: true, token: true },
  })
  if (!binding) {
    return refusal(
      'permission_denied',
      'This Chatwoot inbox is not linked to the current Isola workspace. Nothing was sent.',
    )
  }

  // ── Boundary 2: the conversation exists in THIS workspace's mirror. ────────
  const conversation = await prisma.conversation.findFirst({
    where: { tenant_id: tenantId, chatwoot_conversation_id: hint.conversationDisplayIdHint },
    select: {
      customer_phone: true,
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

  const composed = composeDocumentMessage(document, snapshot.customer.name)
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
  const previewFingerprint = str(body.previewFingerprint)
  if (previewFingerprint && previewFingerprint !== composed.fingerprint) {
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
      documentReference: composed.documentReference,
    },
    { status: 200 },
  )
}
