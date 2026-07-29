/**
 * route.template-button.test.ts — TEMPLATE quick-reply taps at the webhook boundary.
 *
 * WHY THIS FILE EXISTS. Stage B taught the webhook to act on a tap, but only on
 * the two shapes a FREE-FORM interactive message produces:
 * `interactive.button_reply` and `interactive.list_reply`. A tap on a
 * TEMPLATE quick-reply button does not arrive in either shape — it arrives as
 *
 *     msg.type === 'button'
 *     msg.button.payload   // developer-defined, supplied at send time
 *     msg.button.text      // the frozen visible label
 *
 * so every template button tap fell into the non-text guard and was dropped
 * silently. That is why `isola_staff_task_v1` was deliberately submitted
 * text-only: shipping a template whose buttons do nothing repeats the exact
 * defect Stage B was built to fix.
 *
 * What is proved here is NOT a second state machine. It is the opposite: that
 * a template payload is normalised to the SAME tap id and travels the SAME
 * resolver, dedup gate, apply step and post-write menu as an interactive tap,
 * and inherits every refusal that path already makes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const STAFF_PHONE_NUMBER_ID = '1029700810228517'; // 9043 — staff inbound
const WA_ERIC = '17672958382';
const TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79';
const CORR = 'sw-ba290d79-task-2292-1lxvft5';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  claimed: new Set<string>(),
  menu: null as any,
  applyResult: { ok: true, deduped: false, actionId: 'sa-1' } as any,
  interactiveResult: { ok: true, status: 200, messageId: 'wamid.out' } as any,
  tapArgs: [] as any[],
  textArgs: [] as any[],
  sentButtons: [] as any[],
  sentTexts: [] as any[],
  /** Per-test override of what the tap resolver returns. */
  tapResolution: null as any,
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
  id: 'sb-epic-2',
  tenantId: TENANT,
  odooResUserId: 2,
  displayName: 'Eric Giraud',
  waId: WA_ERIC,
  role: 'owner',
  active: true,
  managerOdooResUserId: null,
};

const TARGET = { odooModel: 'project.task', odooId: 2292, correlationId: CORR, label: 'DW 2068c' };

/** The authorised, same-tenant, currently-held outcome. */
function grantedTap(action: string) {
  return {
    route: {
      route: 'staff_action',
      binding: BINDING,
      action,
      target: TARGET,
      note: null,
      resolution: 'explicit_ref',
      grammar: 'tap',
    },
    openWork: [TARGET],
  };
}

