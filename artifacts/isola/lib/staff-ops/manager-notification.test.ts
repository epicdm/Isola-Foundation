/**
 * manager-notification.test.ts — the manager is told, exactly once, only about a
 * verification that really exists, and only from the staff channel.
 *
 * The numbering follows the dispatch's twenty required proofs so a reviewer can
 * check coverage without reading the implementation. Items 1–3 are ORDERING
 * facts about `applyDoneVerification`; they are asserted twice — once as this
 * module's own precondition refusals, and once against the service source, which
 * is the same technique `manager-verification-service.test.ts` already uses to
 * pin an ordering that a mock cannot express.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MANAGER_VERIFICATION_PURPOSE,
  MANAGER_VERIFICATION_TEMPLATE,
  MANAGER_VERIFICATION_TEMPLATE_APPROVED_ENV,
  MANAGER_VERIFICATION_TEMPLATE_PARAM_COUNT,
  MANAGER_VERIFICATION_TEMPLATE_SPEC,
  buildManagerVerificationMessage,
  enqueueManagerVerificationNotification,
  managerVerificationDedupeKey,
  managerVerificationTemplateSpec,
  notificationIdentity,
  type ManagerNotificationDeps,
  type ManagerVerificationNotificationInput,
} from './manager-notification'
import { decodeManagerVerdictId } from './manager-verdict'
import { STAFF_PHONE_NUMBER_ID_ENV } from './staff-channel'

const TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79'
const TASK = 2590
const ACTIVITY = 177
const EPISODE = 'sa-done-2590-ep1'
const STAFF_CHANNEL = '852032459972066'
const CUSTOMER_CHANNEL = '278390858690809' // the 6737 line — must never be chosen

const OPERATION = `mv1:${TENANT}:project.task#${TASK}:ep:${EPISODE}:mgr:5:manager_verification_request`

function input(over: Partial<ManagerVerificationNotificationInput> = {}): ManagerVerificationNotificationInput {
  return {
    tenantId: TENANT,
    activityId: ACTIVITY,
    operationId: OPERATION,
    episodeId: EPISODE,
    correlationId: 'sw-ba290d79-task-2590-abc',
    workRefModel: 'project.task',
    workRefId: TASK,
    workTitle: 'Replace the reception handset',
    projectName: 'Internal Operations',
    staffDisplayName: 'Hakeem Joseph',
    reportedResult: 'Handset replaced and tested',
    dueByWording: '2026-08-01',
    manager: { id: 'sb-mgr-1', waId: '17677654321', odooResUserId: 5, active: true, displayName: 'Phillip Alleyne' },
    ...over,
  }
}

function deps(over: Partial<ManagerNotificationDeps> = {}): ManagerNotificationDeps {
  return {
    resolveStaffChannel: vi.fn(() => ({ ok: true as const, phoneNumberId: STAFF_CHANNEL })),
    enqueue: vi.fn(async () => ({ enqueued: true, id: 'ob-1' })),
    findByDedupeKey: vi.fn(async () => null),
    templateSpec: { approved: true },
    env: {} as unknown as NodeJS.ProcessEnv,
    ...over,
  }
}

/** The single enqueue call's arguments. */
function enqueued(d: ManagerNotificationDeps): Record<string, any> {
  return (d.enqueue as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, any>
}

// ── 1–3. Ordering: only a PROVEN activity earns a notification ───────────────

describe('1–3. the notification cannot precede a proven activity', () => {
  it('1. a proven readback enqueues exactly one manager notification', async () => {
    const d = deps()
    const r = await enqueueManagerVerificationNotification(input(), d)
    expect(r.notified).toBe(true)
    expect(d.enqueue).toHaveBeenCalledTimes(1)
    if (r.notified) expect(r.activityId).toBe(ACTIVITY)
  })

  it('2–3. no activity id — creation or readback failure — enqueues nothing', async () => {
    for (const bad of [0, -1, Number.NaN] as number[]) {
      const d = deps()
      const r = await enqueueManagerVerificationNotification(input({ activityId: bad }), d)
      expect(r.notified).toBe(false)
      if (!r.notified) expect(r.why).toBe('activity_not_proven')
      expect(d.enqueue).not.toHaveBeenCalled()
    }
  })

  it('2–3. a missing operation id or episode id enqueues nothing', async () => {
    for (const over of [{ operationId: '' }, { episodeId: '' }]) {
      const d = deps()
      const r = await enqueueManagerVerificationNotification(input(over), d)
      expect(r.notified).toBe(false)
      if (!r.notified) expect(r.why).toBe('activity_not_proven')
      expect(d.enqueue).not.toHaveBeenCalled()
    }
  })

  it('2–3. service.ts calls the enqueue only inside the proven branch, after every refusal', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'service.ts'), 'utf8')
    const call = src.indexOf('enqueueManagerVerificationNotification(')
    expect(call).toBeGreaterThan(-1)
    // Exactly one CALL site. The import names the symbol without a paren, so
    // this counts invocations only.
    expect(src.split('enqueueManagerVerificationNotification(').length - 1).toBe(1)
    // It comes after the readback-mismatch refusal and after the create refusal.
    expect(src.indexOf("refuse('activity_readback_mismatch'")).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(src.indexOf("refuse('activity_readback_mismatch'"))
    expect(call).toBeGreaterThan(src.indexOf("'activity_readback_failed' : 'activity_create_failed'"))
    // And it is not reachable from the deduped short-circuit, which returns first.
    expect(call).toBeGreaterThan(src.indexOf('deduped: true'))
  })
})

