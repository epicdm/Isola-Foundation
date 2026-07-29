/**
 * route.manager-verdict.test.ts — the manager loop at the webhook boundary.
 *
 * Two properties are load-bearing here and neither is visible in a unit test of
 * the resolver:
 *
 *   1. A manager verdict is NOT a second webhook processor. It is reached after
 *      the same wamid dedup claim, after the same tenant resolution, and it
 *      replies through the same send helper. If it ever branches ahead of the
 *      gate, cutover defect 4 reproduces on the number where it was already
 *      solved once.
 *   2. A staff DONE must actually reach the manager. Creating the Odoo activity
 *      and stopping there is how finished work sits unseen — and a duplicate
 *      delivery must not produce a second notice.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const STAFF_PHONE_NUMBER_ID = '1029700810228517';
const WA_HAKEEM = '17673173398';
const WA_PHILLIP = '17672351274';
const TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79';
const CORR = 'sw-ba290d79-task-2588-07k7i61';
const ACTIVITY = 71993;
const TASK = 2588;

const h = vi.hoisted(() => ({
  calls: [] as string[],
  claimed: new Set<string>(),
  menu: { kind: 'none' } as any,
  applyResult: {} as any,
  managerResolution: null as any,
  verdictResult: { ok: true, detail: { stage: { moved: true, stageName: 'Done', stageNameAfter: 'Done', readbackOk: true } } } as any,
  managerBinding: null as any,
  sentButtons: [] as any[],
  sentTexts: [] as any[],
  verdictArgs: [] as any[],
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
      findFirst: async () => ({ phone_number_id: STAFF_PHONE_NUMBER_ID, access_token: 'tok', token_env: null }),
    },
  },
}));
vi.mock('@/lib/engines', () => ({ getWhatsAppConfig: () => ({ graphVersion: 'v21.0' }) }));

const HAKEEM = {
  id: 'sb-hakeem', tenantId: TENANT, odooResUserId: 8, displayName: 'Hakeem Dalrymple',
  waId: WA_HAKEEM, role: 'staff', active: true, managerOdooResUserId: 5,
};
const PHILLIP = {
  id: 'sb-phillip', tenantId: TENANT, odooResUserId: 5, displayName: 'Phillip Alleyne',
  waId: WA_PHILLIP, role: 'manager', active: true, managerOdooResUserId: 2,
};
const TARGET = { odooModel: 'project.task', odooId: TASK, correlationId: CORR, label: 'BFF pilot task' };

vi.mock('@/lib/staff-ops/service', () => ({
  resolveInboundStaffTap: async (args: any) => {
    h.calls.push('resolve.tap');
    return {
      route: { route: 'staff_action', binding: HAKEEM, action: args.action, target: TARGET, note: null, resolution: 'explicit_ref', grammar: 'tap' },
      openWork: [TARGET],
    };
  },
  resolveInboundStaffMessage: async () => {
    h.calls.push('resolve.text');
    return { route: { route: 'staff_help', binding: HAKEEM, why: 'non_command' }, openWork: [] };
  },
  applyStaffAction: async () => {
    h.calls.push('apply.staff');
    return h.applyResult;
  },
  buildStaffReplyMenu: async () => {
    h.calls.push('menu');
    return h.menu;
  },
  resolveInboundManagerTap: async (args: any) => {
    h.calls.push('resolve.manager');
    return h.managerResolution ?? { ok: true, binding: PHILLIP, activity: { activityId: args.activityId, resModel: 'project.task', resId: TASK, userId: 5, summary: null }, taskId: TASK };
  },
  applyManagerVerdict: async (args: any) => {
    h.calls.push('apply.verdict');
    h.verdictArgs.push(args);
    return h.verdictResult;
  },
  findBindingByOdooUser: async () => {
    h.calls.push('lookup.manager');
    return h.managerBinding;
  },
}));

vi.mock('@/engines/whatsapp', () => ({
  sendText: async (_c: any, input: any) => { h.calls.push('send.text'); h.sentTexts.push(input); return { ok: true, status: 200, messageId: 'wamid.t' }; },
  sendInteractiveButtons: async (_c: any, input: any) => { h.calls.push('send.buttons'); h.sentButtons.push(input); return { ok: true, status: 200, messageId: 'wamid.b' }; },
  sendInteractiveList: async (_c: any, input: any) => { h.calls.push('send.list'); h.sentButtons.push(input); return { ok: true, status: 200, messageId: 'wamid.l' }; },
}));

import { POST } from './route';
import { encodeManagerVerdictId } from '@/lib/staff-ops/manager-verdict';
import { encodeMenuId } from '@/lib/staff-ops/staff-menu';

function change(msg: Record<string, unknown>) {
  return {
    field: 'messages',
    value: { metadata: { phone_number_id: STAFF_PHONE_NUMBER_ID, display_phone_number: '9043' }, messages: [msg] },
  };
}
function buttonTap(from: string, payload: string, wamid: string) {
  return change({ id: wamid, from, type: 'button', button: { payload, text: 'Approve' } });
}
function interactiveTap(from: string, id: string, wamid: string) {
  return change({ id: wamid, from, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 'x' } } });
}
function req(changes: unknown[]): NextRequest {
  return new NextRequest('http://localhost/api/webhooks/whatsapp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'w', changes }] }),
  });
}
const replies = () => h.sentButtons.length + h.sentTexts.length;

beforeEach(() => {
  vi.clearAllMocks();
  h.calls = []; h.claimed = new Set(); h.sentButtons = []; h.sentTexts = []; h.verdictArgs = [];
  h.menu = { kind: 'none' };
  h.applyResult = { ok: true, deduped: false, actionId: 'a1', odooResult: { chatter: { messagePost: [1] }, verification: { requested: true, activityId: ACTIVITY } } };
  h.managerResolution = null;
  h.verdictResult = { ok: true, detail: { stage: { moved: true, stageName: 'Done', stageNameAfter: 'Done', readbackOk: true } } };
  h.managerBinding = PHILLIP;
  handleInboundWhatsAppMock.mockResolvedValue(undefined);
  vi.stubEnv('META_WA_APP_SECRET', ''); vi.stubEnv('META_APP_SECRET', ''); vi.stubEnv('META_TEST_APP_SECRET', '');
  vi.stubEnv('STAFF_INBOUND_PHONE_NUMBER_IDS', STAFF_PHONE_NUMBER_ID);
  vi.stubEnv('STAFF_NOTIFICATION_PHONE_NUMBER_ID', '');
});

describe('manager verdict at the webhook boundary', () => {
  it('routes an Approve tap to the manager resolver, never the staff one', async () => {
    await POST(req([buttonTap(WA_PHILLIP, encodeManagerVerdictId('approve', ACTIVITY), 'w.1')]));
    expect(h.calls).toContain('resolve.manager');
    expect(h.calls).not.toContain('resolve.tap');
    expect(h.calls).not.toContain('resolve.text');
    expect(h.verdictArgs[0]).toMatchObject({ activityId: ACTIVITY, approved: true, taskId: TASK });
    expect(handleInboundWhatsAppMock).not.toHaveBeenCalled();
  });

  it('routes a Return tap with approved:false', async () => {
    await POST(req([buttonTap(WA_PHILLIP, encodeManagerVerdictId('return', ACTIVITY), 'w.2')]));
    expect(h.verdictArgs[0]).toMatchObject({ approved: false });
  });

  it('THE DEDUP CLAIM STILL RUNS FIRST — the manager branch is not a second processor', async () => {
    await POST(req([buttonTap(WA_PHILLIP, encodeManagerVerdictId('approve', ACTIVITY), 'w.3')]));
    expect(h.calls[0]).toBe('dedup.claim');
    expect(h.calls.indexOf('dedup.claim')).toBeLessThan(h.calls.indexOf('resolve.manager'));
  });

  it('a duplicate manager tap applies the verdict once and replies once', async () => {
    const p = encodeManagerVerdictId('approve', ACTIVITY);
    await POST(req([buttonTap(WA_PHILLIP, p, 'w.dup')]));
    await POST(req([buttonTap(WA_PHILLIP, p, 'w.dup')]));
    expect(h.calls.filter((c) => c === 'dedup.claim')).toHaveLength(2);
    expect(h.calls.filter((c) => c === 'apply.verdict')).toHaveLength(1);
    expect(replies()).toBe(1);
  });

  it('names the stage from the READBACK, and never claims a move that did not happen', async () => {
    h.verdictResult = { ok: true, detail: { stage: { moved: true, stageName: 'Done', stageNameAfter: 'Solved', readbackOk: true } } };
    await POST(req([buttonTap(WA_PHILLIP, encodeManagerVerdictId('approve', ACTIVITY), 'w.4')]));
    expect(h.sentTexts[0].body).toBe('✓ Approved — moved to Solved.');

    h.sentTexts = [];
    h.verdictResult = { ok: true, detail: { stage: { moved: false, why: 'no stage matching concept' } } };
    await POST(req([buttonTap(WA_PHILLIP, encodeManagerVerdictId('approve', ACTIVITY), 'w.5')]));
    expect(h.sentTexts[0].body).toBe('✓ Approved — recorded on the task.');
  });

  it('says so when the post-write readback could not confirm the stage', async () => {
    h.verdictResult = { ok: true, detail: { stage: { moved: true, stageName: 'Done', stageNameAfter: null, readbackOk: false } } };
    await POST(req([buttonTap(WA_PHILLIP, encodeManagerVerdictId('return', ACTIVITY), 'w.6')]));
    expect(h.sentTexts[0].body).toMatch(/could not be re-read/);
  });

  it('a failed Odoo write is reported as a failure, not a verdict', async () => {
    h.verdictResult = { ok: false, detail: 'odoo unreachable' };
    await POST(req([buttonTap(WA_PHILLIP, encodeManagerVerdictId('approve', ACTIVITY), 'w.7')]));
    expect(h.sentTexts[0].body).toMatch(/nothing changed in Odoo/);
    expect(replies()).toBe(1);
  });

  it('an already-resolved verification refuses with one honest reply and no verdict', async () => {
    h.managerResolution = { ok: false, refusal: 'activity_not_open', binding: PHILLIP };
    await POST(req([buttonTap(WA_PHILLIP, encodeManagerVerdictId('approve', ACTIVITY), 'w.8')]));
    expect(h.calls).not.toContain('apply.verdict');
    expect(h.sentTexts[0].body).toMatch(/already resolved/);
    expect(replies()).toBe(1);
  });

  it('another manager’s activity, and a non-manager, are each refused without a verdict', async () => {
    h.managerResolution = { ok: false, refusal: 'not_this_manager', binding: PHILLIP };
    await POST(req([buttonTap(WA_PHILLIP, encodeManagerVerdictId('approve', ACTIVITY), 'w.9')]));
    expect(h.sentTexts[0].body).toMatch(/another manager/);

    h.sentTexts = [];
    h.managerResolution = { ok: false, refusal: 'not_a_manager', binding: HAKEEM };
    await POST(req([buttonTap(WA_HAKEEM, encodeManagerVerdictId('approve', ACTIVITY), 'w.10')]));
    expect(h.sentTexts[0].body).toMatch(/not set up to verify/);
    expect(h.calls).not.toContain('apply.verdict');
  });

  it('an unresolved sender gets NO reply — we cannot vouch for who would receive it', async () => {
    h.managerResolution = { ok: false, refusal: 'identity', why: 'unknown_sender' };
    await POST(req([buttonTap('10000000000', encodeManagerVerdictId('approve', ACTIVITY), 'w.11')]));
    expect(replies()).toBe(0);
    expect(h.calls).not.toContain('apply.verdict');
  });
});

describe('staff DONE notifies the manager', () => {
  const donePayload = encodeMenuId('done', CORR);

  it('sends exactly one manager notice carrying Approve and Return', async () => {
    await POST(req([buttonTap(WA_HAKEEM, donePayload, 'w.d1')]));
    expect(h.calls).toContain('lookup.manager');
    // one reply to Hakeem + one notice to Phillip
    expect(h.sentButtons).toHaveLength(1);
    const notice = h.sentButtons[0];
    expect(notice.to).toBe(WA_PHILLIP);
    expect(notice.buttons.map((b: any) => b.id)).toEqual([
      encodeManagerVerdictId('approve', ACTIVITY),
      encodeManagerVerdictId('return', ACTIVITY),
    ]);
    expect(notice.body).toContain('Hakeem Dalrymple');
  });

  it('a DUPLICATE staff DONE sends no second notice — structurally, via the dedup gate', async () => {
    await POST(req([buttonTap(WA_HAKEEM, donePayload, 'w.d2')]));
    await POST(req([buttonTap(WA_HAKEEM, donePayload, 'w.d2')]));
    expect(h.calls.filter((c) => c === 'apply.staff')).toHaveLength(1);
    expect(h.sentButtons.filter((b) => b.to === WA_PHILLIP)).toHaveLength(1);
  });

  it('a re-sent DONE that dedupes inside applyStaffAction sends no notice either', async () => {
    // `deduped: true` carries no odooResult, so there is no verification to
    // announce — suppression needs no separate "already notified" record.
    h.applyResult = { ok: true, deduped: true, actionId: 'a1' };
    await POST(req([buttonTap(WA_HAKEEM, donePayload, 'w.d3')]));
    expect(h.sentButtons.filter((b) => b.to === WA_PHILLIP)).toHaveLength(0);
  });

  it('no verification raised (no manager) means no notice and no invented recipient', async () => {
    h.applyResult = { ok: true, deduped: false, actionId: 'a1', odooResult: { chatter: {}, verification: { requested: false, why: 'staff_member_has_no_manager' } } };
    await POST(req([buttonTap(WA_HAKEEM, donePayload, 'w.d4')]));
    expect(h.calls).not.toContain('lookup.manager');
    expect(h.sentButtons.filter((b) => b.to === WA_PHILLIP)).toHaveLength(0);
  });

  it('a manager with no reachable binding is loud, not silent', async () => {
    h.managerBinding = null;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await POST(req([buttonTap(WA_HAKEEM, donePayload, 'w.d5')]));
    expect(spy.mock.calls.flat().join(' ')).toMatch(/nobody was notified/);
    spy.mockRestore();
  });

  it('a non-DONE staff action raises no manager notice', async () => {
    await POST(req([buttonTap(WA_HAKEEM, encodeMenuId('ack', CORR), 'w.d6')]));
    expect(h.calls).not.toContain('lookup.manager');
  });
});

describe('no regressions', () => {
  it('staff interactive taps still reach the staff resolver', async () => {
    await POST(req([interactiveTap(WA_HAKEEM, encodeMenuId('start', CORR), 'w.r1')]));
    expect(h.calls).toContain('resolve.tap');
    expect(h.calls).not.toContain('resolve.manager');
  });

  it('typed staff commands are untouched', async () => {
    await POST(req([change({ id: 'w.r2', from: WA_HAKEEM, type: 'text', text: { body: 'MY TASKS' } })]));
    expect(h.calls).toContain('resolve.text');
    expect(h.calls).not.toContain('resolve.manager');
  });

  it('a foreign payload still falls through to text, not to the manager path', async () => {
    await POST(req([buttonTap(WA_HAKEEM, 'flow_token:whatever', 'w.r3')]));
    expect(h.calls).not.toContain('resolve.manager');
    expect(h.calls).toContain('resolve.text');
  });
});