vi.mock('@/lib/staff-ops/service', () => ({
  resolveInboundStaffTap: async (args: any) => {
    h.calls.push('resolve.tap');
    h.tapArgs.push(args);
    return h.tapResolution ?? grantedTap(args.action);
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
}));

import { POST } from './route';
import { buildMenu, encodeMenuId, encodeTemplateQuickReplyPayload } from '@/lib/staff-ops/staff-menu';

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

/** A TEMPLATE quick-reply tap, as Meta actually delivers it. */
function templateButtonChange(payload: string, wamid: string, text = 'Start work') {
  return {
    field: 'messages',
    value: {
      metadata: { phone_number_id: STAFF_PHONE_NUMBER_ID, display_phone_number: '9043' },
      messages: [
        {
          id: wamid,
          from: WA_ERIC,
          type: 'button',
          button: { payload, text },
        },
      ],
    },
  };
}

/** A FREE-FORM interactive tap, for the no-regression cases. */
function interactiveChange(tapId: string, wamid: string, kind: 'button' | 'list' = 'button') {
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

/** Every outbound reply, however rendered. The count that matters is this one. */
function repliesSent(): number {
  return h.sentButtons.length + h.sentTexts.length;
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
  h.sentTexts = [];
  h.tapResolution = null;
  handleInboundWhatsAppMock.mockResolvedValue(undefined);
  vi.stubEnv('META_WA_APP_SECRET', '');
  vi.stubEnv('META_APP_SECRET', '');
  vi.stubEnv('META_TEST_APP_SECRET', '');
  vi.stubEnv('STAFF_INBOUND_PHONE_NUMBER_IDS', STAFF_PHONE_NUMBER_ID);
  vi.stubEnv('STAFF_NOTIFICATION_PHONE_NUMBER_ID', '');
});

describe('staff webhook — template quick-reply taps', () => {
  // 1. authorized same-tenant button payload
  it('acts on an authorised same-tenant template payload, through the tap resolver', async () => {
    const payload = encodeTemplateQuickReplyPayload('start', CORR);
    const res = await POST(webhookRequest([templateButtonChange(payload, 'wamid.tpl1')]));

    expect(res.status).toBe(200);
    expect(h.tapArgs).toHaveLength(1);
    expect(h.tapArgs[0]).toMatchObject({
      waId: WA_ERIC,
      action: 'start',
      correlationId: CORR,
      channelTenantId: TENANT,
    });
    expect(h.calls).toContain('apply');
    // The text grammar is never consulted — the payload is not a label.
    expect(h.calls).not.toContain('resolve.text');
    // And the customer-facing brain is unreachable from this path.
    expect(handleInboundWhatsAppMock).not.toHaveBeenCalled();
  });

  it('a template payload and the identical id arriving as interactive resolve identically', async () => {
    const payload = encodeTemplateQuickReplyPayload('done', CORR);
    await POST(webhookRequest([templateButtonChange(payload, 'wamid.same-a')]));
    await POST(webhookRequest([interactiveChange(payload, 'wamid.same-b')]));

    expect(h.tapArgs).toHaveLength(2);
    expect(h.tapArgs[0]).toEqual(h.tapArgs[1]);
  });

  // 2. unauthorized user
  it('an unknown sender is refused: nothing applied, nothing replied', async () => {
    h.tapResolution = { route: { route: 'exception', why: 'unknown_sender' }, openWork: [] };
    await POST(webhookRequest([templateButtonChange(encodeMenuId('done', CORR), 'wamid.unauth')]));

    expect(h.calls).toContain('resolve.tap');
    expect(h.calls).not.toContain('apply');
    expect(repliesSent()).toBe(0);
  });

  // 3. wrong tenant
  it('a cross-tenant payload is refused: the payload does not buy authority', async () => {
    h.tapResolution = {
      route: { route: 'exception', why: 'cross_tenant', candidates: [BINDING] },
      openWork: [],
    };
    await POST(webhookRequest([templateButtonChange(encodeMenuId('done', CORR), 'wamid.xtenant')]));

    expect(h.calls).not.toContain('apply');
    expect(repliesSent()).toBe(0);
  });

  // 4. stale assignment
  it('a payload for work the person no longer holds is refused, and answered with help', async () => {
    h.tapResolution = {
      route: { route: 'staff_help', binding: BINDING, attemptedAction: 'done', why: 'unknown_reference' },
      openWork: [{ ...TARGET, correlationId: 'sw-ba290d79-task-9999-other', odooId: 9999 }],
    };
    await POST(webhookRequest([templateButtonChange(encodeMenuId('done', CORR), 'wamid.stale')]));

    expect(h.calls).not.toContain('apply');
    // Refused, but not ignored — one honest reply, no menu attached.
    expect(repliesSent()).toBe(1);
    expect(h.sentTexts).toHaveLength(1);
  });

  // 5. completed / closed work
  it('a payload for closed work is refused — a frozen template button outlives the episode', async () => {
    h.tapResolution = {
      route: { route: 'staff_help', binding: BINDING, attemptedAction: 'start', why: 'unknown_reference' },
      openWork: [], // the episode closed; nothing is held any more
    };
    await POST(webhookRequest([templateButtonChange(encodeMenuId('start', CORR), 'wamid.closed')]));

    expect(h.calls).not.toContain('apply');
    expect(repliesSent()).toBe(1);
  });

  // 6. duplicate delivery
  it('the SAME template tap delivered twice produces one action and one reply', async () => {
    const payload = encodeTemplateQuickReplyPayload('start', CORR);
    await POST(webhookRequest([templateButtonChange(payload, 'wamid.tpl-dup')]));
    await POST(webhookRequest([templateButtonChange(payload, 'wamid.tpl-dup')])); // second Meta app

    expect(h.calls.filter((c) => c === 'dedup.claim')).toHaveLength(2);
    expect(h.calls.filter((c) => c === 'apply')).toHaveLength(1);
    expect(repliesSent()).toBe(1);
  });

  it('the idempotency gate runs BEFORE the template payload is resolved — not after', async () => {
    await POST(
      webhookRequest([templateButtonChange(encodeMenuId('start', CORR), 'wamid.tpl-order')]),
    );
    expect(h.calls[0]).toBe('dedup.claim');
    expect(h.calls.indexOf('dedup.claim')).toBeLessThan(h.calls.indexOf('resolve.tap'));
  });

  // 7. malformed payload
  it('a malformed payload is not guessed at — it falls through to text resolution', async () => {
    await POST(webhookRequest([templateButtonChange('sa:start', 'wamid.malformed')]));

    expect(h.calls).not.toContain('resolve.tap');
    expect(h.calls).toContain('resolve.text');
    expect(h.calls).not.toContain('apply');
    expect(handleInboundWhatsAppMock).not.toHaveBeenCalled();
  });

  it('the visible button LABEL is never used as a typed command', async () => {
    // 'Start work' is a real menu label. If the label leaked into the text
    // grammar, a foreign payload would still start work — which is exactly the
    // label matching the developer-defined id exists to eliminate.
    await POST(webhookRequest([templateButtonChange('flow_token:whatever', 'wamid.label', 'Start work')]));

    expect(h.textArgs).toHaveLength(1);
    expect(h.textArgs[0].text).toBe('');
    expect(h.calls).not.toContain('apply');
  });

  // 8. unsupported payload
  it('a well-formed payload naming an action we do not implement is refused', async () => {
    await POST(webhookRequest([templateButtonChange(`sa:frobnicate:${CORR}`, 'wamid.unsupported')]));

    expect(h.calls).not.toContain('resolve.tap');
    expect(h.calls).toContain('resolve.text');
    expect(h.calls).not.toContain('apply');
  });

  it('a template button with an empty payload is ignored outright, not half-processed', async () => {
    await POST(
      webhookRequest([rawChange({ id: 'wamid.empty-btn', from: WA_ERIC, type: 'button', button: { text: 'x' } })]),
    );
    expect(h.calls).toEqual([]); // not even the dedup claim
  });

  // 9. post-write menu
  it('the reply carries the POST-write menu, not the menu the template was minted with', async () => {
    await POST(webhookRequest([templateButtonChange(encodeMenuId('start', CORR), 'wamid.tpl-menu')]));

    expect(h.calls.indexOf('apply')).toBeLessThan(h.calls.indexOf('menu'));
    expect(h.sentButtons).toHaveLength(1);
    // In-Progress's actions — no "start" comes back on work just started.
    expect(h.sentButtons[0].buttons.map((b: any) => b.id)).toEqual([
      encodeMenuId('update', CORR),
      encodeMenuId('done', CORR),
      encodeMenuId('blocked', CORR),
    ]);
  });

  // 10. exactly one reply
  it('one template tap produces exactly one outbound message, on every rendering path', async () => {
    await POST(webhookRequest([templateButtonChange(encodeMenuId('start', CORR), 'wamid.one-a')]));
    expect(repliesSent()).toBe(1);

    // no menu -> plain text, still one
    h.sentButtons = [];
    h.sentTexts = [];
    h.menu = { kind: 'none' };
    await POST(webhookRequest([templateButtonChange(encodeMenuId('start', CORR), 'wamid.one-b')]));
    expect(repliesSent()).toBe(1);
  });

  it('a failed interactive send falls back to text — the confirmation is what carries the fact', async () => {
    h.interactiveResult = { ok: false, status: 400, error: 'bad payload' };
    await POST(webhookRequest([templateButtonChange(encodeMenuId('start', CORR), 'wamid.tpl-fb')]));

    expect(h.sentButtons).toHaveLength(1);
    expect(h.sentTexts).toHaveLength(1);
    expect(h.sentTexts[0].body).toBe(h.sentButtons[0].body);
  });

  // 11. no regression — typed commands
  it('NO REGRESSION: a typed message still routes through the text grammar, unchanged', async () => {
    await POST(
      webhookRequest([rawChange({ id: 'wamid.typed', from: WA_ERIC, type: 'text', text: { body: 'ACK 2292' } })]),
    );

    expect(h.textArgs).toHaveLength(1);
    expect(h.textArgs[0]).toMatchObject({ waId: WA_ERIC, text: 'ACK 2292', channelTenantId: TENANT });
    expect(h.calls).not.toContain('resolve.tap');
  });

  // 12. no regression — interactive.button_reply
  it('NO REGRESSION: an interactive button_reply is still acted on', async () => {
    await POST(webhookRequest([interactiveChange(encodeMenuId('start', CORR), 'wamid.reg-btn')]));
    expect(h.tapArgs).toHaveLength(1);
    expect(h.tapArgs[0]).toMatchObject({ action: 'start', correlationId: CORR });
    expect(h.calls).toContain('apply');
  });

  // 13. no regression — interactive.list_reply
  it('NO REGRESSION: an interactive list_reply is still acted on', async () => {
    await POST(webhookRequest([interactiveChange(encodeMenuId('done', CORR), 'wamid.reg-list', 'list')]));
    expect(h.tapArgs).toHaveLength(1);
    expect(h.tapArgs[0]).toMatchObject({ action: 'done', correlationId: CORR });
    expect(h.calls).toContain('apply');
  });

  it('NO REGRESSION: a non-actionable message type is still ignored entirely', async () => {
    await POST(
      webhookRequest([rawChange({ id: 'wamid.img2', from: WA_ERIC, type: 'image', image: { id: 'x' } })]),
    );
    expect(h.calls).toEqual([]);
    expect(handleInboundWhatsAppMock).not.toHaveBeenCalled();
  });
});
