/**
 * manager-verification.test.ts — the pure core of Foundation-native manager
 * verification.
 *
 * The defect being pinned here is
 * `def-spine-manager-verification-activity-never-created-2026-07-29`: an
 * activity that was never created because the record link was written as a
 * readonly text field. These tests cover the decisions that surround that
 * write — operation identity, conflict detection and readback comparison — so
 * that the orchestration tests can be about sequencing rather than arithmetic.
 */

import { describe, it, expect } from 'vitest'
import {
  MANAGER_VERIFICATION_OPERATION,
  VERIFICATION_ACTIVITY_TYPE_NAMES,
  VERIFICATION_ACTIVITY_TYPE_XML_ID,
  VERIFICATION_TARGET_MODELS,
  isVerificationTargetModel,
  managerVerificationOperationId,
  operationConflict,
  readbackMismatch,
  splitXmlId,
  verificationDeadline,
  verificationNote,
  verificationSummary,
} from './manager-verification'

const OP = {
  tenantId: '43b006e4-33e0-42a8-bec7-4422ba290d79',
  workRefModel: 'project.task',
  workRefId: 2588,
  episodeId: 'sa-done-1',
  managerOdooResUserId: 5,
}

describe('the allowlist of models a verification activity may hang on', () => {
  it('is exactly project.task — a broad model parameter would be an arbitrary-write primitive', () => {
    expect([...VERIFICATION_TARGET_MODELS]).toEqual(['project.task'])
  })

  it('accepts project.task and refuses everything else, including other WorkRef models', () => {
    expect(isVerificationTargetModel('project.task')).toBe(true)
    expect(isVerificationTargetModel('mail.activity')).toBe(false)
    expect(isVerificationTargetModel('helpdesk.ticket')).toBe(false)
    expect(isVerificationTargetModel('res.users')).toBe(false)
    expect(isVerificationTargetModel('')).toBe(false)
    expect(isVerificationTargetModel(727)).toBe(false)
    expect(isVerificationTargetModel(null)).toBe(false)
  })
})

describe('managerVerificationOperationId', () => {
  it('is deterministic — a retry of the same episode derives the same id', () => {
    expect(managerVerificationOperationId(OP)).toBe(managerVerificationOperationId({ ...OP }))
  })

  it('names the operation, so one ledger can hold more than one kind of claim', () => {
    expect(managerVerificationOperationId(OP)).toContain(MANAGER_VERIFICATION_OPERATION)
  })

  it('changes for a fresh verification episode on the same task', () => {
    expect(managerVerificationOperationId({ ...OP, episodeId: 'sa-done-2' })).not.toBe(
      managerVerificationOperationId(OP),
    )
  })

  it('changes for a different task, tenant or manager', () => {
    const base = managerVerificationOperationId(OP)
    expect(managerVerificationOperationId({ ...OP, workRefId: 2589 })).not.toBe(base)
    expect(managerVerificationOperationId({ ...OP, tenantId: 'other-tenant' })).not.toBe(base)
    expect(managerVerificationOperationId({ ...OP, managerOdooResUserId: 2 })).not.toBe(base)
  })

  it('is NOT derived from summary text — display copy must not change operation identity', () => {
    // There is no summary input at all. Stated as a test because deriving an
    // idempotency key from a rendered string is how a label edit silently
    // becomes a duplicate write.
    const id = managerVerificationOperationId(OP)
    expect(id).not.toContain('Verify completion')
    expect(Object.keys(OP).sort()).toEqual(
      ['episodeId', 'managerOdooResUserId', 'tenantId', 'workRefId', 'workRefModel'].sort(),
    )
  })
})

describe('operationConflict', () => {
  const incoming = {
    tenantId: OP.tenantId,
    workRefId: 2588,
    managerOdooResUserId: 5,
    episodeId: 'sa-done-1',
  }

  it('passes when the stored claim describes the same operation', () => {
    expect(operationConflict({ ...incoming }, incoming)).toBeNull()
  })

  it('passes when the stored claim is absent or partial — absence is not disagreement', () => {
    expect(operationConflict(null, incoming)).toBeNull()
    expect(operationConflict({}, incoming)).toBeNull()
    expect(operationConflict({ tenantId: OP.tenantId }, incoming)).toBeNull()
  })

  it('refuses a stored claim that disagrees about tenant, task, manager or episode', () => {
    expect(operationConflict({ ...incoming, tenantId: 'other' }, incoming)).toBe('tenant')
    expect(operationConflict({ ...incoming, workRefId: 9999 }, incoming)).toBe('work_ref')
    expect(operationConflict({ ...incoming, managerOdooResUserId: 2 }, incoming)).toBe('manager')
    expect(operationConflict({ ...incoming, episodeId: 'sa-done-2' }, incoming)).toBe('episode')
  })
})

