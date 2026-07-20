import { describe, it, expect } from 'vitest';
import { TOOL_NAMES, executeOdooRead, GateBlockedError } from './agent-tools';

/**
 * Lane 1 Task 5 — proves no payment/checkout tool is reachable through the
 * ONE surface an external brain (Clawith) can call
 * (POST /api/agent-tools/invoke → lib/agent-tools.ts). See also
 * docs/first-customer-transaction-runbook.md and
 * scripts/assert-no-payment-path.ts for the rest of the "no customer payment
 * link reachable from the sales flow" evidence.
 */
describe('agent-tools — no payment tool is exposed', () => {
  it('TOOL_NAMES contains no payment/charge/checkout tool', () => {
    expect(TOOL_NAMES).toEqual(['odoo.read', 'odoo.create_lead', 'wa.send']);
    for (const name of TOOL_NAMES) {
      expect(name).not.toMatch(/pay|charge|checkout|stripe|fiserv|invoice/i);
    }
  });

  it('executeOdooRead always holds a read against account.payment over policy, never executes it', async () => {
    await expect(
      executeOdooRead('any-tenant', { model: 'account.payment', method: 'search_read', domain: [], limit: 10 }),
    ).rejects.toThrow(GateBlockedError);
  });

  it('the account.payment block is case/whitespace-insensitive (defense against a widened/loose caller)', async () => {
    await expect(
      executeOdooRead('any-tenant', { model: '  Account.Payment  ', method: 'search_read', domain: [], limit: 10 }),
    ).rejects.toThrow(GateBlockedError);
  });
});
