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

  it('posts a caller-supplied noteText instead of the generic default when provided', async () => {
    const posted: any[] = [];
    (global.fetch as any).mockImplementation((url: string, init?: any) => {
      if (url.endsWith('/labels') && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ payload: [] }));
      }
      if (url.endsWith('/messages') && init?.method === 'POST') {
        posted.push(JSON.parse(init.body));
      }
      return Promise.resolve(jsonResponse({}));
    });

    await surfaceHandoff(BASE_URL, ACCOUNT_ID, CW_CONV_ID, BOT_TOKEN, 'custom escalation note');

    expect(posted).toHaveLength(1);
    expect(posted[0].content).toBe('custom escalation note');
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

/**
 * The label gate above only holds if the label WRITE succeeded. On the live
 * instance it never did — no `ai-handoff` tag exists at all — so conversation
 * 156 collected six identical handoff notes in one day. These cover the
 * note-presence gate that actually stops that.
 */
describe('surfaceHandoff — duplicate suppression when the label was never written', () => {
  function mockConversation(opts: { labels: string[]; messages: unknown[]; messagesOk?: boolean }) {
    const calls: string[] = [];
    (global.fetch as any).mockImplementation((url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (url.endsWith('/labels') && method === 'GET') {
        return Promise.resolve(jsonResponse({ payload: opts.labels }));
      }
      if (url.endsWith('/messages') && method === 'GET') {
        return Promise.resolve(jsonResponse({ payload: opts.messages }, opts.messagesOk ?? true));
      }
      return Promise.resolve(jsonResponse({}));
    });
    return calls;
  }

  const notePosts = (calls: string[]) =>
    calls.filter((c) => c.includes('/messages') && c.startsWith('POST'));

  it('does not post a second note when a card is already on the conversation', async () => {
    const calls = mockConversation({
      labels: [],
      messages: [{ private: true, content: '🔔 **Human help needed**\n\nThe customer asked to speak to a person.' }],
    });

    await surfaceHandoff(BASE_URL, ACCOUNT_ID, CW_CONV_ID, BOT_TOKEN);

    expect(notePosts(calls)).toHaveLength(0);
  });

  it('recognises a legacy note written before the card existed', async () => {
    const calls = mockConversation({
      labels: [],
      messages: [{ private: true, content: '🤖 Clawith flagged this conversation for human review.' }],
    });

    await surfaceHandoff(BASE_URL, ACCOUNT_ID, CW_CONV_ID, BOT_TOKEN);

    expect(notePosts(calls)).toHaveLength(0);
  });

  it('still surfaces when the conversation has only ordinary messages', async () => {
    const calls = mockConversation({
      labels: [],
      messages: [
        { private: false, content: 'Can you port my number?' },
        { private: false, content: '🔔 **Human help needed**' }, // public, not a note
      ],
    });

    await surfaceHandoff(BASE_URL, ACCOUNT_ID, CW_CONV_ID, BOT_TOKEN);

    expect(notePosts(calls)).toHaveLength(1);
  });

  it('does not treat an unrelated private note as a handoff', async () => {
    const calls = mockConversation({
      labels: [],
      messages: [{ private: true, content: 'Called the customer back, no answer.' }],
    });

    await surfaceHandoff(BASE_URL, ACCOUNT_ID, CW_CONV_ID, BOT_TOKEN);

    expect(notePosts(calls)).toHaveLength(1);
  });

  // A handoff nobody sees is worse than a duplicate note, so an unreadable
  // conversation must not suppress the surfacing.
  it('fails open and still surfaces when the messages lookup errors', async () => {
    const calls = mockConversation({ labels: [], messages: [], messagesOk: false });

    await surfaceHandoff(BASE_URL, ACCOUNT_ID, CW_CONV_ID, BOT_TOKEN);

    expect(notePosts(calls)).toHaveLength(1);
  });

  it('fails open when the messages lookup throws', async () => {
    const calls: string[] = [];
    (global.fetch as any).mockImplementation((url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (url.endsWith('/labels') && method === 'GET') return Promise.resolve(jsonResponse({ payload: [] }));
      if (url.endsWith('/messages') && method === 'GET') return Promise.reject(new Error('network down'));
      return Promise.resolve(jsonResponse({}));
    });

    await surfaceHandoff(BASE_URL, ACCOUNT_ID, CW_CONV_ID, BOT_TOKEN);

    expect(notePosts(calls)).toHaveLength(1);
  });

  it('skips the messages lookup entirely when the label fast path already matched', async () => {
    const calls = mockConversation({ labels: [HANDOFF_LABEL], messages: [] });

    await surfaceHandoff(BASE_URL, ACCOUNT_ID, CW_CONV_ID, BOT_TOKEN);

    expect(calls.filter((c) => c.includes('/messages'))).toHaveLength(0);
  });
});

