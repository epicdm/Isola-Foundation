/**
 * Lane 1 Task 5 — live config assertion: no customer-facing payment link is
 * reachable from the apply -> proposal -> pay sales flow. Payment for the
 * founding pilot is EPIC-issued invoice + NBD/manual only (see
 * docs/first-customer-transaction-runbook.md).
 *
 * Checks, against the running deployment:
 *   1. FISERV_CHARGE_ENABLED is OFF (live card charges are kill-switched),
 *      read via the public /api/setup-status checklist — the same endpoint
 *      the in-app setup banner uses, so this never drifts from what's
 *      actually deployed.
 *   2. lib/agent-tools.ts (the only tool surface an external brain can call)
 *      exposes no payment/checkout/charge tool.
 *
 * This is read-only against a live deployment; it changes nothing.
 *
 * Usage:
 *   npx tsx scripts/assert-no-payment-path.ts [base-url]
 *   (defaults to the live Foundation deployment — pass another URL to check
 *   a different environment, e.g. a preview deploy)
 */
import { TOOL_NAMES } from '../lib/agent-tools';

const baseUrl = process.argv[2] || 'https://isola-foundation.replit.app';

async function main() {
  console.log('=== No-payment-path assertion ===');
  console.log(`Target: ${baseUrl}`);

  let failed = false;

  // ── 1. FISERV_CHARGE_ENABLED must be OFF ──────────────────────────────────
  const res = await fetch(`${baseUrl}/api/setup-status`);
  if (!res.ok) {
    console.error(`FAIL  /api/setup-status returned ${res.status}`);
    process.exit(1);
  }
  const body = await res.json();
  const fiserv = (body.checklist as any[]).find((s) => s.key === 'FISERV_CHARGE_ENABLED');
  if (!fiserv) {
    console.error('FAIL  FISERV_CHARGE_ENABLED not present in /api/setup-status checklist');
    failed = true;
  } else if (fiserv.configured === true) {
    console.error('FAIL  FISERV_CHARGE_ENABLED is ON — live Fiserv charges are enabled');
    failed = true;
  } else {
    console.log('OK    FISERV_CHARGE_ENABLED is OFF (kill-switch engaged)');
  }

  // ── 2. No payment tool in the agent-tools surface ─────────────────────────
  const badTool = TOOL_NAMES.find((n) => /pay|charge|checkout|stripe|fiserv|invoice/i.test(n));
  if (badTool) {
    console.error(`FAIL  agent-tools exposes a payment-shaped tool: ${badTool}`);
    failed = true;
  } else {
    console.log(`OK    agent-tools TOOL_NAMES has no payment tool (${TOOL_NAMES.join(', ')})`);
  }

  console.log(failed ? '\n=== FAILED ===' : '\n=== PASSED — no customer payment link reachable ===');
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error('ERR', e);
  process.exit(1);
});
