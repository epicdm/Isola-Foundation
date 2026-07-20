import { describe, it, expect, vi, beforeEach } from 'vitest';
import { surfaceHandoff, HANDOFF_LABEL } from './chatwoot-handoff';

const BASE_URL = 'https://inbox.epic.dm';
const ACCOUNT_ID = '5';
const CW_CONV_ID = 42;
const BOT_TOKEN = 'test-bot-token';

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn();
});

describe('surfaceHandoff — single-fire (P1 dispatch fix)', () => {
  it('posts the private note, adds the label, and toggles status when not previously surfaced', async () => {
    const calls: string[] = [];
    (global.fetch as any).mockImplementation((url: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/labels') && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ payload: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    await surfaceHandoff(BASE_URL, ACCOUNT_ID, CW_CONV_ID, BOT_TOKEN);

    const messagePost = calls.filter((c) => c.includes('/messages') && c.startsWith('POST'));
    const labelPost = calls.filter((c) => c.includes('/labels') && c.startsWith('POST'));
    const toggle = calls.filter((c) => c.includes('/toggle_status'));
    expect(messagePost).toHaveLength(1);
    expect(labelPost).toHaveLength(1);
    expect(toggle).toHaveLength(1);
  });

  it('skips the private note, label POST, and status toggle entirely when the handoff label is already present', async () => {
    (global.fetch as any).mockImplementation((url: string, init?: any) => {
      if (url.endsWith('/labels') && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ payload: [HANDOFF_LABEL] }));
      }
      throw new Error(`unexpected fetch call: ${init?.method ?? 'GET'} ${url}`);
    });

    await surfaceHandoff(BASE_URL, ACCOUNT_ID, CW_CONV_ID, BOT_TOKEN);

    // Only the initial labels GET should have fired — no note, no label POST, no toggle.
    expect((global.fetch as any).mock.calls).toHaveLength(1);
    expect((global.fetch as any).mock.calls[0][0]).toContain('/labels');
  });
});
