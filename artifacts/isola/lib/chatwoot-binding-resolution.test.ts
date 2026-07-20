import { describe, it, expect } from 'vitest';
import { resolveActiveBinding, type BindingWithTenantStatus } from './chatwoot-binding-resolution';

function binding(overrides: Partial<BindingWithTenantStatus>): BindingWithTenantStatus {
  return {
    id: 'b1',
    tenant_id: 't1',
    updated_at: new Date('2026-01-01T00:00:00Z'),
    tenant: { status: 'active' },
    ...overrides,
  };
}

describe('resolveActiveBinding', () => {
  it('returns null for an empty list', () => {
    expect(resolveActiveBinding([])).toBeNull();
  });

  it('returns the only binding when there is exactly one', () => {
    const only = binding({ id: 'b1' });
    expect(resolveActiveBinding([only])).toBe(only);
  });

  it('prefers the active tenant over a retired duplicate, regardless of array order — the inbox-3 collision case', () => {
    const retired = binding({
      id: 'b-retired',
      tenant_id: 'ema_sales_tenant',
      tenant: { status: 'retired' },
      updated_at: new Date('2026-07-20T18:52:51.846Z'), // more recently updated...
    });
    const active = binding({
      id: 'b-active',
      tenant_id: '43b006e4-33e0-42a8-bec7-4422ba290d79',
      tenant: { status: 'active' },
      updated_at: new Date('2026-07-17T12:06:02.583Z'), // ...but active must still win
    });

    expect(resolveActiveBinding([retired, active])?.tenant_id).toBe(active.tenant_id);
    expect(resolveActiveBinding([active, retired])?.tenant_id).toBe(active.tenant_id);
  });

  it('when both are active, the most recently updated binding wins', () => {
    const older = binding({ id: 'b-old', updated_at: new Date('2026-01-01T00:00:00Z') });
    const newer = binding({ id: 'b-new', updated_at: new Date('2026-02-01T00:00:00Z') });
    expect(resolveActiveBinding([older, newer])?.id).toBe('b-new');
    expect(resolveActiveBinding([newer, older])?.id).toBe('b-new');
  });

  it('when both are retired, the most recently updated binding wins', () => {
    const older = binding({
      id: 'b-old',
      tenant: { status: 'retired' },
      updated_at: new Date('2026-01-01T00:00:00Z'),
    });
    const newer = binding({
      id: 'b-new',
      tenant: { status: 'retired' },
      updated_at: new Date('2026-02-01T00:00:00Z'),
    });
    expect(resolveActiveBinding([older, newer])?.id).toBe('b-new');
  });

  it('breaks a tie on identical updated_at by the lower binding id, so the result is stable', () => {
    const same = new Date('2026-01-01T00:00:00Z');
    const a = binding({ id: 'b-aaa', updated_at: same });
    const b = binding({ id: 'b-bbb', updated_at: same });
    expect(resolveActiveBinding([a, b])?.id).toBe('b-aaa');
    expect(resolveActiveBinding([b, a])?.id).toBe('b-aaa');
  });
});
