/**
 * button-payload.test.ts — the TEMPLATE quick-reply payload round trip.
 *
 * A free-form interactive tap and a template quick-reply tap must be the same
 * fact wearing two envelopes. That only holds if ONE codec mints both and ONE
 * decoder reads both, so this file pins exactly that: mint a template payload,
 * decode it with the interactive decoder, get the same action and episode back.
 *
 * It also pins the two things Meta will reject at send time rather than at
 * approval time — the 128-character payload ceiling, and the component shape a
 * quick-reply parameter must have — because both fail on a staff handset if
 * they are not caught here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  WA_LIMITS,
  decodeMenuId,
  encodeMenuId,
  encodeTemplateQuickReplyPayload,
} from './staff-menu'
import { sendTemplate } from '@/engines/whatsapp'

const CORR = 'sw-ba290d79-task-2292-1lxvft5'

describe('template quick-reply payload codec', () => {
  it('mints the SAME payload the interactive path mints — one codec, not two', () => {
    expect(encodeTemplateQuickReplyPayload('start', CORR)).toBe(encodeMenuId('start', CORR))
  })

  it('round-trips through the interactive decoder', () => {
    for (const action of ['ack', 'start', 'update', 'blocked', 'done'] as const) {
      const payload = encodeTemplateQuickReplyPayload(action, CORR)
      expect(decodeMenuId(payload)).toEqual({ action, correlationId: CORR })
    }
  })

  it('refuses a payload over Meta’s 128-character template ceiling', () => {
    // Well under the 256 an interactive button id allows, so `buttonId` passing
    // proves nothing here. That is the whole reason for a separate assertion.
    const long = 'x'.repeat(WA_LIMITS.templateButtonPayload)
    expect(WA_LIMITS.templateButtonPayload).toBeLessThan(WA_LIMITS.buttonId)
    expect(() => encodeTemplateQuickReplyPayload('start', long)).toThrow(/128/)
  })

  it('a real correlation id fits with room to spare', () => {
    expect(encodeTemplateQuickReplyPayload('blocked', CORR).length).toBeLessThanOrEqual(
      WA_LIMITS.templateButtonPayload,
    )
  })

  it('a foreign payload decodes to null so the caller falls back rather than guessing', () => {
    expect(decodeMenuId('flow_token:whatever')).toBeNull()
    expect(decodeMenuId('sa:start')).toBeNull()
    expect(decodeMenuId(`sa:frobnicate:${CORR}`)).toBeNull()
    expect(decodeMenuId('')).toBeNull()
  })
})

describe('sendTemplate — quick-reply button components', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.out' }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function bodySent() {
    return JSON.parse(fetchMock.mock.calls[0][1].body as string)
  }

  it('emits one indexed quick_reply component per payload, in button order', async () => {
    await sendTemplate(
      { graphVersion: 'v21.0' },
      {
        phoneId: '1029700810228517',
        token: 'tok',
        to: '17672958382',
        name: 'isola_staff_task_v1',
        language: 'en_US',
        params: ['Eric', 'DW 2068c', 'today'],
        quickReplyPayloads: [
          encodeTemplateQuickReplyPayload('ack', CORR),
          encodeTemplateQuickReplyPayload('start', CORR),
        ],
      },
    )

    const components = bodySent().template.components
    // Body first, then the buttons — Meta indexes buttons positionally and
    // rejects the whole send if an index has no matching approved button.
    expect(components[0].type).toBe('body')
    expect(components[1]).toEqual({
      type: 'button',
      sub_type: 'quick_reply',
      index: '0',
      parameters: [{ type: 'payload', payload: encodeMenuId('ack', CORR) }],
    })
    expect(components[2].index).toBe('1')
    expect(components[2].parameters[0].payload).toBe(encodeMenuId('start', CORR))
  })

  it('a template with no quick replies is byte-for-byte what it was before — no empty component', async () => {
    await sendTemplate(
      { graphVersion: 'v21.0' },
      {
        phoneId: '1029700810228517',
        token: 'tok',
        to: '17672958382',
        name: 'isola_staff_task_v1',
        language: 'en_US',
        params: ['Eric'],
      },
    )

    const components = bodySent().template.components
    expect(components).toHaveLength(1)
    expect(components[0].type).toBe('body')
  })

  it('a template with neither params nor quick replies sends no components key at all', async () => {
    await sendTemplate(
      { graphVersion: 'v21.0' },
      {
        phoneId: '1029700810228517',
        token: 'tok',
        to: '17672958382',
        name: 'hello_world',
        language: 'en_US',
      },
    )
    expect(bodySent().template.components).toBeUndefined()
  })
})