// ── 4–7. Recipient and channel ──────────────────────────────────────────────

describe('4–7. recipient and channel are authoritative or nothing is sent', () => {
  it('4. a missing manager binding enqueues nothing', async () => {
    const d = deps()
    const r = await enqueueManagerVerificationNotification(
      input({ manager: { id: '', waId: '1767', odooResUserId: 5, active: true, displayName: '' } }),
      d,
    )
    expect(r.notified).toBe(false)
    if (!r.notified) expect(r.why).toBe('manager_binding_missing')
    expect(d.enqueue).not.toHaveBeenCalled()
  })

  it('4. an INACTIVE manager binding enqueues nothing', async () => {
    const d = deps()
    const r = await enqueueManagerVerificationNotification(
      input({ manager: { ...input().manager, active: false } }),
      d,
    )
    expect(r.notified).toBe(false)
    if (!r.notified) expect(r.why).toBe('manager_binding_inactive')
    expect(d.enqueue).not.toHaveBeenCalled()
  })

  it('5. a missing manager destination enqueues nothing', async () => {
    for (const waId of [null, '', '   ', 'not-a-number'] as (string | null)[]) {
      const d = deps()
      const r = await enqueueManagerVerificationNotification(
        input({ manager: { ...input().manager, waId } }),
        d,
      )
      expect(r.notified).toBe(false)
      if (!r.notified) expect(r.why).toBe('manager_destination_missing')
      expect(d.enqueue).not.toHaveBeenCalled()
    }
  })

  it('6. a missing staff channel fails closed BEFORE the outbox is touched', async () => {
    const d = deps({
      resolveStaffChannel: vi.fn(() => ({ ok: false as const, reason: `${STAFF_PHONE_NUMBER_ID_ENV} is not configured` })),
    })
    const r = await enqueueManagerVerificationNotification(input(), d)
    expect(r.notified).toBe(false)
    if (!r.notified) {
      expect(r.why).toBe('staff_channel_not_configured')
      // Names the configuration gap...
      expect(r.detail).toContain(STAFF_PHONE_NUMBER_ID_ENV)
      // ...without printing any value.
      expect(r.detail).not.toContain(STAFF_CHANNEL)
    }
    expect(d.enqueue).not.toHaveBeenCalled()
    expect(d.findByDedupeKey).not.toHaveBeenCalled()
  })

  it('7. the customer channel can never be selected — the row is marked staff so the drain forbids the default', async () => {
    const d = deps()
    await enqueueManagerVerificationNotification(input(), d)
    const call = enqueued(d)
    // work_ref_model is what isStaffNotification() keys on; without it the drain
    // sends with forbidDefaultNumber:false and falls back to the customer line.
    expect(call.workRefModel).toBe('project.task')
    expect(call.workRefId).toBe(TASK)
    expect(JSON.stringify(call)).not.toContain(CUSTOMER_CHANNEL)
  })

  it('7. the correlation is set in the SAME insert, never stamped afterwards', async () => {
    const d = deps()
    await enqueueManagerVerificationNotification(input(), d)
    const call = enqueued(d)
    expect(call.correlationId).toBe(input().correlationId)
    // All three arrive together — the race this closes is a row that exists but
    // is not yet marked staff.
    expect(call.workRefModel).toBeTruthy()
    expect(call.workRefId).toBeTruthy()
    expect(call.correlationId).toBeTruthy()
  })
})

