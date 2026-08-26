import { beforeEach, describe, expect, it, vi } from 'vitest';

const json2Call = vi.fn();

vi.mock('@/engines/odoo', () => ({
  json2Call: (...args: unknown[]) => json2Call(...args),
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
});
