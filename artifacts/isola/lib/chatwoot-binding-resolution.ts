/**
 * Deterministically resolve which ChatwootBinding governs an inbox when more
 * than one binding row exists for the same (inbox_id, mode) pair — this can
 * happen when a tenant is retired but its binding isn't cleaned up (see the
 * 2026-07-20 inbox-3 collision: a retired tenant's binding was
 * non-deterministically winning over the active tenant's, because Postgres
 * gives no ordering guarantee to findFirst() without an explicit orderBy).
 *
 * Preference order: active tenant status first, then most recently updated
 * binding, then binding id — so the same input set always produces the same
 * winner regardless of DB scan order.
 */
export interface BindingWithTenantStatus {
  id: string;
  tenant_id: string;
  updated_at: Date;
  tenant: { status: string };
}

export function resolveActiveBinding<T extends BindingWithTenantStatus>(
  bindings: T[],
): T | null {
  if (bindings.length === 0) return null;
  return bindings.slice().sort((a, b) => {
    const activeA = a.tenant.status === 'active' ? 0 : 1;
    const activeB = b.tenant.status === 'active' ? 0 : 1;
    if (activeA !== activeB) return activeA - activeB;

    const updatedDiff = b.updated_at.getTime() - a.updated_at.getTime();
    if (updatedDiff !== 0) return updatedDiff;

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}
