/**
 * The Chatwoot -> portal link-out. Ruled 2026-09-06
 * (dec-one-customer-workspace-mounted-twice-2026-09-06): no Chatwoot
 * Dashboard App has ever worked in this org (defect-dashboard-app-
 * architecture-gap-2026-08-21) — the one iframe-registration attempt was
 * abandoned. This is the honest, shippable-today substitute: a private note
 * in the conversation, scoped to that conversation's own contact, one click
 * to the SAME customer workspace component the portal already mounts. It is
 * NOT the 360 tab living inside Chatwoot the owner originally asked for —
 * say so plainly wherever this is described.
 *
 * Same URL-safety discipline as chatwoot-conversation-link.ts (the reverse
 * direction: portal -> Chatwoot), because a private note is still a link an
 * agent will click without re-checking it.
 */

function isUsableBase(u: unknown): u is string {
  if (typeof u !== 'string' || u.trim() === '') return false
  const trimmed = u.trim()
  if (trimmed.includes('?') || trimmed.includes('#')) return false
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

const normalizeBase = (u: string) => u.trim().replace(/\/+$/, '')

/**
 * Odoo customer ids are positive integers. A caller-supplied or
 * malformed value must never reach a string-concatenated URL.
 */
function isSafeCustomerId(id: number): boolean {
  return Number.isInteger(id) && id > 0
}

export function buildWorkspaceLink(baseUrl: unknown, customerId: number): string | null {
  if (!isUsableBase(baseUrl)) return null
  if (!isSafeCustomerId(customerId)) return null
  return `${normalizeBase(baseUrl)}/customer/${customerId}`
}

/** The fixed marker every posted note carries, so a redelivered webhook
 *  event (or Chatwoot's own retry) can recognise a note already posted for
 *  this conversation and skip posting a second one — no new schema, no new
 *  persistent state, just a read-before-write against Chatwoot itself. */
export const WORKSPACE_LINK_MARKER = 'Isola customer workspace:'

export function workspaceLinkNoteContent(link: string): string {
  return `${WORKSPACE_LINK_MARKER} ${link}`
}
