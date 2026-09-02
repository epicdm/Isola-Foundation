/**
 * Native Chatwoot conversation deep link — `${base}/app/accounts/${account}/conversations/${id}`,
 * the same shape as the `chatwootDeepLink` contract fixture and the one native-link pattern
 * Foundation already uses for a specific Chatwoot conversation (inbox-level links use
 * `/inbox/${inbox_id}` instead, see app/admin/tenants/[id]/page.tsx).
 */

/**
 * Same base_url validity check as app/admin/tenants/[id]/page.tsx, plus a
 * rejection this callsite needs that the admin page's inbox-link builder does
 * not: a query string or fragment on base_url would be silently absorbed into
 * the appended `/app/accounts/.../conversations/...` suffix by plain string
 * concatenation, producing a link that does not open the bound conversation.
 */
function isUsableBase(u: unknown): u is string {
  if (typeof u !== 'string' || u.trim() === '') return false;
  const trimmed = u.trim();
  // Checked on the raw string, not `.search`/`.hash`: a bare trailing `?` or
  // `#` with nothing after it (e.g. "https://host?") parses to an EMPTY
  // search/hash in the WHATWG URL model, so those getters would pass it
  // through — but the delimiter is still in `.href`, and string-concatenating
  // the conversation path onto it lands inside the query/fragment instead of
  // the path.
  if (trimmed.includes('?') || trimmed.includes('#')) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const normalizeBase = (u: string) => u.trim().replace(/\/+$/, '');

/**
 * Chatwoot account ids are opaque path segments, not free text. A binding row
 * carrying anything else (a slash, `..`, a query/fragment character) must fail
 * closed rather than let the stored value redirect the link outside
 * `/app/accounts/{account}/conversations/{id}`.
 */
const isSafePathSegment = (v: string) => /^[A-Za-z0-9_-]+$/.test(v);

export function buildChatwootConversationLink(input: {
  chatwootConversationId: number | null;
  chatwootBinding: { base_url: string; account_id: string; tenant_id: string } | null;
  conversationTenantId: string;
  canView: boolean;
}): string | null {
  if (!input.canView) return null;
  if (input.chatwootConversationId == null) return null;
  if (!input.chatwootBinding) return null;
  // The binding relation is resolved by chatwoot_binding_id alone (see
  // prisma/schema.prisma Conversation.chatwoot_binding_id) — it is not scoped
  // to the conversation's own tenant_id by the query itself. A row pointing at
  // another tenant's binding must never build that tenant's Chatwoot URL.
  if (input.chatwootBinding.tenant_id !== input.conversationTenantId) return null;
  if (!isUsableBase(input.chatwootBinding.base_url)) return null;
  if (!isSafePathSegment(input.chatwootBinding.account_id)) return null;
  return `${normalizeBase(input.chatwootBinding.base_url)}/app/accounts/${input.chatwootBinding.account_id}/conversations/${input.chatwootConversationId}`;
}