// ── 8–11. Exactly-once ──────────────────────────────────────────────────────

describe('8–11. exactly once per verification episode', () => {
  it('8. the dedupe key is derived from the operation id, carrying the full identity', () => {
    const key = managerVerificationDedupeKey(OPERATION)
    expect(key).toBe(`staff:${MANAGER_VERIFICATION_PURPOSE}:${OPERATION}`)
    for (const part of [TENANT, `project.task#${TASK}`, `ep:${EPISODE}`, 'mgr:5', 'manager_verification_request']) {
      expect(key).toContain(part)
    }
  })

  it('8. the same episode retried reports duplicate and enqueues once', async () => {
    const d = deps({
      findByDedupeKey: vi.fn(async () => ({ id: 'ob-1', payload: payloadFor(input()) })),
    })
    const r = await enqueueManagerVerificationNotification(input(), d)
    expect(r.notified).toBe(false)
    if (!r.notified) expect(r.why).toBe('duplicate')
    expect(d.enqueue).not.toHaveBeenCalled()
  })

  it('9. a duplicate DONE/webhook does not produce a second manager notification', async () => {
    // First pass enqueues; the row now exists, so the second pass finds it.
    let stored: Record<string, unknown> | null = null
    const d = deps({
      enqueue: vi.fn(async (p: any) => {
        stored = p.payload
        return { enqueued: true, id: 'ob-1' }
      }),
      findByDedupeKey: vi.fn(async () => (stored ? { id: 'ob-1', payload: stored } : null)),
    })
    const first = await enqueueManagerVerificationNotification(input(), d)
    const second = await enqueueManagerVerificationNotification(input(), d)
    expect(first.notified).toBe(true)
    expect(second.notified).toBe(false)
    expect(d.enqueue).toHaveBeenCalledTimes(1)
  })

  it('8. the unique index alone also stops a duplicate — a racing insert reports duplicate, not success', async () => {
    const d = deps({ enqueue: vi.fn(async () => ({ enqueued: false, reason: 'duplicate' })) })
    const r = await enqueueManagerVerificationNotification(input(), d)
    expect(r.notified).toBe(false)
    if (!r.notified) expect(r.why).toBe('duplicate')
  })

  it('10. a conflicting payload under the same dedupe key FAILS rather than being swallowed', async () => {
    const other = payloadFor(input({ activityId: 999, operationId: OPERATION.replace('ep:' + EPISODE, 'ep:other') }))
    const d = deps({ findByDedupeKey: vi.fn(async () => ({ id: 'ob-1', payload: other })) })
    const r = await enqueueManagerVerificationNotification(input(), d)
    expect(r.notified).toBe(false)
    if (!r.notified) expect(r.why).toBe('dedupe_payload_conflict')
    expect(d.enqueue).not.toHaveBeenCalled()
  })

  it('10. a reworded reported result is NOT a conflict — display copy is not identity', async () => {
    const before = payloadFor(input({ reportedResult: 'Handset replaced' }))
    const d = deps({ findByDedupeKey: vi.fn(async () => ({ id: 'ob-1', payload: before })) })
    const r = await enqueueManagerVerificationNotification(input({ reportedResult: 'Handset replaced and tested' }), d)
    expect(r.notified).toBe(false)
    if (!r.notified) expect(r.why).toBe('duplicate')
  })

  it('11. a NEW verification episode on the same task is independently deliverable', async () => {
    const ep2 = OPERATION.replace(`ep:${EPISODE}`, 'ep:sa-done-2590-ep2')
    expect(managerVerificationDedupeKey(ep2)).not.toBe(managerVerificationDedupeKey(OPERATION))
    const d = deps()
    const r = await enqueueManagerVerificationNotification(input({ operationId: ep2, episodeId: 'sa-done-2590-ep2' }), d)
    expect(r.notified).toBe(true)
    expect(d.enqueue).toHaveBeenCalledTimes(1)
  })
})

