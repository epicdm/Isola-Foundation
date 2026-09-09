/**
 * The refusal CODE, and nothing else — so a browser bundle can name it without
 * dragging a crypto module in behind it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `lib/customer-360/follow-up-notice.ts` needs exactly one string in order to
 * pick the right sentence for an operator: `'tenant_not_bound'`. It imported
 * that constant from `lib/engine-bindings`, which is a SERVER module — it
 * imports `lib/tenant-secrets`, which imports `node:crypto`.
 *
 * `components/customer-360/customer-360-app.tsx` is `'use client'`. So one
 * string literal pulled `node:crypto` into a client bundle and `next build`
 * failed outright:
 *
 *     Module not found: Can't resolve 'node:crypto'
 *     Import trace: node:crypto -> lib/tenant-secrets.ts
 *       -> lib/engine-bindings.ts -> lib/customer-360/follow-up-notice.ts
 *       -> components/customer-360/customer-360-app.tsx
 *
 * THE UNIT SUITE CANNOT SEE THIS. vitest runs in Node, where `node:crypto`
 * resolves perfectly; 3376 tests passed against code that does not build.
 * Only `next build` distinguishes "runs under Node" from "can be sent to a
 * browser", which is why that step belongs in CI and currently is not there.
 *
 * The constant stays single-source: `engine-bindings` re-exports it from here,
 * so every existing importer keeps working and there is still exactly one
 * definition. A duplicated literal in two files would drift silently, and the
 * one thing this code must never do is disagree with itself about the word
 * that means "we refused to write into a business nobody bound".
 */

/** Refusal code carried by OdooBindingRequiredError, and matched by the UI. */
export const TENANT_NOT_BOUND = 'tenant_not_bound' as const;
