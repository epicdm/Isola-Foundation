import { describe, expect, it } from 'vitest'

import { callerClassOf } from './caller-class'
import { deriveOperationId } from './ledger'
import { deriveOperationId as legacyDeriveOperationId } from '../customer-tools/operation'

describe('callerClassOf', () => {
  const neutral = deriveOperationId({
    callerClass: 'foundation_staff',
    tenantId: 't',
    companyId: 'c',
    actionType: 'note.create',
    objectType: 'res.partner',
    objectId: '1',
    idempotencyKey: 'k',
  })
  const legacy = legacyDeriveOperationId({
    tenantId: 't',
    toolName: 'customer.business_note',
    conversationId: 'conv-1',
    hint: 'k',
    requestHash: 'h',
  })

  it('reads a real neutral id as a staff operation', () => {
    expect(callerClassOf(neutral)).toEqual({
      known: true,
      callerClass: 'foundation_staff',
      basis: 'id_scheme',
    })
  })

  it('reads a real legacy id as a customer-agent operation', () => {
    expect(callerClassOf(legacy)).toEqual({
      known: true,
      callerClass: 'customer_agent',
      basis: 'id_scheme',
    })
  })

  it('prefers what the envelope actually says over what the id implies', () => {
    expect(callerClassOf(legacy, 'foundation_staff')).toEqual({
      known: true,
      callerClass: 'foundation_staff',
      basis: 'envelope',
    })
  })

  it('says it does not know rather than guessing', () => {
    const v = callerClassOf('something-else-entirely')
    expect(v.known).toBe(false)
    if (v.known) return
    expect(v.reason).toMatch(/matches no known scheme/)
  })

  it('the two schemes never produce the same string for the same material', () => {
    expect(neutral).not.toBe(legacy)
    expect(neutral.length).not.toBe(legacy.length)
  })
})
