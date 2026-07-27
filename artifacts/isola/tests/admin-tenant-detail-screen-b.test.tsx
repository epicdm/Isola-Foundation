import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// SCREEN B — operator Contextual Tenant Workspace, /admin/tenants/[id].
// Executable contracts B1-B24. Ratified: dec-isola-v7-screen-b-operator-tenant-detail-2026-07-26.
//
// Behavioural wherever a behaviour can be observed; source assertions are used ONLY for
// forbidden-pattern proofs (B21-B23), which are statements about code that has no runtime
// signal, and for B24 which is a repository-state proof.

const { getSessionMock, prismaMock, getCurrentUsageMock, redirectMock, notFoundMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  prismaMock: { tenant: { findUnique: vi.fn() } },
  getCurrentUsageMock: vi.fn(),
  redirectMock: vi.fn(() => { throw new Error('NEXT_REDIRECT'); }),
  notFoundMock: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
}));

vi.mock('@/lib/session', () => ({ getSession: getSessionMock }));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/meter', () => ({ getCurrentUsage: getCurrentUsageMock }));
vi.mock('next/navigation', () => ({ redirect: redirectMock, notFound: notFoundMock }));
vi.mock('../app/admin/tenants/[id]/TenantActions', () => ({ TenantActions: () => <div>TENANT_ACTIONS</div> }));
vi.mock('../app/admin/tenants/[id]/VoiceProvisioning', () => ({ VoiceProvisioning: () => <div>VOICE_PROV</div> }));
vi.mock('../app/admin/tenants/[id]/CreateAgentButton', () => ({ CreateAgentButton: () => <div>CREATE_AGENT</div> }));
vi.mock('../app/admin/tenants/[id]/MagnusPlanCard', () => ({ MagnusPlanCard: () => <div>MAGNUS_PLAN</div> }));

import TenantDetailPage from '../app/admin/tenants/[id]/page';

const SOURCE = readFileSync(join(__dirname, '..', 'app', 'admin', 'tenants', '[id]', 'page.tsx'), 'utf8');

