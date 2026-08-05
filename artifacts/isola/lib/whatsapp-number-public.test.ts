/**
 * The projection module is the single point that decides what is public.
 * These tests pin that decision so it cannot drift silently.
 *
 * The compile-time guards in the module itself already fail `tsc` if the field
 * list, the select clause and the model disagree. These cover what types
 * cannot: the runtime behaviour of the serialiser on inputs it should never
 * have been handed.
 */
import { describe, it, expect } from 'vitest';
import {
  WHATSAPP_NUMBER_PUBLIC_FIELDS,
  WHATSAPP_NUMBER_PUBLIC_SELECT,
  toPublicWhatsAppNumber,
  toPublicWhatsAppNumbers,
} from './whatsapp-number-public';

const fake = (label: string) => `SYNTHETIC-${label}-${label.length}-NOT-A-REAL-VALUE`;

const PUBLIC_ROW = {
  id: 'wan-1',
  phone_number_id: '278390858690809',
  waba_id: '227366173803234',
  phone_number: '+17672956737',
  display_name: 'EPIC Front Desk',
  coex_mode: true,
  created_at: new Date('2026-08-01T00:00:00.000Z'),
  updated_at: new Date('2026-08-02T00:00:00.000Z'),
};

describe('the public allowlist', () => {
  it('contains no credential-bearing or credential-referencing column', () => {
    const forbidden = [
      'access_token',
      'token_env',
      'app_secret',
      'client_secret',
      'verify_token',
      'webhook_secret',
      'api_key',
      'apiKey',
      'token',
      'secret',
      'dek',
      'encrypted',
    ];
    for (const field of WHATSAPP_NUMBER_PUBLIC_FIELDS) {
      for (const bad of forbidden) {
        expect(field.toLowerCase(), `"${field}" looks credential-bearing`).not.toContain(
          bad.toLowerCase(),
        );
      }
    }
  });

  it('the select clause and the field list are the same set', () => {
    expect(Object.keys(WHATSAPP_NUMBER_PUBLIC_SELECT).sort()).toEqual(
      [...WHATSAPP_NUMBER_PUBLIC_FIELDS].sort(),
    );
  });

  it('every selected column is requested, never excluded', () => {
    for (const value of Object.values(WHATSAPP_NUMBER_PUBLIC_SELECT)) {
      expect(value).toBe(true);
    }
  });
});

describe('toPublicWhatsAppNumber', () => {
  it('drops access_token and token_env from a full row', () => {
    const out = toPublicWhatsAppNumber({
      ...PUBLIC_ROW,
      tenant_id: 'tenant-1',
      access_token: fake('ACCESS-TOKEN'),
      token_env: fake('TOKEN-ENV'),
    } as never);

    expect(out).not.toHaveProperty('access_token');
    expect(out).not.toHaveProperty('token_env');
    expect(out).not.toHaveProperty('tenant_id');
  });

  it('drops columns that do not exist yet — the future-schema regression', () => {
    const out = toPublicWhatsAppNumber({
      ...PUBLIC_ROW,
      some_future_secret_column: fake('FUTURE-COLUMN'),
      another_new_field: 'whatever',
    } as never);

    expect(Object.keys(out).sort()).toEqual([...WHATSAPP_NUMBER_PUBLIC_FIELDS].sort());
  });

  it('is not a spread — output keys are fixed regardless of input shape', () => {
    const fromSparse = toPublicWhatsAppNumber({ ...PUBLIC_ROW, extra: 1 } as never);
    const fromFat = toPublicWhatsAppNumber({
      ...PUBLIC_ROW,
      a: 1,
      b: 2,
      c: 3,
      access_token: fake('ACCESS-TOKEN'),
    } as never);

    expect(Object.keys(fromSparse).sort()).toEqual(Object.keys(fromFat).sort());
  });

  it('preserves the values of approved fields exactly', () => {
    expect(toPublicWhatsAppNumber(PUBLIC_ROW)).toEqual(PUBLIC_ROW);
  });

  it('keeps a null display_name null rather than coercing it', () => {
    const out = toPublicWhatsAppNumber({ ...PUBLIC_ROW, display_name: null });
    expect(out.display_name).toBeNull();
  });

  it('survives JSON serialisation without reintroducing anything', () => {
    const raw = JSON.stringify(
      toPublicWhatsAppNumber({ ...PUBLIC_ROW, access_token: fake('ACCESS-TOKEN') } as never),
    );
    expect(raw).not.toContain('SYNTHETIC');
    expect(raw).not.toContain('access_token');
  });
});

describe('toPublicWhatsAppNumbers', () => {
  it('redacts every element of a list', () => {
    const rows = [
      { ...PUBLIC_ROW, id: 'a', access_token: fake('ACCESS-TOKEN') },
      { ...PUBLIC_ROW, id: 'b', token_env: fake('TOKEN-ENV') },
    ] as never[];

    const raw = JSON.stringify(toPublicWhatsAppNumbers(rows));

    expect(raw).not.toContain('SYNTHETIC');
    expect(JSON.parse(raw)).toHaveLength(2);
    for (const item of JSON.parse(raw)) {
      expect(Object.keys(item).sort()).toEqual([...WHATSAPP_NUMBER_PUBLIC_FIELDS].sort());
    }
  });

  it('returns an empty array unchanged', () => {
    expect(toPublicWhatsAppNumbers([])).toEqual([]);
  });
});
