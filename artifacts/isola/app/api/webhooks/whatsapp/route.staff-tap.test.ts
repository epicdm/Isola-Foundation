/**
 * route.staff-tap.test.ts — Stage B, at the webhook boundary.
 *
 * The unit tests prove the tap RESOLVES correctly. This file proves the things
 * that only exist at the edge, and that have already bitten this number once:
 *
 *   1. A tap (`type: 'interactive'`) is no longer dropped by the non-text guard.
 *   2. The cross-path idempotency gate still runs FIRST. Two Meta apps remain
 *      subscribed to this WABA, so a tap is delivered twice exactly like a text
 *      message. Cutover defect 4 was this, on this number; branching to a tap
 *      handler ahead of the gate would reproduce it.
 *   3. One tap produces exactly ONE reply, carrying the post-write menu.
 *   4. A failed interactive send falls back to text — the confirmation is the
 *      part that carries the fact.
 *   5. A foreign or malformed interactive id is NOT trusted: it falls through
 *      to text resolution rather than being guessed at.
 *   6. The customer-facing agent is never reached from this path, on any input.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const STAFF_PHONE_NUMBER_ID = '1029700810228517'; // 9043 — staff inbound
const WA_ERIC = '17672958382';
const TENANT = 'epic-dev-pilot';
const CORR = 'corr-2292';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  claimed: new Set<string>(),
  menu: null as any,
  applyResult: { ok: true, deduped: false, actionId: 'sa-1' } as any,
  interactiveResult: { ok: true, status: 200, messageId: 'wamid.out' } as any,
  tapArgs: [] as any[],
  textArgs: [] as any[],
  sentButtons: [] as any[],
  sentFlows: [] as any[],
  sentTexts: [] as any[],
}));

const { handleInboundWhatsAppMock } = vi.hoisted(() => ({ handleInboundWhatsAppMock: vi.fn() }));
vi.mock('@/lib/agent', () => ({ handleInboundWhatsApp: handleInboundWhatsAppMock }));

vi.mock('@/lib/inbound-dedup', () => ({
  claimInboundMessageId: async (wamid: string) => {
    h.calls.push('dedup.claim');
    if (h.claimed.has(wamid)) return true;
    h.claimed.add(wamid);
    return false;
  },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    whatsAppNumber: {
      findUnique: async () => ({ tenant_id: TENANT }),
      findFirst: async () => ({
        phone_number_id: STAFF_PHONE_NUMBER_ID,
        access_token: 'tok',
        token_env: null,
      }),
    },
  },
}));

vi.mock('@/lib/engines', () => ({ getWhatsAppConfig: () => ({ graphVersion: 'v21.0' }) }));

const BINDING = {
  id: 'sb-epic-dev-2',
  tenantId: TENANT,
  odooResUserId: 2,
  displayName: 'Eric Giraud',
  waId: WA_ERIC,
  role: 'owner',
  active: true,
  managerOdooResUserId: null,
};

const TARGET = { odooModel: 'project.task', odooId: 2292, correlationId: CORR, label: 'DW 2068c' };

vi.mock('@/lib/staff-ops/service', () => ({
  resolveInboundStaffTap: async (args: any) => {
    h.calls.push('resolve.tap');
    h.tapArgs.push(args);
    return {
      route: {
        route: 'staff_action',
        binding: BINDING,
        action: args.action,
        target: TARGET,
        note: null,
        resolution: 'explicit_ref',
        grammar: 'tap',
      },
      openWork: [TARGET],
    };
  },
  resolveInboundStaffMessage: async (args: any) => {
    h.calls.push('resolve.text');
    h.textArgs.push(args);
    return { route: { route: 'staff_help', binding: BINDING, why: 'non_command' }, openWork: [] };
  },
  applyStaffAction: async () => {
    h.calls.push('apply');
    return h.applyResult;
  },
  buildStaffReplyMenu: async () => {
    h.calls.push('menu');
    return h.menu;
  },
}));

vi.mock('@/engines/whatsapp', () => ({
  sendText: async (_cfg: any, input: any) => {
    h.calls.push('send.text');
    h.sentTexts.push(input);
    return { ok: true, status: 200, messageId: 'wamid.text' };
  },
  sendInteractiveButtons: async (_cfg: any, input: any) => {
    h.calls.push('send.buttons');
    h.sentButtons.push(input);
    return h.interactiveResult;
  },
  sendInteractiveList: async (_cfg: any, input: any) => {
    h.calls.push('send.list');
    h.sentButtons.push(input);
    return h.interactiveResult;
  },
  // The module's real surface. An exhaustive vi.mock replaces the whole
  // namespace, so a name it omits throws where the route destructures it.
  sendInteractiveFlow: async (_cfg: any, input: any) => {
    h.calls.push('send.flow');
    h.sentFlows.push(input);
    return h.interactiveResult;
  },
}));

import { POST } from './route';
import { buildMenu, encodeMenuId } from '@/lib/staff-ops/staff-menu';

const IN_PROGRESS_RECORD = {
  odooModel: 'project.task' as const,
  odooId: 2292,
  name: 'DW 2068c - confirm pricing',
  projectId: 53,
  projectName: 'Dragon Windows',
  stageId: 121,
  stageName: 'In Progress',
  assigneeUserIds: [2],
  dateDeadline: null,
  writeDate: null,
};

function tapChange(tapId: string, wamid: string, kind: 'button' | 'list' = 'button') {
  const reply = { id: tapId, title: 'Start work' };
  return {
    field: 'messages',
    value: {
      metadata: { phone_number_id: STAFF_PHONE_NUMBER_ID, display_phone_number: '9043' },
      messages: [
        {
          id: wamid,
          from: WA_ERIC,
          type: 'interactive',
          interactive:
            kind === 'button'
              ? { type: 'button_reply', button_reply: reply }
              : { type: 'list_reply', list_reply: reply },
        },
      ],
    },
  };
}

function rawChange(msg: Record<string, unknown>) {
  return {
    field: 'messages',
    value: {
      metadata: { phone_number_id: STAFF_PHONE_NUMBER_ID, display_phone_number: '9043' },
      messages: [msg],
    },
  };
}

function webhookRequest(changes: unknown[]): NextRequest {
  return new NextRequest('http://localhost/api/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'waba-1', changes }],
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.calls = [];
  h.claimed = new Set();
  h.menu = buildMenu(IN_PROGRESS_RECORD, CORR); // buttons: update / done / blocked
  h.applyResult = { ok: true, deduped: false, actionId: 'sa-1' };
  h.interactiveResult = { ok: true, status: 200, messageId: 'wamid.out' };
  h.tapArgs = [];
  h.textArgs = [];
  h.sentButtons = [];
  h.sentFlows = [];
  h.sentTexts = [];
  handleInboundWhatsAppMock.mockResolvedValue(undefined);
  vi.stubEnv('META_WA_APP_SECRET', '');
  vi.stubEnv('META_APP_SECRET', '');
  vi.stubEnv('META_TEST_APP_SECRET', '');
  vi.stubEnv('STAFF_INBOUND_PHONE_NUMBER_IDS', STAFF_PHONE_NUMBER_ID);
  vi.stubEnv('STAFF_NOTIFICATION_PHONE_NUMBER_ID', '');
});

describe('staff webhook — interactive taps', () => {
  it('a button tap is acted on, and routed through the tap resolver rather than the text grammar', async () => {
    const res = await POST(webhookRequest([tapChange(encodeMenuId('start', CORR), 'wamid.tap1')]));

    expect(res.status).toBe(200);
    expect(h.tapArgs).toHaveLength(1);
    expect(h.tapArgs[0]).toMatchObject({
      waId: WA_ERIC,
      action: 'start',
      correlationId: CORR,
      channelTenantId: TENANT,
    });
    // The text grammar is not consulted at all for a tap.
    expect(h.calls).not.toContain('resolve.text');
    // And the customer-facing brain is never reachable from this path.
    expect(handleInboundWhatsAppMock).not.toHaveBeenCalled();
  });

  it('a list-row tap is handled the same way as a button tap', async () => {
    await POST(webhookRequest([tapChange(encodeMenuId('done', CORR), 'wamid.tap-list', 'list')]));
    expect(h.tapArgs).toHaveLength(1);
    expect(h.tapArgs[0]).toMatchObject({ action: 'done', correlationId: CORR });
  });

  it('the idempotency gate runs BEFORE the tap is resolved — not after', async () => {
    await POST(webhookRequest([tapChange(encodeMenuId('start', CORR), 'wamid.tap2')]));
    expect(h.calls[0]).toBe('dedup.claim');
    expect(h.calls.indexOf('dedup.claim')).toBeLessThan(h.calls.indexOf('resolve.tap'));
  });

  it('the SAME tap delivered twice produces one action and one reply, not two', async () => {
    const id = encodeMenuId('start', CORR);
    await POST(webhookRequest([tapChange(id, 'wamid.dup')]));
    await POST(webhookRequest([tapChange(id, 'wamid.dup')])); // second Meta app

    expect(h.calls.filter((c) => c === 'dedup.claim')).toHaveLength(2);
    expect(h.calls.filter((c) => c === 'apply')).toHaveLength(1);
    expect(h.sentButtons).toHaveLength(1);
    expect(h.sentTexts).toHaveLength(0);
  });

  it('the reply carries the post-write menu as tappable buttons, and is sent exactly once', async () => {
    await POST(webhookRequest([tapChange(encodeMenuId('start', CORR), 'wamid.tap3')]));

    expect(h.sentButtons).toHaveLength(1);
    expect(h.sentTexts).toHaveLength(0);
    const sent = h.sentButtons[0];
    expect(sent.to).toBe(WA_ERIC);
    expect(sent.body).toBe('✓ Started — logged on the task.');
    // In-Progress's menu — no "start" button comes back on work just started.
    expect(sent.buttons.map((b: any) => b.id)).toEqual([
      encodeMenuId('update', CORR),
      encodeMenuId('done', CORR),
      encodeMenuId('blocked', CORR),
    ]);
  });

  it('a failed interactive send falls back to plain text with the same body', async () => {
    h.interactiveResult = { ok: false, status: 400, error: 'bad payload' };
    await POST(webhookRequest([tapChange(encodeMenuId('start', CORR), 'wamid.tap4')]));

    expect(h.sentButtons).toHaveLength(1);
    expect(h.sentTexts).toHaveLength(1);
    expect(h.sentTexts[0].body).toBe('✓ Started — logged on the task.');
  });

  it('when there is no menu the reply is plain text — no empty interactive payload', async () => {
    h.menu = { kind: 'none' };
    await POST(webhookRequest([tapChange(encodeMenuId('start', CORR), 'wamid.tap5')]));

    expect(h.sentButtons).toHaveLength(0);
    expect(h.sentTexts).toHaveLength(1);
  });

  it('a foreign interactive id is not trusted — it falls through to text resolution', async () => {
    await POST(webhookRequest([tapChange('flow_token:whatever', 'wamid.foreign')]));

    expect(h.calls).not.toContain('resolve.tap');
    expect(h.calls).toContain('resolve.text');
    expect(handleInboundWhatsAppMock).not.toHaveBeenCalled();
  });

  it('a typed message still routes through the text grammar, unchanged', async () => {
    await POST(
      webhookRequest([
        rawChange({ id: 'wamid.text1', from: WA_ERIC, type: 'text', text: { body: 'ACK' } }),
      ]),
    );

    expect(h.textArgs).toHaveLength(1);
    expect(h.textArgs[0]).toMatchObject({ waId: WA_ERIC, text: 'ACK', channelTenantId: TENANT });
    expect(h.calls).not.toContain('resolve.tap');
  });

  it('a non-actionable message type is still ignored — the handler is never entered', async () => {
    await POST(
      webhookRequest([rawChange({ id: 'wamid.img', from: WA_ERIC, type: 'image', image: { id: 'x' } })]),
    );

    expect(h.calls).toEqual([]); // not even the dedup claim
    expect(handleInboundWhatsAppMock).not.toHaveBeenCalled();
  });

  it('an interactive message with no usable id is ignored rather than half-processed', async () => {
    await POST(
      webhookRequest([
        rawChange({ id: 'wamid.empty', from: WA_ERIC, type: 'interactive', interactive: {} }),
      ]),
    );

    expect(h.calls).toEqual([]);
  });
});
