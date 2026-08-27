import { describe, expect, it } from 'vitest';
import { parseChatwootContext } from './chatwoot-context';

const payload = (conversation: Record<string, unknown> = {}) => JSON.stringify({
  event: 'appContext',
  data: {
    conversation: { id: 61, account_id: 3, inbox_id: 4, ...conversation },
    contact: { id: 99, name: 'Discard me', phone_number: '+17670000000' },
    currentAgent: { id: 7, role: 'administrator' },
  },
});

describe('Chatwoot Customer 360 context', () => {
  it('returns only independently verifiable locators', () => {
    const result = parseChatwootContext(payload());
    expect(result).toEqual({ ok: true, hint: { accountIdHint: 3, inboxIdHint: 4, conversationDisplayIdHint: 61 } });
    if (!result.ok) return;
    expect(Object.keys(result.hint).sort()).toEqual(['accountIdHint', 'conversationDisplayIdHint', 'inboxIdHint']);
  });

  it.each([0, -1, 1.5, '4', Number.MAX_SAFE_INTEGER + 1])('rejects invalid identifiers: %p', (bad) => {
    expect(parseChatwootContext(payload({ inbox_id: bad }))).toMatchObject({ ok: false });
  });

  it('rejects browser objects and malformed data without throwing', () => {
    expect(parseChatwootContext({ event: 'appContext' })).toMatchObject({ ok: false });
    expect(parseChatwootContext('{bad')).toMatchObject({ ok: false });
  });
});