function payloadFor(i: ManagerVerificationNotificationInput): Record<string, unknown> {
  return {
    operationId: i.operationId,
    episodeId: i.episodeId,
    activityId: i.activityId,
    managerOdooResUserId: i.manager.odooResUserId,
    workRefModel: i.workRefModel,
    workRefId: i.workRefId,
  }
}

// ── 12–15. What the manager is told ─────────────────────────────────────────

describe('12–15. the message is authoritative and claims nothing', () => {
  it('12. the manager comes from the binding, and the destination is that binding’s wa_id', async () => {
    const d = deps()
    await enqueueManagerVerificationNotification(input(), d)
    const call = enqueued(d)
    expect(call.contact).toBe('+17677654321')
    expect(call.payload.managerBindingId).toBe('sb-mgr-1')
    expect(call.payload.managerOdooResUserId).toBe(5)
  })

  it('13. the task reference cannot drift from the Odoo record', async () => {
    const d = deps()
    await enqueueManagerVerificationNotification(input(), d)
    const call = enqueued(d)
    expect(call.payload.workRefId).toBe(TASK)
    expect(call.payload.templateParams[0]).toBe(`#${TASK}`)
    // The button payloads name the ACTIVITY, which is the verification episode —
    // not the task, which may carry several over its life.
    expect(decodeManagerVerdictId(call.payload.buttonPayloads.approve)).toEqual({ verdict: 'approve', activityId: ACTIVITY })
  })

  it('14. the notification is correlated to the Odoo activity id', async () => {
    const d = deps()
    await enqueueManagerVerificationNotification(input(), d)
    expect(enqueued(d).payload.activityId).toBe(ACTIVITY)
  })

  it('15. only SUPPORTED commands are exposed — the two button verdicts and nothing else', () => {
    const msg = buildManagerVerificationMessage(input(), { approved: true })
    for (const verdict of ['approve', 'return'] as const) {
      expect(decodeManagerVerdictId(msg.buttonPayloads[verdict])).toEqual({
        verdict,
        activityId: ACTIVITY,
      })
    }
    // The body must not advertise a text command, because parseStaffCommand has
    // no approve/return verb — there is nothing inbound to receive one.
    const body = MANAGER_VERIFICATION_TEMPLATE_SPEC.body
    for (const staffVerb of ['ACK', 'START', 'BLOCKED', 'DONE', 'MY TASKS', 'HELP']) {
      expect(body).not.toContain(staffVerb)
    }
    expect(MANAGER_VERIFICATION_TEMPLATE_SPEC.buttons).toHaveLength(2)
  })

  it('15. the message never claims a verdict has occurred', () => {
    const text = `${MANAGER_VERIFICATION_TEMPLATE_SPEC.body} ${buildManagerVerificationMessage(input(), { approved: true }).params.join(' ')}`
    for (const claim of ['approved', 'verified', 'has been approved', 'rejected']) {
      expect(text.toLowerCase()).not.toContain(claim)
    }
    expect(MANAGER_VERIFICATION_TEMPLATE_SPEC.body).toContain('Verification needed')
  })

  it('15. every template parameter is flattened and non-empty', () => {
    const msg = buildManagerVerificationMessage(
      input({ workTitle: 'line\none\ttwo', reportedResult: '   ', projectName: null, staffDisplayName: '' }),
      { approved: true },
    )
    expect(msg.params).toHaveLength(MANAGER_VERIFICATION_TEMPLATE_PARAM_COUNT)
    for (const p of msg.params) {
      expect(p.trim().length).toBeGreaterThan(0)
      expect(p).not.toMatch(/[\r\n\t]/)
      expect(p).not.toMatch(/ {4,}/)
    }
  })

  it('15. an unapproved template is not sendable and nothing is enqueued', async () => {
    const d = deps({ templateSpec: { approved: false } })
    const r = await enqueueManagerVerificationNotification(input(), d)
    expect(r.notified).toBe(false)
    if (!r.notified) expect(r.why).toBe('template_not_approved')
    expect(d.enqueue).not.toHaveBeenCalled()
  })

  it('15. the shipped spec is UNAPPROVED, and approval is an operator action', () => {
    expect(MANAGER_VERIFICATION_TEMPLATE_SPEC.approved).toBe(false)
    expect(managerVerificationTemplateSpec({} as unknown as NodeJS.ProcessEnv).approved).toBe(false)
    // Strict equality with 'true' — a stray value must not start messaging managers.
    for (const v of ['1', 'yes', 'TRUE', 'True', '']) {
      expect(
        managerVerificationTemplateSpec({ [MANAGER_VERIFICATION_TEMPLATE_APPROVED_ENV]: v } as unknown as NodeJS.ProcessEnv).approved,
      ).toBe(false)
    }
    expect(
      managerVerificationTemplateSpec({ [MANAGER_VERIFICATION_TEMPLATE_APPROVED_ENV]: 'true' } as unknown as NodeJS.ProcessEnv).approved,
    ).toBe(true)
  })
})

