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
    json2Call.mockImplementation(async (config: unknown, model: string) => {
      expect((config as { url: string }).url).toBe(BINDING.url);
      if (model === 'account.move') {
        return [{ id: 9, name: 'INV/9', partner_id: [3, 'EPIC Customer'], amount_residual: 125.5, currency_id: [1, 'XCD'], invoice_date_due: '2026-08-01' }];
      }
      if (model === 'crm.lead') {
        return [{ id: 10, name: 'Upgrade', partner_id: [3, 'EPIC Customer'], expected_revenue: 400, stage_id: [2, 'Qualified'], date_deadline: '2026-08-30' }];
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
  });

  it('reports a section unavailable, not empty, when the Odoo read itself fails — one section failing does not sink the other', async () => {
    findUniqueOdooBinding.mockResolvedValue(BINDING);
    json2Call.mockImplementation(async (_config: unknown, model: string) => {
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
    json2Call.mockImplementation(async (_config: unknown, model: string) => {
      if (model === 'account.move') return [{ id: 1, name: 'INV/1', partner_id: [1, 'X'], amount_residual: 5, currency_id: [1, 'XCD'], invoice_date_due: '2026-08-01' }];
      return [];
    });

    const briefing = await getBusinessBriefing(TENANT);
    const overdue = briefing.sections.find((s) => s.id === 'overdue_receivables')!;
    expect(overdue.state).toBe('ok');
    expect((overdue as { rows: { sourceUrl: string | null }[] }).rows[0].sourceUrl).toBeNull();
  });

  it('never sums residuals across rows/currencies — each row keeps its own currency in its own detail line', async () => {
    findUniqueOdooBinding.mockResolvedValue(BINDING);
    json2Call.mockImplementation(async (_config: unknown, model: string) => {
      if (model === 'account.move') {
        return [
          { id: 1, name: 'INV/1', partner_id: [1, 'A'], amount_residual: 100, currency_id: [1, 'XCD'], invoice_date_due: '2026-08-01' },
          { id: 2, name: 'INV/2', partner_id: [2, 'B'], amount_residual: 40, currency_id: [2, 'USD'], invoice_date_due: '2026-08-02' },
        ];
      }
      return [];
    });

    const briefing = await getBusinessBriefing(TENANT);
    const overdue = briefing.sections.find((s) => s.id === 'overdue_receivables')!;
    expect((overdue as { rows: { detail: string }[] }).rows.map((r) => r.detail)).toEqual([
      '100.00 XCD outstanding, due 2026-08-01',
      '40.00 USD outstanding, due 2026-08-02',
    ]);
  });
});
