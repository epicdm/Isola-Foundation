/**
 * Resolves a customer's Chatwoot conversation BY PHONE — the inverse
 * direction of bff-v2's `findCustomerByPhone` (Odoo-by-phone), named as the
 * missing piece in design/CUSTOMER-360-DESIGN-STUDY.md §6 and built for
 * Step B of the owner's 2026-09-04 build order.
 *
 * ORDERING IS THE FIX FOR CONV #42 ("mirror state hides a real customer"):
 * every caller of `resolveCustomerConversation` in this codebase reads the
 * customer from Odoo FIRST (customer-sources.ts's `readCustomer`) and only
 * then calls this with the phone Odoo returned. This module never accepts a
 * user-typed phone number and never decides whether a customer exists — it
 * only ever answers "does OUR OWN mirror of Chatwoot already have a
 * conversation for this real customer's real phone", which can come back
 * `found: false` for a perfectly real, perfectly existing customer who has
 * simply never messaged in yet. That is not an error; it is Law 23's
 * ambiguous-negative case handled correctly: absence of a mirror row is
 * never reported as absence of the customer.
 */

import { buildChatwootConversationLink } from './chatwoot-conversation-link'
import { prisma } from './prisma'

export interface ConversationResolution {
  found: boolean
  chatwootConversationId: number | null
  chatwootDeepLink: string | null
  status: string | null
  lastMessageAt: string | null
}

const NOT_FOUND: ConversationResolution = {
  found: false,
  chatwootConversationId: null,
  chatwootDeepLink: null,
  status: null,
  lastMessageAt: null,
}

/**
 * A handful of plausible stored formats for the same phone number, so the
 * lookup stays a bounded `IN (...)` query — same discipline as
 * customer-sources.ts's fixed-shape reads, never a caller-supplied filter.
 * Odoo's res.partner.phone and Chatwoot's WhatsApp contact phone have no
 * shared normalization contract between the two systems, so this compares
 * on the national significant number (last 10 digits) as well as the raw
 * and E.164 forms, rather than requiring byte-identical strings.
 */
export function phoneCandidates(rawPhone: string): string[] {
  const trimmed = rawPhone.trim()
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return []
  const out = new Set<string>([trimmed, `+${digits}`, digits])
  if (digits.length > 10) {
    const last10 = digits.slice(-10)
    out.add(last10)
    out.add(`+1${last10}`)
    out.add(`1${last10}`)
  } else if (digits.length === 10) {
    out.add(`+1${digits}`)
    out.add(`1${digits}`)
  }
  return [...out]
}

export async function resolveCustomerConversation(
  tenantId: string,
  customerPhone: string | null,
): Promise<ConversationResolution> {
  if (!customerPhone) return NOT_FOUND
  const candidates = phoneCandidates(customerPhone)
  if (candidates.length === 0) return NOT_FOUND

  const conversation = await prisma.conversation.findFirst({
    where: { tenant_id: tenantId, customer_phone: { in: candidates } },
    orderBy: { last_message_at: 'desc' },
    include: { chatwoot_binding: true },
  })
  if (!conversation) return NOT_FOUND

  const chatwootDeepLink = buildChatwootConversationLink({
    chatwootConversationId: conversation.chatwoot_conversation_id,
    chatwootBinding: conversation.chatwoot_binding
      ? {
          base_url: conversation.chatwoot_binding.base_url,
          account_id: conversation.chatwoot_binding.account_id,
          tenant_id: conversation.chatwoot_binding.tenant_id,
        }
      : null,
    conversationTenantId: conversation.tenant_id,
    canView: true,
  })

  return {
    found: true,
    chatwootConversationId: conversation.chatwoot_conversation_id,
    chatwootDeepLink,
    status: conversation.status,
    lastMessageAt: conversation.last_message_at ? conversation.last_message_at.toISOString() : null,
  }
}
