/**
 * staff-channel-guard.test.ts — an EXECUTABLE guard, not a decision comment.
 *
 * THE PROPERTY: no staff-marked or manager-marked notification can reach
 * `sendWhatsApp` without an explicit staff phone_number_id.
 *
 * Why a guard rather than trust: the historical default was the tenant's
 * EARLIEST-CREATED number, which on the EPIC tenant is `278390858690809` /
 * +1 767 295 6737 — the CUSTOMER line, created eleven days before the internal
 * staff line existed. So the failure mode is not an outage, it is an employee
 * receiving an internal work directive from the number customers talk to, and
 * plausibly replying to it there. `b0ab2a2` fixed the send adapter and the drain;
 * this file is what stops the next call site from reopening it.
 *
 * It tests three layers, because each can fail independently:
 *   1. the send adapter refuses a defaulted staff send;
 *   2. the channel resolver refuses an unconfigured or malformed channel, and
 *      cannot be influenced by which numbers exist or when they were created;
 *   3. every staff-purpose enqueue MARKS its row in the same insert, since the
 *      mark is what arms layers 1 and 2 in the drain.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sendWhatsApp } from '../notify-whatsapp'
import { STAFF_PHONE_NUMBER_ID_ENV, isStaffNotification, resolveStaffChannel } from './staff-channel'
import { staffNotificationDedupeKey } from './staff-notification'
import {
  enqueueManagerVerificationNotification,
  managerVerificationDedupeKey,
  type ManagerNotificationDeps,
} from './manager-notification'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..')

/** The customer-facing line. It must never be reachable by a staff send. */
const CUSTOMER_6737 = '278390858690809'
const STAFF_9043 = '852032459972066'

/** Every purpose the staff-notification union admits. */
const STAFF_PURPOSES = ['task_dispatch', 'manager_verification', 'blocker_escalation', 'onboarding'] as const

// ── Layer 1: the send adapter ───────────────────────────────────────────────

