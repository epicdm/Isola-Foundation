import { beforeEach, describe, expect, it, vi } from 'vitest';

const { json2Call, findUniqueOdooBinding, decryptSecretMock } = vi.hoisted(() => ({
  json2Call: vi.fn(),
  findUniqueOdooBinding: vi.fn(),
  decryptSecretMock: vi.fn(),
}));

vi.mock('@/engines/odoo', () => ({
  json2Call: (...args: unknown[]) => json2Call(...args),
  // Unused by this module directly, but lib/context/customer-sources.ts
  // (imported transitively for odooDeepLink) reads it at module scope —
  // same note as lib/customer-360/odoo-projection.test.ts.
  findCustomerByPhone: vi.fn(),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: { odooBinding: { findUnique: findUniqueOdooBinding } },
}));
vi.mock('@/lib/tenant-secrets', () => ({
  decryptSecret: (...args: unknown[]) => decryptSecretMock(...args),
}));
// The REAL checkOdooPolicy is a pure function with its own dedicated test
// coverage (lib/agent-tools.test.ts). Importing lib/agent-tools.ts for real
// here would also pull in lib/connector.ts's full engine surface, which this
// module never touches — mock just the one function this module reuses.
vi.mock('@/lib/agent-tools', () => ({
  checkOdooPolicy: vi.fn(),
}));

import { getBusinessBriefing } from './business-briefing';

const TENANT = 'tenant-1';
const BINDING = { tenant_id: TENANT, url: 'https://epic.odoo.com', db: 'epic', login: 'a@b.test', api_key_enc: 'enc', instance_type: 'hosted_saas' };
const AUTHORIZED_COMPANY_ID = 1;

/** The single-company `res.users` answer that makes a scope resolvable. Real
 *  fixtures should never need to touch this unless testing scope resolution
 *  itself — pass it through `json2Call`'s `res.users` branch. `login` matches
 *  `BINDING.login` so the defense-in-depth cross-check passes by default. */
const SCOPED_USER_ROW = { id: 42, login: BINDING.login, company_id: [AUTHORIZED_COMPANY_ID, 'Company A'], company_ids: [AUTHORIZED_COMPANY_ID] };

/** The `res.users/context_get` answer resolveBearerUserId reads — the
 *  credential's OWN identity, never a Foundation-stored value. Matches
 *  SCOPED_USER_ROW.id by default so the two calls agree. */
const SCOPED_CONTEXT_GET = { uid: SCOPED_USER_ROW.id, lang: 'en_US', tz: 'UTC' };

/** Wraps a model-keyed responder with the standard scoped `res.users`
 *  answers (both `context_get` and `search_read`) so every existing fixture
 *  doesn't have to repeat them. */
function withScopedUser(byModel: (model: string) => unknown) {
  return async (_config: unknown, model: string, method: string) => {
    if (model === 'res.users' && method === 'context_get') return SCOPED_CONTEXT_GET;
    if (model === 'res.users' && method === 'search_read') return [SCOPED_USER_ROW];
    return byModel(model);
  };
}

