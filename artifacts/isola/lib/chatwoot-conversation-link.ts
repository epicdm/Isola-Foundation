/**
 * Native Chatwoot conversation deep link — `${base}/app/accounts/${account}/conversations/${id}`,
 * the same shape as the `chatwootDeepLink` contract fixture and the one native-link pattern
 * Foundation already uses for a specific Chatwoot conversation (inbox-level links use
 * `/inbox/${inbox_id}` instead, see app/admin/tenants/[id]/page.tsx).
 */

/** Same base_url validity check as app/admin/tenants/[id]/page.tsx. */
function isUsableBase(u: unknown): u is string {
  if (typeof u !== 'string' || u.trim() === '') return false;
  try {
    const parsed = new URL(u.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const normalizeBase = (u: string) => u.trim().replace(/\/+$/, '');

export function buildChatwootConversationLink(input: {
  chatwootConversationId: number | null;
  chatwootBinding: { base_url: string; account_id: string } | null;
  canView: boolean;
}): string | null {
  if (!input.canView) return null;
  if (input.chatwootConversationId == null) return null;
  if (!input.chatwootBinding || !isUsableBase(input.chatwootBinding.base_url)) return null;
  return `${normalizeBase(input.chatwootBinding.base_url)}/app/accounts/${input.chatwootBinding.account_id}/conversations/${input.chatwootConversationId}`;
}
