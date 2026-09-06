import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockGetLiteContext = vi.fn()
const mockIsBffConfigured = vi.fn()
const mockGetBffConfig = vi.fn()

vi.mock('@/engines/bff', () => ({
  getLiteContext: (...args: unknown[]) => mockGetLiteContext(...args),
}))
vi.mock('@/lib/engines', () => ({
  isBffConfigured: () => mockIsBffConfigured(),
  getBffConfig: () => mockGetBffConfig(),
}))

import { readPersonalLineContext } from './personal-line-source'

const CONFIG = { baseUrl: 'https://bff.epic.dm', internalSecret: 'shh' }

beforeEach(() => {
  mockGetLiteContext.mockReset()
  mockIsBffConfigured.mockReset()
  mockGetBffConfig.mockReset()
  mockIsBffConfigured.mockReturnValue(true)
  mockGetBffConfig.mockReturnValue(CONFIG)
})

describe('readPersonalLineContext', () => {
  it('reports no-phone-on-file without calling bff-v2 at all', async () => {
    const result = await readPersonalLineContext(null)
    expect(result.data).toEqual({ state: 'no-phone-on-file' })
    expect(mockGetLiteContext).not.toHaveBeenCalled()
  })

  it('reports no-phone-on-file for a blank phone', async () => {
    const result = await readPersonalLineContext('   ')
    expect(result.data).toEqual({ state: 'no-phone-on-file' })
    expect(mockGetLiteContext).not.toHaveBeenCalled()
  })

  it('reports not-connected when bff-v2 has no config, without calling it', async () => {
    mockIsBffConfigured.mockReturnValue(false)
    const result = await readPersonalLineContext('+17675550188')
    expect(result.data.state).toBe('not-connected')
    expect(mockGetLiteContext).not.toHaveBeenCalled()
  })

  it('reports unavailable on a transport/HTTP failure, carrying the reason', async () => {
    mockGetLiteContext.mockResolvedValue({ ok: false, error: 'BFF unreachable: timeout' })
    const result = await readPersonalLineContext('+17675550188')
    expect(result.data).toEqual({ state: 'unavailable', reason: 'BFF unreachable: timeout' })
  })

  it('reports not-a-personal-line-customer on a clean not-found', async () => {
    mockGetLiteContext.mockResolvedValue({ ok: true, found: false })
    const result = await readPersonalLineContext('+17675550188')
    expect(result.data).toEqual({ state: 'not-a-personal-line-customer' })
  })

  it('reports ambiguous with the count, and never invents a pick', async () => {
    mockGetLiteContext.mockResolvedValue({ ok: true, found: true, ambiguous: true, count: 2 })
    const result = await readPersonalLineContext('+17675550911')
    expect(result.data).toEqual({ state: 'ambiguous', count: 2 })
  })

  it('maps a full found result through unchanged', async () => {
    mockGetLiteContext.mockResolvedValue({
      ok: true,
      found: true,
      ambiguous: false,
      did: '17672859999',
      status: 'active',
      balanceEc: 10.39,
      routingMode: 'app',
      signupAt: '2026-09-01T00:00:00.000Z',
      plan: { planId: 'day-pass', expiresAt: '2026-09-07T00:00:00.000Z', state: 'active', autoRenew: false },
      recent: [{ kind: 'call', at: '2026-09-05T10:00:00.000Z', label: 'Incoming · +1767555' }],
      recentActivityUnavailable: false,
    })
    const result = await readPersonalLineContext('+17672859999')
    expect(result.data).toEqual({
      state: 'found',
      did: '17672859999',
      status: 'active',
      balanceEc: 10.39,
      routingMode: 'app',
      signupAt: '2026-09-01T00:00:00.000Z',
      plan: { planId: 'day-pass', expiresAt: '2026-09-07T00:00:00.000Z', state: 'active', autoRenew: false },
      recent: [{ kind: 'call', at: '2026-09-05T10:00:00.000Z', label: 'Incoming · +1767555' }],
      recentActivityUnavailable: false,
    })
  })

  it('passes the exact phone and the resolved config through to getLiteContext', async () => {
    mockGetLiteContext.mockResolvedValue({ ok: true, found: false })
    await readPersonalLineContext('+17675550188')
    expect(mockGetLiteContext).toHaveBeenCalledWith(CONFIG, '+17675550188')
  })
})
