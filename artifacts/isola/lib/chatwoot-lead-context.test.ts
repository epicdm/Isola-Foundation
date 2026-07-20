import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectApplySource, stampLeadContext, PILOT_STAGES, NEW_STAGE } from './chatwoot-lead-context';

const BASE_URL = 'https://inbox.epic.dm';
const ACCOUNT_ID = '5';
const CW_CONV_ID = 42;
const BOT_TOKEN = 'test-bot-token';
const APPLY_PREFILL = "Hi, I'd like to apply for the founding pilot for my business.";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn();
});

describe('PILOT_STAGES / NEW_STAGE', () => {
  it('are the exact 7 ratified stages, in order, starting at New', () => {
    expect(PILOT_STAGES).toEqual([
      'New',
      'Qualified',
      'Demo',
      'Proposal',
      'Commitment pending',
      'Won',
      'Lost',
    ]);
    expect(NEW_STAGE).toBe('New');
  });
});

describe('detectApplySource', () => {
  it('matches the exact founding-pilot apply-link prefill from app/page.tsx', () => {
    expect(detectApplySource(APPLY_PREFILL)).toBe('founding-pilot-apply');
  });

  it('matches when the message has incidental leading/trailing whitespace', () => {
    expect(detectApplySource(`  ${APPLY_PREFILL}  `)).toBe('founding-pilot-apply');
  });

  it('returns null for an unrelated first message', () => {
    expect(detectApplySource('hey is anyone there?')).toBeNull();
  });

  it('returns null for a message that only partially overlaps the known prefill', () => {
    expect(detectApplySource("I'd like to apply for the founding pilot")).toBeNull();
  });
});

describe('stampLeadContext — proves: a tagged inbound lands in New with source populated', () => {
  it('stamps pilot_stage=New and source=founding-pilot-apply for a matching first message', async () => {
    let sentBody: any = null;
    (global.fetch as any).mockImplementation((url: string, init?: any) => {
      sentBody = JSON.parse(init.body);
      return Promise.resolve(jsonResponse({}));
    });

    await stampLeadContext(BASE_URL, ACCOUNT_ID, CW_CONV_ID, BOT_TOKEN, APPLY_PREFILL);

    expect((global.fetch as any).mock.calls).toHaveLength(1);
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${CW_CONV_ID}/custom_attributes`);
    expect(init.method).toBe('POST');
    expect(init.headers.api_access_token).toBe(BOT_TOKEN);
    expect(sentBody).toEqual({
      custom_attributes: { pilot_stage: 'New', source: 'founding-pilot-apply' },
    });
  });

  it('stamps only pilot_stage=New (no source) when the first message is not a known apply prefill', async () => {
    let sentBody: any = null;
    (global.fetch as any).mockImplementation((url: string, init?: any) => {
      sentBody = JSON.parse(init.body);
      return Promise.resolve(jsonResponse({}));
    });

    await stampLeadContext(BASE_URL, ACCOUNT_ID, CW_CONV_ID, BOT_TOKEN, 'hello, is this the right number?');

    expect(sentBody).toEqual({ custom_attributes: { pilot_stage: 'New' } });
  });

  it('never throws when the Chatwoot API call fails', async () => {
    (global.fetch as any).mockImplementation(() => Promise.resolve(jsonResponse({}, false)));
    await expect(
      stampLeadContext(BASE_URL, ACCOUNT_ID, CW_CONV_ID, BOT_TOKEN, APPLY_PREFILL),
    ).resolves.toBeUndefined();
  });

  it('never throws when fetch itself rejects (network error)', async () => {
    (global.fetch as any).mockImplementation(() => Promise.reject(new Error('network down')));
    await expect(
      stampLeadContext(BASE_URL, ACCOUNT_ID, CW_CONV_ID, BOT_TOKEN, APPLY_PREFILL),
    ).resolves.toBeUndefined();
  });
});