describe('readbackMismatch — requested:true is only allowed after this passes', () => {
  const expected = {
    resModel: 'project.task' as const,
    resModelId: 727,
    resId: 2588,
    userId: 5,
    activityTypeId: 4,
  }
  const actual = {
    activityId: 71993,
    resModel: 'project.task',
    resModelId: 727,
    resId: 2588,
    userId: 5,
    activityTypeId: 4,
  }

  it('passes when Odoo holds exactly what was asked for', () => {
    expect(readbackMismatch(expected, actual)).toBeNull()
  })

  it('refuses when there is no readback at all', () => {
    expect(readbackMismatch(expected, null)).toBe('no readback')
  })

  it('refuses an unusable activity id', () => {
    expect(readbackMismatch(expected, { ...actual, activityId: 0 })).toMatch(/activity id/)
  })

  it('refuses the exact failure the defect produced — an empty res_model', () => {
    // The live create left the link half-formed. If that ever happens again the
    // readback must catch it rather than reporting a verification that is not
    // attached to anything.
    expect(readbackMismatch(expected, { ...actual, resModel: '' })).toMatch(/res_model/)
    expect(readbackMismatch(expected, { ...actual, resModelId: null })).toMatch(/res_model_id/)
  })

  it('refuses a record hanging on the wrong task, manager or type', () => {
    expect(readbackMismatch(expected, { ...actual, resId: 2589 })).toMatch(/res_id/)
    expect(readbackMismatch(expected, { ...actual, userId: 2 })).toMatch(/user_id/)
    expect(readbackMismatch(expected, { ...actual, activityTypeId: 9 })).toMatch(/activity_type_id/)
  })
})

describe('verificationDeadline — date_deadline is REQUIRED on mail.activity', () => {
  it('returns a plain Odoo date, never a timestamp', () => {
    expect(verificationDeadline(new Date('2026-07-29T15:27:00Z'), 2)).toBe('2026-07-31')
  })

  it('rolls the month and year correctly', () => {
    expect(verificationDeadline(new Date('2026-12-31T23:59:00Z'), 2)).toBe('2027-01-02')
  })

  it('treats a nonsense window as same-day rather than producing an invalid date', () => {
    expect(verificationDeadline(new Date('2026-07-29T00:00:00Z'), -5)).toBe('2026-07-29')
    expect(verificationDeadline(new Date('2026-07-29T00:00:00Z'), Number.NaN)).toBe('2026-07-29')
  })
})

describe('splitXmlId', () => {
  it('splits the default To-Do handle', () => {
    expect(splitXmlId(VERIFICATION_ACTIVITY_TYPE_XML_ID)).toEqual({
      module: 'mail',
      name: 'mail_activity_data_todo',
    })
  })

  it('refuses anything that is not module.name', () => {
    expect(splitXmlId('mail')).toBeNull()
    expect(splitXmlId('.name')).toBeNull()
    expect(splitXmlId('mail.')).toBeNull()
    expect(splitXmlId('')).toBeNull()
  })
})

describe('summary and note', () => {
  it('keeps the summary within the Odoo char field', () => {
    expect(verificationSummary('x'.repeat(400))).toHaveLength(120)
    expect(verificationSummary('SL 001 - pilot')).toBe('Verify completion: SL 001 - pilot')
  })

  it('carries both correlation and operation id into Odoo, so the record is traceable', () => {
    const note = verificationNote({
      staffName: 'Hakeem Dalrymple',
      source: 'whatsapp',
      note: 'all panes fitted',
      correlationId: 'sw-ba290d79-task-2588-07k7i61',
      operationId: 'mv1:t:project.task#2588:ep:sa-1:mgr:5:manager_verification_request',
    })
    expect(note).toContain('Hakeem Dalrymple')
    expect(note).toContain('all panes fitted')
    expect(note).toContain('sw-ba290d79-task-2588-07k7i61')
    expect(note).toContain('manager_verification_request')
  })
})

describe('activity-type allowlist', () => {
  it('offers only generic To-Do spellings as the last resort', () => {
    expect([...VERIFICATION_ACTIVITY_TYPE_NAMES]).toEqual(['To-Do', 'To Do', 'Todo'])
  })
})