// Mirrors the real Prisma ChatwootBinding model: id, tenant_id, agent_id, base_url,
// account_id, token, inbox_id, mode, timestamps. There is NO is_active field.
function binding(over: Record<string, unknown> = {}) {
  return {
    id: 'cb_' + Math.random().toString(36).slice(2, 8),
    tenant_id: 't1',
    agent_id: null,
    base_url: 'https://inbox.epic.dm',
    account_id: '5',
    token: '',
    inbox_id: '3',
    mode: 'a2',
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

function tenant(over: Record<string, unknown> = {}) {
  return {
    id: 't1',
    business_name: 'Acme Ltd',
    status: 'active',
    plan: 'sfd',
    created_at: new Date(),
    magnus_user_id: null,
    magnus_sip_id: null, magnus_sip_username: null, magnus_did_id: null, magnus_did_number: null,
    magnus_diddestination_id: null, magnus_callerid_id: null,
    voice_provisioning_state: 'none', voice_provisioning_error: null,
    subscription: null, wallet: null, agents: [], whatsapp_numbers: [], users: [],
    chatwoot_bindings: [],
    _count: { conversations: 7, wallet_txns: 0, audit_logs: 4 },
    ...over,
  };
}

async function render(over: Record<string, unknown> = {}, session: unknown = { isAdmin: true, user: { act_as_tenant_id: null } }) {
  getSessionMock.mockResolvedValue(session);
  prismaMock.tenant.findUnique.mockResolvedValue(tenant(over));
  getCurrentUsageMock.mockResolvedValue({ tokens_used: 10, tokens_cost: 1, minutes_used: 2, minutes_cost: 3 });
  return renderToStaticMarkup(await TenantDetailPage({ params: Promise.resolve({ id: 't1' }) }));
}

beforeEach(() => vi.clearAllMocks());

describe('Screen B — authorization and identity', () => {
  it('B1: a non-admin is denied and no tenant is read', async () => {
    getSessionMock.mockResolvedValue({ isAdmin: false, user: {} });
    await expect(TenantDetailPage({ params: Promise.resolve({ id: 't1' }) })).rejects.toThrow('NEXT_REDIRECT');
    expect(redirectMock).toHaveBeenCalledWith('/');
    expect(prismaMock.tenant.findUnique).not.toHaveBeenCalled();
  });

  it('B1b: an unauthenticated visitor is denied', async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(TenantDetailPage({ params: Promise.resolve({ id: 't1' }) })).rejects.toThrow('NEXT_REDIRECT');
    expect(prismaMock.tenant.findUnique).not.toHaveBeenCalled();
  });

  it('B2: an unknown tenant returns not found', async () => {
    getSessionMock.mockResolvedValue({ isAdmin: true, user: {} });
    prismaMock.tenant.findUnique.mockResolvedValue(null);
    getCurrentUsageMock.mockResolvedValue(null);
    await expect(TenantDetailPage({ params: Promise.resolve({ id: 'nope' }) })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('B3: the read is scoped to the requested tenant id only — no cross-tenant fan-out', async () => {
    await render();
    expect(prismaMock.tenant.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.tenant.findUnique.mock.calls[0][0].where).toEqual({ id: 't1' });
    expect(getCurrentUsageMock).toHaveBeenCalledWith('t1');
  });
});

describe('Screen B — tenant status governs Chatwoot actions', () => {
  it('B4: a non-active tenant gets no Chatwoot action', async () => {
    const html = await render({ status: 'retired', chatwoot_bindings: [binding()] });
    expect(html).not.toContain('href="https://inbox.epic.dm');
    expect(html).toContain('Chatwoot actions are withheld');
  });

  it('B5: zero doors renders an honest unavailable state, not an empty success', async () => {
    const html = await render({ chatwoot_bindings: [] });
    expect(html).toContain('Unavailable');
    expect(html).toContain('No Chatwoot binding for this tenant.');
  });
});

describe('Screen B — door resolution', () => {
  it('B6: distinct door keys render deterministically, sorted and independent', async () => {
    const html = await render({ chatwoot_bindings: [
      binding({ account_id: '9', inbox_id: '44' }),
      binding({ account_id: '5', inbox_id: '3' }),
    ] });
    const a = html.indexOf('/app/accounts/5/inbox/3');
    const b = html.indexOf('/app/accounts/9/inbox/44');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(b); // '5|3|a2' sorts before '9|44|a2'
  });

  it('B7: an exact duplicate (account_id, inbox_id, mode) fails closed for that door', async () => {
    const html = await render({ chatwoot_bindings: [binding(), binding()] });
    expect(html).not.toContain('href="https://inbox.epic.dm');
    expect(html).toContain('Duplicate Chatwoot door registration');
    expect(html).toContain('2 duplicate registrations');
  });

  it('B8/B9: a duplicate whose second row has a blank base_url still counts as a duplicate', async () => {
    // The regression this pins: filtering for a usable base_url BEFORE counting would drop the
    // blank row, collapse the pair to one apparent winner, and render a live link.
    const html = await render({ chatwoot_bindings: [binding(), binding({ base_url: '' })] });
    expect(html).toContain('Duplicate Chatwoot door registration');
    expect(html).not.toContain('href="https://inbox.epic.dm');
  });

  it('B10/B11: an invalid base_url yields no action and a deterministic warning', async () => {
    const html = await render({ chatwoot_bindings: [binding({ base_url: '   ' })] });
    expect(html).not.toContain('href="https://');
    expect(html).toContain('no usable base_url');
    expect(html).toContain('has a blank or invalid base_url');
  });

  it('B12: the link is built from the binding base_url', async () => {
    const html = await render({ chatwoot_bindings: [binding({ base_url: 'https://chat.example.org' })] });
    expect(html).toContain('href="https://chat.example.org/app/accounts/5/inbox/3"');
  });

  it('B13: no environment fallback is consulted', async () => {
    process.env.NEXT_PUBLIC_CHATWOOT_BASE_URL = 'https://should-never-appear.example';
    const html = await render({ chatwoot_bindings: [binding({ base_url: '' })] });
    expect(html).not.toContain('should-never-appear.example');
    // Assert no USE of the env var. The identifier appears in a comment documenting that it is
    // deliberately not consulted, so a bare substring check would fail on its own documentation.
    expect(SOURCE).not.toMatch(/process\.env\.NEXT_PUBLIC_CHATWOOT_BASE_URL/);
    delete process.env.NEXT_PUBLIC_CHATWOOT_BASE_URL;
  });

  it('B14: trailing slashes are normalized', async () => {
    const html = await render({ chatwoot_bindings: [binding({ base_url: 'https://inbox.epic.dm///' })] });
    expect(html).toContain('href="https://inbox.epic.dm/app/accounts/5/inbox/3"');
    expect(html).not.toContain('inbox.epic.dm///app');
  });

  it('B14b: surrounding whitespace is trimmed, so a door marked ok never yields a malformed link', async () => {
    // The regression this pins: isUsableBase validates u.trim(), so a padded base_url passed
    // validation and the door was marked `ok` — but the link was composed from the UNTRIMMED
    // value, producing a broken host/path on a door the operator was told was usable.
    // Validation and composition must agree on the same string.
    const html = await render({ chatwoot_bindings: [binding({ base_url: '  https://inbox.epic.dm  ' })] });
    expect(html).toContain('href="https://inbox.epic.dm/app/accounts/5/inbox/3"');
    expect(html).not.toContain('no usable base_url');
    expect(html).not.toMatch(/href="\s+https/);
    expect(html).not.toContain('inbox.epic.dm  /app');
  });

  it('B14c: whitespace and trailing slashes normalize together', async () => {
    const html = await render({ chatwoot_bindings: [binding({ base_url: '\t https://inbox.epic.dm//  ' })] });
    expect(html).toContain('href="https://inbox.epic.dm/app/accounts/5/inbox/3"');
  });

  it('B14d: a whitespace-only base_url is still INVALID, not a trimmed-away pass', async () => {
    // Trimming must not turn a blank door into a usable one: '   ' trims to '' and stays invalid.
    const html = await render({ chatwoot_bindings: [binding({ base_url: '  \t ' })] });
    expect(html).toContain('no usable base_url');
    expect(html).not.toContain('href="https://');
  });

  it('B15: only absolute http(s) bases are usable', async () => {
    for (const bad of ['ftp://inbox.epic.dm', '/app/accounts', 'inbox.epic.dm', 'javascript:alert(1)']) {
      const html = await render({ chatwoot_bindings: [binding({ base_url: bad })] });
      expect(html).toContain('no usable base_url');
    }
    const ok = await render({ chatwoot_bindings: [binding({ base_url: 'http://inbox.epic.dm' })] });
    expect(ok).toContain('href="http://inbox.epic.dm/app/accounts/5/inbox/3"');
  });

  it('B16: a null-inbox registration is not a door and generates no action', async () => {
    const html = await render({ chatwoot_bindings: [binding({ inbox_id: null })] });
    expect(html).not.toContain('/app/accounts/');
    expect(html).toContain('with no inbox');
    expect(html).not.toContain('Duplicate Chatwoot door registration');
  });

  it('B16b: a null-inbox registration is never a duplicate of a real door', async () => {
    const html = await render({ chatwoot_bindings: [binding(), binding({ inbox_id: null })] });
    expect(html).toContain('href="https://inbox.epic.dm/app/accounts/5/inbox/3"');
    expect(html).not.toContain('Duplicate Chatwoot door registration');
  });
});

describe('Screen B — conversation and call truth', () => {
  it('B17: the inbox-level action is labelled "Open Chatwoot inbox"', async () => {
    const html = await render({ chatwoot_bindings: [binding()] });
    expect(html).toContain('Open Chatwoot inbox');
  });

  // Asserts the label sits INSIDE a <button ... disabled ...> element, rather than merely
  // near the word "disabled" — a window-based check passes on unrelated nearby markup.
  const disabledButtonContaining = (html: string, label: string) =>
    new RegExp(`<button[^>]*\\bdisabled\\b[^>]*>(?:(?!</button>)[\\s\\S])*${label.replace(/[()]/g, '\\$&')}`).test(html);

  it('B18: "View full conversation" ships disabled', async () => {
    const html = await render({ chatwoot_bindings: [binding()] });
    expect(html).toContain('View full conversation');
    expect(disabledButtonContaining(html, 'View full conversation')).toBe(true);
  });

  it('B19: Call ships disabled', async () => {
    const html = await render();
    expect(html).toContain('Call (unavailable)');
    expect(disabledButtonContaining(html, 'Call (unavailable)')).toBe(true);
  });

  it('B20: the Foundation count is labelled a local mirror', async () => {
    const html = await render({ chatwoot_bindings: [binding()] });
    expect(html).toContain('local mirror');
    expect(html).toContain('stores no second copy');
    expect(html).toContain('offers no second inbox');
  });

  it('B20b: Odoo-backed panels state honestly that no adapter exists', async () => {
    const html = await render();
    expect(html).toContain('Products and services');
    expect(html).toContain('no Odoo product/service adapter exists');
    expect(html).toContain('no Odoo invoice adapter exists');
  });
});

describe('Screen B — forbidden patterns (source proofs)', () => {
  it('B21: no binding-level is_active is read', () => {
    expect(SOURCE).not.toMatch(/binding\.is_active|b\.is_active|is_active:\s*true/);
  });

  it('B22: no account-only resolution', () => {
    expect(SOURCE).not.toMatch(/where:\s*\{\s*account_id\s*:/);
  });

  it('B23: no findFirst CALL on this screen', () => {
    // The identifier appears in a comment stating findFirst is not used; assert on the call form.
    expect(SOURCE).not.toMatch(/\.findFirst\s*\(/);
  });

  it('B23b: duplicate counting precedes base_url validation in source order', () => {
    const counted = SOURCE.indexOf('const keyCounts');
    const filtered = SOURCE.indexOf('isUsableBase(first.base_url)');
    expect(counted).toBeGreaterThanOrEqual(0);
    expect(filtered).toBeGreaterThan(counted);
  });
});

describe('Screen B — scope boundary', () => {
  it('B24: owner /workspace is not this screen and is untouched by it', () => {
    const owner = readFileSync(join(__dirname, '..', 'app', '(owner)', 'workspace', 'page.tsx'), 'utf8');
    expect(owner).not.toContain('chatwoot_bindings');
    expect(owner).not.toContain('Open Chatwoot inbox');
    expect(SOURCE).toContain('Owner /workspace is the generic owner work queue');
  });
});