// ── 16–20. Provider truth, and no unrelated path ────────────────────────────

describe('16–20. provider truth and boundaries', () => {
  it('16. consent denial is reported truthfully, not as a send', async () => {
    const d = deps({ enqueue: vi.fn(async () => ({ enqueued: false, reason: 'consent_denied' })) })
    const r = await enqueueManagerVerificationNotification(input(), d)
    expect(r.notified).toBe(false)
    if (!r.notified) expect(r.why).toBe('consent_denied')
  })

  it('16. the consent basis is the internal staff directive, not a customer or owner basis', async () => {
    const d = deps()
    await enqueueManagerVerificationNotification(input(), d)
    const call = enqueued(d)
    expect(call.consentBasis).toBe('internal_staff_directive')
    expect(call.consentBasis).not.toBe('owner_self_notification')
  })

  it('17. a retry after a provider failure preserves exactly-once — the key is unchanged', async () => {
    const a = managerVerificationDedupeKey(OPERATION)
    const b = managerVerificationDedupeKey(OPERATION)
    expect(a).toBe(b)
    // The identity is derived only from authoritative fields, so a retry that
    // re-reads slightly different display copy still collapses onto one row.
    expect(notificationIdentity(payloadFor(input({ reportedResult: 'x' })))).toBe(
      notificationIdentity(payloadFor(input({ reportedResult: 'y' }))),
    )
  })

  it('18. no customer-AI gate and no Clawith path is involved', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'manager-notification.ts'), 'utf8')
    for (const forbidden of ['clawith', 'ISOLA_AI_LOOP_ENABLED', 'brain-provider', 'customer-tools']) {
      expect(src.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })

  it('19. no BFF-v2 path is involved', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'manager-notification.ts'), 'utf8')
    for (const forbidden of ['bff-v2', 'bffv2', 'bff_v2']) {
      expect(src.toLowerCase()).not.toContain(forbidden)
    }
  })

  it('20. it goes through the ONE existing outbox — no second send path', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'manager-notification.ts'), 'utf8')
    // Comments are stripped first. The header DISCUSSES sendTemplate — explaining
    // that the outbox can only send templates is exactly why this module does not
    // call it — and a scan that cannot tell prose from code would fail on its own
    // documentation.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const forbidden of ['sendTemplate', 'graph.facebook.com', 'fetch(', 'prisma.']) {
      expect(code).not.toContain(forbidden)
    }
    expect(MANAGER_VERIFICATION_TEMPLATE).toBe('epic_manager_verification_v1')
  })
})