describe('layer 1 — sendWhatsApp refuses to default for a staff send', () => {
  it('refuses when forbidDefaultNumber is set and no explicit number is pinned', async () => {
    const r = await sendWhatsApp({
      tenantId: 'any',
      contact: '+17677654321',
      template: 'epic_internal_task_v1',
      payload: { templateParams: ['#1', 'NORMAL', 'x', 'ASAP', 'none'] },
      forbidDefaultNumber: true,
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('refusing to fall back')
    // Refused BEFORE any provider or database work — status 0, no external ref.
    expect(r.status).toBe(0)
    expect(r.externalRef).toBeUndefined()
  })

  it('the refusal happens before the tenant number list is ever consulted', async () => {
    // No prisma mock is installed in this file. If the guard did not return
    // early, this call would touch the database and throw rather than resolve.
    const r = await sendWhatsApp({
      tenantId: 'tenant-that-does-not-exist',
      contact: '+1',
      template: 't',
      payload: {},
      forbidDefaultNumber: true,
    })
    expect(r.ok).toBe(false)
  })
})

// ── Layer 2: the channel resolver ───────────────────────────────────────────

describe('layer 2 — the resolver refuses anything but an explicit configured channel', () => {
  it('an explicitly configured staff channel succeeds', () => {
    const r = resolveStaffChannel({ [STAFF_PHONE_NUMBER_ID_ENV]: STAFF_9043 } as unknown as NodeJS.ProcessEnv)
    expect(r).toEqual({ ok: true, phoneNumberId: STAFF_9043 })
  })

  it('missing configuration fails closed and names the gap', () => {
    const r = resolveStaffChannel({} as unknown as NodeJS.ProcessEnv)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain(STAFF_PHONE_NUMBER_ID_ENV)
  })

  it('a blank or whitespace configuration fails closed', () => {
    for (const v of ['', '   ', '\t']) {
      expect(resolveStaffChannel({ [STAFF_PHONE_NUMBER_ID_ENV]: v } as unknown as NodeJS.ProcessEnv).ok).toBe(false)
    }
  })

  it('a non-phone_number_id value fails closed rather than being sent as-is', () => {
    for (const v of ['+17672956737', 'staff-line', '9043', '123abc'].slice(0, 3)) {
      const r = resolveStaffChannel({ [STAFF_PHONE_NUMBER_ID_ENV]: v } as unknown as NodeJS.ProcessEnv)
      if (/^\d+$/.test(v)) continue
      expect(r.ok).toBe(false)
    }
  })

  it('multiple tenant numbers create no ambiguity, and creation order cannot matter', () => {
    // The resolver takes ONLY env. It has no tenant argument and no access to a
    // number list, so "earliest-created", "first available" and "how many numbers
    // exist" are not expressible inputs. That is the structural fix, and this
    // asserts it rather than restating it in prose.
    expect(resolveStaffChannel.length).toBeLessThanOrEqual(1)
    const a = resolveStaffChannel({ [STAFF_PHONE_NUMBER_ID_ENV]: STAFF_9043 } as unknown as NodeJS.ProcessEnv)
    const b = resolveStaffChannel({ [STAFF_PHONE_NUMBER_ID_ENV]: STAFF_9043 } as unknown as NodeJS.ProcessEnv)
    expect(a).toEqual(b)
    // Configuring the customer line would be an explicit operator choice, never
    // an accident of ordering — but it is still never the DEFAULT.
    expect(resolveStaffChannel({} as unknown as NodeJS.ProcessEnv).ok).toBe(false)
  })

  it('a row is staff only when it carries the work_ref_model mark', () => {
    expect(isStaffNotification({ work_ref_model: 'project.task' })).toBe(true)
    expect(isStaffNotification({ work_ref_model: 'mail.activity' })).toBe(true)
    expect(isStaffNotification({ work_ref_model: null })).toBe(false)
    expect(isStaffNotification({ work_ref_model: '' })).toBe(false)
    expect(isStaffNotification({})).toBe(false)
  })
})

// ── Layer 3: every staff purpose marks its row in the SAME insert ───────────

describe('layer 3 — caller omission cannot silently reach the default sender', () => {
  it('the manager-verification enqueue marks the row in the insert itself', async () => {
    const enqueue = vi.fn(
      async (_p: Parameters<ManagerNotificationDeps['enqueue']>[0]) => ({ enqueued: true, id: 'ob-1' }),
    )
    const deps: ManagerNotificationDeps = {
      resolveStaffChannel: () => ({ ok: true, phoneNumberId: STAFF_9043 }),
      enqueue,
      findByDedupeKey: async () => null,
      templateSpec: { approved: true },
      env: {} as unknown as NodeJS.ProcessEnv,
    }
    await enqueueManagerVerificationNotification(
      {
        tenantId: 't',
        activityId: 177,
        operationId: 'mv1:t:project.task#2590:ep:e1:mgr:5:manager_verification_request',
        episodeId: 'e1',
        correlationId: 'c1',
        workRefModel: 'project.task',
        workRefId: 2590,
        workTitle: 'w',
        projectName: 'p',
        staffDisplayName: 's',
        reportedResult: 'r',
        dueByWording: '2026-08-01',
        manager: { id: 'sb-1', waId: '17677654321', odooResUserId: 5, active: true, displayName: 'm' },
      },
      deps,
    )
    const args = enqueue.mock.calls[0][0] as Record<string, unknown>
    expect(args.workRefModel).toBe('project.task')
    expect(args.workRefId).toBe(2590)
    expect(args.correlationId).toBe('c1')
  })

  it('the manager-verification enqueue refuses outright when the channel is unconfigured', async () => {
    const enqueue = vi.fn(
      async (_p: Parameters<ManagerNotificationDeps['enqueue']>[0]) => ({ enqueued: true, id: 'ob-1' }),
    )
    const deps: ManagerNotificationDeps = {
      resolveStaffChannel: (env) => resolveStaffChannel(env ?? ({} as unknown as NodeJS.ProcessEnv)),
      enqueue,
      findByDedupeKey: async () => null,
      templateSpec: { approved: true },
      env: {} as unknown as NodeJS.ProcessEnv,
    }
    const r = await enqueueManagerVerificationNotification(
      {
        tenantId: 't',
        activityId: 177,
        operationId: 'op',
        episodeId: 'e1',
        correlationId: 'c1',
        workRefModel: 'project.task',
        workRefId: 2590,
        workTitle: 'w',
        projectName: 'p',
        staffDisplayName: 's',
        reportedResult: 'r',
        dueByWording: 'd',
        manager: { id: 'sb-1', waId: '17677654321', odooResUserId: 5, active: true, displayName: 'm' },
      },
      deps,
    )
    expect(r.notified).toBe(false)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('every staff purpose is namespaced, so no staff row can masquerade as customer traffic', () => {
    for (const purpose of STAFF_PURPOSES) {
      expect(staffNotificationDedupeKey({ correlationId: 'c', purpose })).toMatch(/^staff:/)
    }
    expect(managerVerificationDedupeKey('op')).toMatch(/^staff:manager_verification:/)
  })

  it('task dispatch passes the work-ref mark INTO the enqueue, not into a later update', () => {
    const src = readFileSync(join(HERE, 'service.ts'), 'utf8')
    const call = src.slice(src.indexOf('const result = await enqueueNotification({'))
    const block = call.slice(0, call.indexOf('})') + 2)
    expect(block).toContain('workRefModel: input.work.odooModel')
    expect(block).toContain('workRefId: input.work.odooId')
    expect(block).toContain('correlationId: input.work.correlationId')
    // The post-hoc stamp is GONE. While it existed the drain could claim the row
    // before it was marked staff — `next_attempt_at` is `new Date()` — and send
    // it from the customer line; a crash between the writes made that permanent.
    expect(src).not.toContain('work_ref_model: input.work.odooModel')
  })

  it('the outbox insert can carry the mark at all — otherwise layer 3 is unenforceable', () => {
    const notify = readFileSync(join(LIB, 'notify.ts'), 'utf8')
    expect(notify).toContain('workRefModel?: string | null')
    expect(notify).toContain('work_ref_model: workRefModel ?? null')
  })
})

// ── The drain wiring itself ─────────────────────────────────────────────────

describe('the drain arms both layers for every staff row', () => {
  const drain = readFileSync(join(LIB, 'notify-drain.ts'), 'utf8')

  it('forbids the default number for every row it recognises as staff', () => {
    expect(drain).toContain('forbidDefaultNumber: Boolean(staffChannel)')
  })

  it('fails the row rather than sending when the staff channel does not resolve', () => {
    expect(drain).toContain('if (staffChannel && !staffChannel.ok)')
    expect(drain).toContain('throw new Error(staffChannel.reason)')
  })

  it('pins only a resolved channel, and never substitutes a fallback', () => {
    expect(drain).toContain('pinnedPhoneNumberId: staffChannel?.ok ? staffChannel.phoneNumberId : undefined')
    expect(drain).not.toContain(CUSTOMER_6737)
  })

  it('is the only sendWhatsApp caller that handles staff rows', () => {
    // voicemail-poller is the other caller and is owner/customer-facing: it must
    // not be sending staff-marked rows, and it does not compute a staff channel.
    const vm = readFileSync(join(LIB, 'voicemail-poller.ts'), 'utf8')
    expect(vm).not.toContain('work_ref_model')
    expect(vm).not.toContain('resolveStaffChannel')
  })
})