/**
 * E3, REWRITTEN.
 *
 * The original E3 ("assignment fails → no customer message, HUMAN_REQUESTED
 * retained") could not fail: it assumed Foundation performs the Chatwoot
 * assignment. Foundation issues no assignment call at all — rule #3 does it —
 * so E3 passed whether or not anything worked. See
 * `defect-handoff-assignment-performed-by-chatwoot-automation-not-foundation-2026-08-13`.
 *
 * The real failure mode is: NOTHING REACHES CHATWOOT AND FOUNDATION SAYS IT DID.
 * These tests target that, at the seam where it is detectable.
 */
describe('surfaceHandoff — E3 rewritten: reports what it actually achieved', () => {
  it('returns surfaced=false when the note, the label AND the status reopen all fail', async () => {
    (global.fetch as any).mockImplementation((url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      // Label GET succeeds so we get past the fast-path check with an empty set.
      if (url.endsWith('/labels') && method === 'GET') return Promise.resolve(jsonResponse({ payload: [] }));
      // Everything that WRITES fails.
      return Promise.resolve(jsonResponse({ error: 'boom' }, false));
    });

    const result = await surfaceHandoff(BASE_URL, ACCOUNT_ID, CW_CONV_ID, BOT_TOKEN);

    expect(result.notePosted).toBe(false);
    expect(result.labelApplied).toBe(false);
    expect(result.statusOpened).toBe(false);
    expect(result.alreadySurfaced).toBe(false);
    // The assertion that matters: the caller must be able to see that no person
    // can see this conversation, so it does not record HUMAN_OWNED.
    expect(result.surfaced).toBe(false);
  });

  it('returns surfaced=true when only the private note lands', async () => {
    (global.fetch as any).mockImplementation((url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/labels') && method === 'GET') return Promise.resolve(jsonResponse({ payload: [] }));
      if (url.endsWith('/messages') && method === 'POST') return Promise.resolve(jsonResponse({}));
      return Promise.resolve(jsonResponse({ error: 'boom' }, false));
    });

    const result = await surfaceHandoff(BASE_URL, ACCOUNT_ID, CW_CONV_ID, BOT_TOKEN);

    expect(result.notePosted).toBe(true);
    expect(result.labelApplied).toBe(false);
    expect(result.surfaced).toBe(true);
  });

  it('reports alreadySurfaced (still visible) when the label fast path matches', async () => {
    (global.fetch as any).mockImplementation((url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/labels') && method === 'GET') {
        return Promise.resolve(jsonResponse({ payload: [HANDOFF_LABEL] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const result = await surfaceHandoff(BASE_URL, ACCOUNT_ID, CW_CONV_ID, BOT_TOKEN);

    expect(result.alreadySurfaced).toBe(true);
    expect(result.surfaced).toBe(true);
    // Nothing was written this time round — the prior surface is what is visible.
    expect(result.notePosted).toBe(false);
  });

  it('does not claim an assignment: no field asserts one, because Foundation never assigns', async () => {
    (global.fetch as any).mockImplementation((url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/labels') && method === 'GET') return Promise.resolve(jsonResponse({ payload: [] }));
      return Promise.resolve(jsonResponse({}));
    });

    const result = await surfaceHandoff(BASE_URL, ACCOUNT_ID, CW_CONV_ID, BOT_TOKEN);

    expect(Object.keys(result).sort()).toEqual(
      ['alreadySurfaced', 'labelApplied', 'notePosted', 'statusOpened', 'surfaced'],
    );
    expect(result).not.toHaveProperty('assigned');
    // And no assignment endpoint was ever called.
    const calls = (global.fetch as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(calls.filter((u: string) => u.includes('/assignments'))).toHaveLength(0);
  });
});