describe('getBusinessBriefing', () => {
  beforeEach(() => {
    json2Call.mockReset();
    findUniqueOdooBinding.mockReset();
    decryptSecretMock.mockReset();
    decryptSecretMock.mockReturnValue('plain-api-key');
  });

  it('reports unavailable, never a fabricated report, when the tenant has no OdooBinding — and NEVER falls back to a platform-default credential', async () => {
    findUniqueOdooBinding.mockResolvedValue(null);

    const briefing = await getBusinessBriefing(TENANT);

    expect(briefing.odooConnected).toBe(false);
    expect(briefing.sections).toEqual([
      { id: 'overdue_receivables', title: 'Overdue receivables', state: 'unavailable', reason: 'no_odoo_connected_for_tenant', rows: [] },
      { id: 'open_opportunities', title: 'Open opportunities', state: 'unavailable', reason: 'no_odoo_connected_for_tenant', rows: [] },
    ]);
    expect(json2Call).not.toHaveBeenCalled();
  });

  it('returns real rows with source links when Odoo answers, scoped to the tenant\'s own binding', async () => {
    findUniqueOdooBinding.mockResolvedValue(BINDING);
    json2Call.mockImplementation(async (config: unknown, model: string, method: string) => {
      expect((config as { url: string }).url).toBe(BINDING.url);
      if (model === 'res.users' && method === 'context_get') return SCOPED_CONTEXT_GET;
      if (model === 'res.users' && method === 'search_read') return [SCOPED_USER_ROW];
      if (model === 'account.move') {
        return [{ id: 9, name: 'INV/9', partner_id: [3, 'EPIC Customer'], amount_residual: 125.5, currency_id: [1, 'XCD'], invoice_date_due: '2026-08-01', company_id: [AUTHORIZED_COMPANY_ID, 'Company A'] }];
      }
      if (model === 'crm.lead') {
        return [{ id: 10, name: 'Upgrade', partner_id: [3, 'EPIC Customer'], expected_revenue: 400, stage_id: [2, 'Qualified'], date_deadline: '2026-08-30', company_id: [AUTHORIZED_COMPANY_ID, 'Company A'] }];
      }
      throw new Error(`unexpected model ${model}`);
    });

    const briefing = await getBusinessBriefing(TENANT);

    expect(briefing.odooConnected).toBe(true);
    expect(decryptSecretMock).toHaveBeenCalledWith('enc');

    const overdue = briefing.sections.find((s) => s.id === 'overdue_receivables')!;
    expect(overdue.state).toBe('ok');
    expect(overdue.rows).toEqual([
      {
        id: 9,
        label: 'INV/9 — EPIC Customer',
        detail: '125.50 XCD outstanding, due 2026-08-01',
        sourceUrl: 'https://epic.odoo.com/odoo/account.move/9',
      },
    ]);

    const opportunities = briefing.sections.find((s) => s.id === 'open_opportunities')!;
    expect(opportunities.state).toBe('ok');
    expect(opportunities.rows[0].label).toBe('Upgrade — EPIC Customer');

    // CORRECTLY SCOPED: the resolved company was looked up via the BEARER
    // TOKEN'S OWN identity (context_get, no id — never a Foundation-stored
    // value), then applied as an explicit domain filter on every read — not
    // just checked after the fact.
    expect(json2Call).toHaveBeenCalledWith(expect.anything(), 'res.users', 'context_get', {}, expect.any(Number));
    expect(json2Call).toHaveBeenCalledWith(
      expect.anything(),
      'res.users',
      'search_read',
      expect.objectContaining({ domain: [['id', '=', SCOPED_USER_ROW.id]] }),
      expect.any(Number),
    );
    expect(json2Call).toHaveBeenCalledWith(
      expect.anything(),
      'account.move',
      'search_read',
      expect.objectContaining({ domain: expect.arrayContaining([['company_id', '=', AUTHORIZED_COMPANY_ID]]) }),
      expect.any(Number),
    );
    expect(json2Call).toHaveBeenCalledWith(
      expect.anything(),
      'crm.lead',
      'search_read',
      expect.objectContaining({ domain: expect.arrayContaining([['company_id', '=', AUTHORIZED_COMPANY_ID]]) }),
      expect.any(Number),
    );
  });

  it('reports a section unavailable, not empty, when the Odoo read itself fails — one section failing does not sink the other', async () => {
    findUniqueOdooBinding.mockResolvedValue(BINDING);
    json2Call.mockImplementation(async (_config: unknown, model: string, method: string) => {
      if (model === 'res.users' && method === 'context_get') return SCOPED_CONTEXT_GET;
      if (model === 'res.users' && method === 'search_read') return [SCOPED_USER_ROW];
      if (model === 'account.move') throw new Error('Odoo unreachable');
      return [];
    });

    const briefing = await getBusinessBriefing(TENANT);

    expect(briefing.odooConnected).toBe(true);
    expect(briefing.sections.find((s) => s.id === 'overdue_receivables')).toEqual({
      id: 'overdue_receivables',
      title: 'Overdue receivables',
      state: 'unavailable',
      reason: 'odoo_read_failed',
      rows: [],
    });
    expect(briefing.sections.find((s) => s.id === 'open_opportunities')?.state).toBe('ok');
  });

  it('never links to a non-https or self-declared-sandbox Odoo origin', async () => {
    findUniqueOdooBinding.mockResolvedValue({ ...BINDING, url: 'https://epic_sandbox.odoo.com' });
    json2Call.mockImplementation(withScopedUser((model) => {
      if (model === 'account.move') return [{ id: 1, name: 'INV/1', partner_id: [1, 'X'], amount_residual: 5, currency_id: [1, 'XCD'], invoice_date_due: '2026-08-01', company_id: [AUTHORIZED_COMPANY_ID, 'Company A'] }];
      return [];
    }));

    const briefing = await getBusinessBriefing(TENANT);
    const overdue = briefing.sections.find((s) => s.id === 'overdue_receivables')!;
    expect(overdue.state).toBe('ok');
    expect((overdue as { rows: { sourceUrl: string | null }[] }).rows[0].sourceUrl).toBeNull();
  });

  it('never sums residuals across rows/currencies — each row keeps its own currency in its own detail line', async () => {
    findUniqueOdooBinding.mockResolvedValue(BINDING);
    json2Call.mockImplementation(withScopedUser((model) => {
      if (model === 'account.move') {
        return [
          { id: 1, name: 'INV/1', partner_id: [1, 'A'], amount_residual: 100, currency_id: [1, 'XCD'], invoice_date_due: '2026-08-01', company_id: [AUTHORIZED_COMPANY_ID, 'Company A'] },
          { id: 2, name: 'INV/2', partner_id: [2, 'B'], amount_residual: 40, currency_id: [2, 'USD'], invoice_date_due: '2026-08-02', company_id: [AUTHORIZED_COMPANY_ID, 'Company A'] },
        ];
      }
      return [];
    }));

    const briefing = await getBusinessBriefing(TENANT);
    const overdue = briefing.sections.find((s) => s.id === 'overdue_receivables')!;
    expect((overdue as { rows: { detail: string }[] }).rows.map((r) => r.detail)).toEqual([
      '100.00 XCD outstanding, due 2026-08-01',
      '40.00 USD outstanding, due 2026-08-02',
    ]);
  });

  it('MIXED AUTHORIZED/UNAUTHORIZED: refuses a section outright (never a partial or blended rendering) when some rows match the authorized company and others do not', async () => {
    findUniqueOdooBinding.mockResolvedValue(BINDING);
    json2Call.mockImplementation(withScopedUser((model) => {
      if (model === 'account.move') {
        return [
          { id: 1, name: 'INV/1', partner_id: [1, 'A'], amount_residual: 100, currency_id: [1, 'XCD'], invoice_date_due: '2026-08-01', company_id: [AUTHORIZED_COMPANY_ID, 'Company A'] },
          { id: 2, name: 'INV/2', partner_id: [2, 'B'], amount_residual: 40, currency_id: [1, 'XCD'], invoice_date_due: '2026-08-02', company_id: [2, 'Company B'] },
        ];
      }
      // The other section is unaffected — one section's unauthorized rows never sink the other.
      return [{ id: 9, name: 'Lead', partner_id: [1, 'A'], expected_revenue: 10, stage_id: [1, 'New'], date_deadline: null, company_id: [AUTHORIZED_COMPANY_ID, 'Company A'] }];
    }));

    const briefing = await getBusinessBriefing(TENANT);

    expect(briefing.sections.find((s) => s.id === 'overdue_receivables')).toEqual({
      id: 'overdue_receivables',
      title: 'Overdue receivables',
      state: 'unavailable',
      reason: 'unauthorized_company_records',
      rows: [],
    });
    expect(briefing.sections.find((s) => s.id === 'open_opportunities')?.state).toBe('ok');
  });

  it('ONE UNAUTHORIZED COMPANY ONLY: refuses a section whose rows are internally consistent but entirely belong to a company the tenant is not authorized for', async () => {
    findUniqueOdooBinding.mockResolvedValue(BINDING);
    json2Call.mockImplementation(withScopedUser((model) => {
      if (model === 'account.move') {
        // Every row agrees with every other row — the OLD self-consistency
        // check would have passed this. All of them are Company B, and the
        // tenant is authorized for Company A (id 1) only.
        return [
          { id: 1, name: 'INV/1', partner_id: [1, 'A'], amount_residual: 100, currency_id: [1, 'XCD'], invoice_date_due: '2026-08-01', company_id: [2, 'Company B'] },
          { id: 2, name: 'INV/2', partner_id: [2, 'B'], amount_residual: 40, currency_id: [1, 'XCD'], invoice_date_due: '2026-08-02', company_id: [2, 'Company B'] },
        ];
      }
      return [];
    }));

    const briefing = await getBusinessBriefing(TENANT);

    expect(briefing.sections.find((s) => s.id === 'overdue_receivables')).toEqual({
      id: 'overdue_receivables',
      title: 'Overdue receivables',
      state: 'unavailable',
      reason: 'unauthorized_company_records',
      rows: [],
    });
  });

  it('a company-less row (company_id false) can never be proven authorized and refuses the section, not silently dropped', async () => {
    findUniqueOdooBinding.mockResolvedValue(BINDING);
    json2Call.mockImplementation(withScopedUser((model) => {
      if (model === 'crm.lead') {
        return [{ id: 9, name: 'Lead', partner_id: [1, 'A'], expected_revenue: 10, stage_id: [1, 'New'], date_deadline: null, company_id: false }];
      }
      return [];
    }));

    const briefing = await getBusinessBriefing(TENANT);
    expect(briefing.sections.find((s) => s.id === 'open_opportunities')).toEqual({
      id: 'open_opportunities',
      title: 'Open opportunities',
      state: 'unavailable',
      reason: 'unauthorized_company_records',
      rows: [],
    });
  });

  it('CORRECTLY SCOPED: rows that all match the resolved authorized company pass the guard', async () => {
    findUniqueOdooBinding.mockResolvedValue(BINDING);
    json2Call.mockImplementation(withScopedUser((model) => {
      if (model === 'account.move') {
        return [{ id: 1, name: 'INV/1', partner_id: [1, 'A'], amount_residual: 100, currency_id: [1, 'XCD'], invoice_date_due: '2026-08-01', company_id: [AUTHORIZED_COMPANY_ID, 'Company A'] }];
      }
      return [];
    }));

    const briefing = await getBusinessBriefing(TENANT);
    expect(briefing.sections.find((s) => s.id === 'overdue_receivables')?.state).toBe('ok');
  });

  describe('MISSING OR AMBIGUOUS AUTHORIZATION', () => {
    it('refuses both sections, without ever reading account.move/crm.lead, when the binding has no login to resolve a company from', async () => {
      findUniqueOdooBinding.mockResolvedValue({ ...BINDING, login: null });

      const briefing = await getBusinessBriefing(TENANT);

      expect(briefing.odooConnected).toBe(true);
      expect(briefing.sections).toEqual([
        { id: 'overdue_receivables', title: 'Overdue receivables', state: 'unavailable', reason: 'odoo_company_scope_unresolvable', rows: [] },
        { id: 'open_opportunities', title: 'Open opportunities', state: 'unavailable', reason: 'odoo_company_scope_unresolvable', rows: [] },
      ]);
      expect(json2Call).not.toHaveBeenCalled();
    });

    it('refuses both sections when Odoo has no res.users row for the bearer\'s resolved id (nothing to resolve)', async () => {
      findUniqueOdooBinding.mockResolvedValue(BINDING);
      json2Call.mockImplementation(async (_config: unknown, model: string, method: string) => {
        if (model === 'res.users' && method === 'context_get') return SCOPED_CONTEXT_GET;
        if (model === 'res.users' && method === 'search_read') return [];
        return [{ id: 999 }]; // must never be reached
      });

      const briefing = await getBusinessBriefing(TENANT);

      expect(briefing.sections.every((s) => s.state === 'unavailable' && s.reason === 'odoo_company_scope_unresolvable')).toBe(true);
    });

    it('refuses both sections when the bearer\'s id resolves to more than one res.users row (ambiguous identity)', async () => {
      findUniqueOdooBinding.mockResolvedValue(BINDING);
      json2Call.mockImplementation(async (_config: unknown, model: string, method: string) => {
        if (model === 'res.users' && method === 'context_get') return SCOPED_CONTEXT_GET;
        if (model === 'res.users' && method === 'search_read') return [SCOPED_USER_ROW, { ...SCOPED_USER_ROW, id: 43 }];
        return [{ id: 999 }];
      });

      const briefing = await getBusinessBriefing(TENANT);

      expect(briefing.sections.every((s) => s.state === 'unavailable' && s.reason === 'odoo_company_scope_unresolvable')).toBe(true);
    });

    it('refuses both sections when the credential is scoped to more than one company — cannot answer "which one is this tenant\'s own"', async () => {
      findUniqueOdooBinding.mockResolvedValue(BINDING);
      json2Call.mockImplementation(async (_config: unknown, model: string, method: string) => {
        if (model === 'res.users' && method === 'context_get') return SCOPED_CONTEXT_GET;
        if (model === 'res.users' && method === 'search_read') return [{ id: 42, login: BINDING.login, company_id: [1, 'Company A'], company_ids: [1, 2] }];
        return [{ id: 999 }];
      });

      const briefing = await getBusinessBriefing(TENANT);

      expect(briefing.sections.every((s) => s.state === 'unavailable' && s.reason === 'odoo_company_scope_unresolvable')).toBe(true);
    });

    it('refuses both sections when the res.users lookup itself fails — never treated as "no restriction"', async () => {
      findUniqueOdooBinding.mockResolvedValue(BINDING);
      json2Call.mockImplementation(async (_config: unknown, model: string, method: string) => {
        if (model === 'res.users' && method === 'context_get') return SCOPED_CONTEXT_GET;
        if (model === 'res.users' && method === 'search_read') throw new Error('Odoo unreachable');
        return [{ id: 999 }];
      });

      const briefing = await getBusinessBriefing(TENANT);

      expect(briefing.sections.every((s) => s.state === 'unavailable' && s.reason === 'odoo_company_scope_unresolvable')).toBe(true);
    });

    // ── CODEX FINDING regression tests (2026-09-18): the credential's OWN
    //    identity now gates access, not a Foundation-stored field. ─────────
    it('CODEX FIX — refuses when the bearer token cannot resolve an identity at all (context_get fails)', async () => {
      findUniqueOdooBinding.mockResolvedValue(BINDING);
      json2Call.mockImplementation(async (_config: unknown, model: string, method: string) => {
        if (model === 'res.users' && method === 'context_get') throw new Error('Odoo unreachable');
        return [{ id: 999 }]; // search_read must never be reached
      });

      const briefing = await getBusinessBriefing(TENANT);

      expect(briefing.sections.every((s) => s.state === 'unavailable' && s.reason === 'odoo_company_scope_unresolvable')).toBe(true);
      // The old vulnerable path (a direct search_read filtered by login) must never fire.
      expect(json2Call).not.toHaveBeenCalledWith(expect.anything(), 'res.users', 'search_read', expect.anything(), expect.anything());
    });

    it('CODEX FIX — refuses a malformed context_get response instead of guessing at a field name', async () => {
      findUniqueOdooBinding.mockResolvedValue(BINDING);
      json2Call.mockImplementation(async (_config: unknown, model: string, method: string) => {
        if (model === 'res.users' && method === 'context_get') return { user_id: 42 }; // wrong field name
        return [{ id: 999 }];
      });

      const briefing = await getBusinessBriefing(TENANT);

      expect(briefing.sections.every((s) => s.state === 'unavailable' && s.reason === 'odoo_company_scope_unresolvable')).toBe(true);
    });

    it('CODEX FIX — refuses when the bearer resolves to an identity whose OWN login disagrees with binding.login (drifted Foundation metadata, no longer silently trusted)', async () => {
      findUniqueOdooBinding.mockResolvedValue(BINDING); // login: 'a@b.test'
      json2Call.mockImplementation(async (_config: unknown, model: string, method: string) => {
        if (model === 'res.users' && method === 'context_get') return { uid: 42 };
        if (model === 'res.users' && method === 'search_read') return [{ id: 42, login: 'someone-else@example.test', company_id: [AUTHORIZED_COMPANY_ID, 'Company A'], company_ids: [AUTHORIZED_COMPANY_ID] }];
        return [{ id: 999 }];
      });

      const briefing = await getBusinessBriefing(TENANT);

      expect(briefing.sections.every((s) => s.state === 'unavailable' && s.reason === 'odoo_company_scope_unresolvable')).toBe(true);
    });

    it('CODEX FIX — the search_read that resolves company is filtered by the BEARER\'S OWN id, never by binding.login (closes the trust gap directly)', async () => {
      findUniqueOdooBinding.mockResolvedValue(BINDING);
      json2Call.mockImplementation(withScopedUser(() => []));

      await getBusinessBriefing(TENANT);

      expect(json2Call).toHaveBeenCalledWith(expect.anything(), 'res.users', 'context_get', {}, expect.any(Number));
      expect(json2Call).not.toHaveBeenCalledWith(
        expect.anything(),
        'res.users',
        'search_read',
        expect.objectContaining({ domain: expect.arrayContaining([['login', '=', BINDING.login]]) }),
        expect.anything(),
      );
      expect(json2Call).toHaveBeenCalledWith(
        expect.anything(),
        'res.users',
        'search_read',
        expect.objectContaining({ domain: [['id', '=', SCOPED_USER_ROW.id]] }),
        expect.any(Number),
      );
    });
  });
});
