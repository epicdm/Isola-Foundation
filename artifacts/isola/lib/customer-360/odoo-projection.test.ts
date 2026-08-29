import { beforeEach, describe, expect, it, vi } from 'vitest';

const json2Call = vi.fn();

vi.mock('@/engines/odoo', () => ({
  json2Call: (...args: unknown[]) => json2Call(...args),
  // Unused by this projection directly, but lib/context/customer-sources.ts
  // (imported transitively for odooDeepLink) reads it at module scope.
  findCustomerByPhone: vi.fn(),
}));

import { readCustomer360 } from './odoo-projection';

const config = { url: 'https://odoo.invalid', apiKey: 'not-used', db: 'test' };

describe('Odoo Customer 360 projection', () => {
  beforeEach(() => {
    json2Call.mockReset();
  });

  it('pins every business read to the one matched partner', async () => {
    json2Call.mockImplementation(async (_config: unknown, model: string) => {
      if (model === 'res.partner') return [{ id: 42, name: 'EPIC Customer', email: 'owner@example.test', phone: '+17670000000', city: 'Roseau' }];
      if (model === 'sale.order') return [{ id: 8, name: 'S0008', state: 'sent', amount_total: 125, currency_id: [1, 'XCD'], date_order: '2026-08-26' }];
      if (model === 'account.move') return [{ id: 9, name: 'INV/9', state: 'posted', payment_state: 'partial', amount_total: 125, amount_residual: 50, currency_id: [1, 'XCD'], invoice_date: '2026-08-26' }];
      if (model === 'crm.lead') return [{ id: 10, name: 'Upgrade', stage_id: [2, 'Qualified'], expected_revenue: 400, date_deadline: '2026-08-30' }];
      if (model === 'project.task') return [{ id: 11, name: 'Follow up', stage_id: [3, 'Open'], date_deadline: null }];
      throw new Error(`unexpected model ${model}`);
    });

    const result = await readCustomer360(config, '+17670000000', { displayId: 61, currentRequest: 'Please send the quote.' });
    expect(result?.customer.id).toBe(42);
    expect(result?.balances).toEqual([{ currency: 'XCD', amount: 50 }]);
    expect(result?.openLoopsAvailable).toBe(true);
    expect(result?.documents.map((item) => item.kind)).toEqual(['quotation', 'invoice']);
    expect(result?.openLoops.map((item) => item.kind)).toEqual(['opportunity', 'task']);

    for (const call of json2Call.mock.calls.filter((call) => call[1] !== 'res.partner')) {
      const params = call[3] as { domain: unknown[][] };
      expect(params.domain).toContainEqual(['partner_id', '=', 42]);
    }
  });

  it('does not issue business reads when no customer matches', async () => {
    json2Call.mockResolvedValue([]);
    await expect(readCustomer360(config, '+17670000000', { displayId: 61, currentRequest: null })).resolves.toBeNull();
    expect(json2Call).toHaveBeenCalled();
    expect(json2Call.mock.calls.every((call) => call[1] === 'res.partner')).toBe(true);
  });

  it('NEVER sums residuals across currencies', async () => {
    // EPIC's own unpaid set is 265 XCD invoices plus 2 USD ones
    // (def-receivables-headline-figure-is-mostly-draft-invoices-2026-08-13).
    // Adding them produces a number that means nothing, and the UI previously
    // stamped XCD on the result.
    json2Call.mockImplementation(async (_config: unknown, model: string) => {
      if (model === 'res.partner') return [{ id: 42, name: 'EPIC Customer', email: null, phone: '+17670000000', city: null }];
      if (model === 'account.move') return [
        { id: 1, name: 'INV/1', state: 'posted', payment_state: 'not_paid', amount_total: 100, amount_residual: 100, currency_id: [1, 'XCD'], invoice_date: '2026-08-01' },
        { id: 2, name: 'INV/2', state: 'posted', payment_state: 'not_paid', amount_total: 40, amount_residual: 40, currency_id: [2, 'USD'], invoice_date: '2026-08-02' },
        { id: 3, name: 'INV/3', state: 'posted', payment_state: 'not_paid', amount_total: 25, amount_residual: 25, currency_id: [1, 'XCD'], invoice_date: '2026-08-03' },
        // A draft must never contribute to an outstanding balance.
        { id: 4, name: 'INV/4', state: 'draft', payment_state: 'not_paid', amount_total: 999, amount_residual: 999, currency_id: [1, 'XCD'], invoice_date: '2026-08-04' },
      ];
      return [];
    });

    const result = await readCustomer360(config, '+17670000000', { displayId: 61, currentRequest: null });
    expect(result?.balances).toEqual([
      { currency: 'XCD', amount: 125 },
      { currency: 'USD', amount: 40 },
    ]);
    // CONTROL: the wrong answer this test exists to forbid.
    const combined = result!.balances.reduce((sum, b) => sum + b.amount, 0);
    expect(combined).toBe(165);
    expect(result!.balances.length).toBeGreaterThan(1);
    // and the draft's 999 never appears anywhere
    expect(result!.balances.some((b) => b.amount === 999 || b.amount > 200)).toBe(false);
  });

  it('carries the document own currency rather than assuming one', async () => {
    json2Call.mockImplementation(async (_config: unknown, model: string) => {
      if (model === 'res.partner') return [{ id: 42, name: 'C', email: null, phone: '+17670000000', city: null }];
      if (model === 'account.move') return [{ id: 2, name: 'INV/2', state: 'posted', payment_state: 'not_paid', amount_total: 40, amount_residual: 40, currency_id: [2, 'USD'], invoice_date: '2026-08-02' }];
      return [];
    });
    const result = await readCustomer360(config, '+17670000000', { displayId: 1, currentRequest: null });
    expect(result?.documents[0]?.currency).toBe('USD');
  });

  it('reports opportunity/task unavailability instead of rendering it as none', async () => {
    // A tolerated read failure must not become "this customer has no open work".
    json2Call.mockImplementation(async (_config: unknown, model: string) => {
      if (model === 'res.partner') return [{ id: 42, name: 'C', email: null, phone: '+17670000000', city: null }];
      if (model === 'crm.lead') throw new Error('field date_deadline does not exist');
      return [];
    });
    const result = await readCustomer360(config, '+17670000000', { displayId: 1, currentRequest: null });
    expect(result).not.toBeNull();
    expect(result?.openLoopsAvailable).toBe(false);
    expect(result?.openLoops).toEqual([]);
  });

  it('CONTROL — a clean run still reports open loops as available', async () => {
    json2Call.mockImplementation(async (_config: unknown, model: string) => {
      if (model === 'res.partner') return [{ id: 42, name: 'C', email: null, phone: '+17670000000', city: null }];
      return [];
    });
    const result = await readCustomer360(config, '+17670000000', { displayId: 1, currentRequest: null });
    expect(result?.openLoopsAvailable).toBe(true);
  });

  it('does not misreport an Odoo outage as customer-not-found', async () => {
    json2Call.mockRejectedValue(new Error('Odoo unavailable'));
    await expect(readCustomer360(config, '+17670000000', { displayId: 61, currentRequest: null })).rejects.toThrow('Odoo unavailable');
  });

  describe('S3 — recommended action and deep links', () => {
    it('recommends reviewing a draft quotation, with a reply built from verified facts', async () => {
      json2Call.mockImplementation(async (_config: unknown, model: string) => {
        if (model === 'res.partner') return [{ id: 42, name: 'Patricia Yvonne Armour', email: 'p@example.test', phone: '+17672951770', city: null }];
        if (model === 'sale.order') return [{ id: 670, name: 'S00670', state: 'draft', amount_total: 4272.6, currency_id: [1, 'XCD'], date_order: '2026-08-20' }];
        return [];
      });

      const result = await readCustomer360(config, '+17672951770', { displayId: 15, currentRequest: null });

      expect(result?.recommendedAction).not.toBeNull();
      expect(result?.recommendedAction?.kind).toBe('review-draft-quotation');
      expect(result?.recommendedAction?.headline).toContain('S00670');
      expect(result?.recommendedAction?.document.reference).toBe('S00670');
      // Verified facts only — the exact amount, currency and first name Odoo returned.
      expect(result?.recommendedAction?.suggestedReply).toContain('Patricia');
      expect(result?.recommendedAction?.suggestedReply).toContain('S00670');
      expect(result?.recommendedAction?.suggestedReply).toMatch(/XCD|\$/);
      // Never claims the document was sent, attached or accepted.
      expect(result?.recommendedAction?.suggestedReply.toLowerCase()).not.toContain('sent');
      expect(result?.recommendedAction?.suggestedReply.toLowerCase()).not.toContain('attached');
      expect(result?.recommendedAction?.suggestedReply.toLowerCase()).not.toContain('accepted');
    });

    it('withholds the recommendation for a non-draft quote rather than reusing draft wording', async () => {
      json2Call.mockImplementation(async (_config: unknown, model: string) => {
        if (model === 'res.partner') return [{ id: 42, name: 'C', email: null, phone: '+17670000000', city: null }];
        if (model === 'sale.order') return [{ id: 8, name: 'S0008', state: 'sale', amount_total: 100, currency_id: [1, 'XCD'], date_order: '2026-08-20' }];
        return [];
      });
      const result = await readCustomer360(config, '+17670000000', { displayId: 1, currentRequest: null });
      expect(result?.recommendedAction).toBeNull();
    });

    it('withholds the recommendation when there is no quotation at all', async () => {
      json2Call.mockImplementation(async (_config: unknown, model: string) => {
        if (model === 'res.partner') return [{ id: 42, name: 'C', email: null, phone: '+17670000000', city: null }];
        return [];
      });
      const result = await readCustomer360(config, '+17670000000', { displayId: 1, currentRequest: null });
      expect(result?.recommendedAction).toBeNull();
    });

    it('never guesses a currency in the suggested reply when Odoo did not supply one', async () => {
      json2Call.mockImplementation(async (_config: unknown, model: string) => {
        if (model === 'res.partner') return [{ id: 42, name: 'Jo', email: null, phone: '+17670000000', city: null }];
        if (model === 'sale.order') return [{ id: 9, name: 'S0009', state: 'draft', amount_total: 50, currency_id: false, date_order: '2026-08-20' }];
        return [];
      });
      const result = await readCustomer360(config, '+17670000000', { displayId: 1, currentRequest: null });
      expect(result?.recommendedAction?.document.currency).toBeNull();
      expect(result?.recommendedAction?.suggestedReply).toContain('currency unknown');
      // never a fabricated code
      expect(result?.recommendedAction?.suggestedReply).not.toMatch(/XCD|USD|EUR/);
    });

    it('builds the correct sale.order deep link from the server-resolved instance', async () => {
      json2Call.mockImplementation(async (_config: unknown, model: string) => {
        if (model === 'res.partner') return [{ id: 42, name: 'C', email: null, phone: '+17670000000', city: null }];
        if (model === 'sale.order') return [{ id: 670, name: 'S00670', state: 'draft', amount_total: 100, currency_id: [1, 'XCD'], date_order: '2026-08-20' }];
        return [];
      });
      const result = await readCustomer360(config, '+17670000000', { displayId: 1, currentRequest: null });
      expect(result?.documents[0]?.odooLink).toBe('https://odoo.invalid/odoo/sale.order/670');
    });

    it('builds deep links for OPEN WORK too, not only documents', async () => {
      // Open work previously carried a permanently disabled "Open in Odoo"
      // button whose tooltip promised a slice that had already shipped. The
      // link uses the identical model-agnostic builder; only the model differs.
      json2Call.mockImplementation(async (_config: unknown, model: string) => {
        if (model === 'res.partner') return [{ id: 42, name: 'C', email: null, phone: '+17670000000', city: null }];
        if (model === 'crm.lead') return [{ id: 9, name: 'Second line', stage_id: [2, 'Qualified'], expected_revenue: 500, date_deadline: null }];
        if (model === 'project.task') return [{ id: 4, name: 'Install', stage_id: [1, 'New'], date_deadline: null }];
        return [];
      });
      const result = await readCustomer360(config, '+17670000000', { displayId: 1, currentRequest: null });

      const lead = result?.openLoops.find((l) => l.kind === 'opportunity');
      const task = result?.openLoops.find((l) => l.kind === 'task');
      expect(lead?.odooLink).toBe('https://odoo.invalid/odoo/crm.lead/9');
      expect(task?.odooLink).toBe('https://odoo.invalid/odoo/project.task/4');
    });

    it('refuses an OPEN WORK deep link on a sandbox origin, exactly as it does for documents', async () => {
      // The guard is the shared builder, so it must hold for loops too. Without
      // this, a link could be honest for documents and fabricated for loops.
      json2Call.mockImplementation(async (_config: unknown, model: string) => {
        if (model === 'res.partner') return [{ id: 42, name: 'C', email: null, phone: '+17670000000', city: null }];
        if (model === 'crm.lead') return [{ id: 9, name: 'Second line', stage_id: [2, 'Qualified'], expected_revenue: 500, date_deadline: null }];
        return [];
      });
      const sandboxConfig = { url: 'https://epic_sandbox.odoo.com', apiKey: 'not-used', db: 'test' };
      const result = await readCustomer360(sandboxConfig, '+17670000000', { displayId: 1, currentRequest: null });
      expect(result?.openLoops[0]?.odooLink).toBeNull();
    });

    it('refuses a deep link against a sandbox origin, even though the record and id are valid', async () => {
      json2Call.mockImplementation(async (_config: unknown, model: string) => {
        if (model === 'res.partner') return [{ id: 42, name: 'C', email: null, phone: '+17670000000', city: null }];
        if (model === 'sale.order') return [{ id: 670, name: 'S00670', state: 'draft', amount_total: 100, currency_id: [1, 'XCD'], date_order: '2026-08-20' }];
        return [];
      });
      const sandboxConfig = { url: 'https://epic_sandbox.odoo.com', apiKey: 'not-used', db: 'test' };
      const result = await readCustomer360(sandboxConfig, '+17670000000', { displayId: 1, currentRequest: null });
      expect(result?.documents[0]?.odooLink).toBeNull();
    });

    it('refuses a deep link against a non-https origin', async () => {
      json2Call.mockImplementation(async (_config: unknown, model: string) => {
        if (model === 'res.partner') return [{ id: 42, name: 'C', email: null, phone: '+17670000000', city: null }];
        if (model === 'sale.order') return [{ id: 670, name: 'S00670', state: 'draft', amount_total: 100, currency_id: [1, 'XCD'], date_order: '2026-08-20' }];
        return [];
      });
      const httpConfig = { url: 'http://odoo.invalid', apiKey: 'not-used', db: 'test' };
      const result = await readCustomer360(httpConfig, '+17670000000', { displayId: 1, currentRequest: null });
      expect(result?.documents[0]?.odooLink).toBeNull();
    });

    it('CONTROL — the allowed-origin check genuinely discriminates (an ordinary tenant host is allowed)', async () => {
      json2Call.mockImplementation(async (_config: unknown, model: string) => {
        if (model === 'res.partner') return [{ id: 42, name: 'C', email: null, phone: '+17670000000', city: null }];
        if (model === 'sale.order') return [{ id: 5, name: 'S0005', state: 'draft', amount_total: 100, currency_id: [1, 'XCD'], date_order: '2026-08-20' }];
        return [];
      });
      const legitConfig = { url: 'https://some-other-tenant.odoo.com', apiKey: 'not-used', db: 'test' };
      const result = await readCustomer360(legitConfig, '+17670000000', { displayId: 1, currentRequest: null });
      expect(result?.documents[0]?.odooLink).toBe('https://some-other-tenant.odoo.com/odoo/sale.order/5');
    });
  });
});
