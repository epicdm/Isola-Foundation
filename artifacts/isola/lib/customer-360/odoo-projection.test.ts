import { beforeEach, describe, expect, it, vi } from 'vitest';

const findCustomerByPhone = vi.fn();
const json2Call = vi.fn();

vi.mock('@/engines/odoo', () => ({
  findCustomerByPhone: (...args: unknown[]) => findCustomerByPhone(...args),
  json2Call: (...args: unknown[]) => json2Call(...args),
}));

import { readCustomer360 } from './odoo-projection';

const config = { url: 'https://odoo.invalid', apiKey: 'not-used', db: 'test' };

describe('Odoo Customer 360 projection', () => {
  beforeEach(() => {
    findCustomerByPhone.mockReset();
    json2Call.mockReset();
  });

  it('pins every business read to the one matched partner', async () => {
    findCustomerByPhone.mockResolvedValue({ id: 42, name: 'EPIC Customer', email: 'owner@example.test', phone: '+17670000000', city: 'Roseau' });
    json2Call.mockImplementation(async (_config: unknown, model: string) => {
      if (model === 'sale.order') return [{ id: 8, name: 'S0008', state: 'sent', amount_total: 125, date_order: '2026-08-26' }];
      if (model === 'account.move') return [{ id: 9, name: 'INV/9', state: 'posted', payment_state: 'partial', amount_total: 125, amount_residual: 50, invoice_date: '2026-08-26' }];
      if (model === 'crm.lead') return [{ id: 10, name: 'Upgrade', stage_id: [2, 'Qualified'], expected_revenue: 400, date_deadline: '2026-08-30' }];
      if (model === 'project.task') return [{ id: 11, name: 'Follow up', stage_id: [3, 'Open'], date_deadline: null }];
      throw new Error(`unexpected model ${model}`);
    });

    const result = await readCustomer360(config, '+17670000000', { displayId: 61, currentRequest: 'Please send the quote.' });
    expect(result?.customer.id).toBe(42);
    expect(result?.balanceDue).toBe(50);
    expect(result?.documents.map((item) => item.kind)).toEqual(['quotation', 'invoice']);
    expect(result?.openLoops.map((item) => item.kind)).toEqual(['opportunity', 'task']);

    for (const call of json2Call.mock.calls) {
      const params = call[3] as { domain: unknown[][] };
      expect(params.domain).toContainEqual(['partner_id', '=', 42]);
    }
  });

  it('does not issue business reads when no customer matches', async () => {
    findCustomerByPhone.mockResolvedValue(null);
    await expect(readCustomer360(config, '+17670000000', { displayId: 61, currentRequest: null })).resolves.toBeNull();
    expect(json2Call).not.toHaveBeenCalled();
  });
});
