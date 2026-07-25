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
