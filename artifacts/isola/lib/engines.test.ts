import { describe, it, expect, afterEach, vi } from 'vitest'

import { getChatwootConfig, resolveChatwootToken, ChatwootCredentialRefError } from './engines'

// Not real secrets — obviously-fake fixture strings, never a value that
// could be mistaken for a live credential.
const FIXTURE_A = 'FIXTURE-VALUE-AAA'
const FIXTURE_B = 'FIXTURE-VALUE-BBB'
const FIXTURE_C = 'FIXTURE-VALUE-CCC'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveChatwootToken — literal values keep working', () => {
  it('a plain string passes through unchanged', () => {
    expect(resolveChatwootToken(FIXTURE_A)).toBe(FIXTURE_A)
  })

  it('an empty literal string passes through unchanged (the existing a2 convention)', () => {
    expect(resolveChatwootToken('')).toBe('')
  })

  it('a string that merely contains "env:" mid-string is not treated as a reference', () => {
    expect(resolveChatwootToken('token-with-env:inside-it')).toBe('token-with-env:inside-it')
  })
})

describe('resolveChatwootToken — env:VAR_NAME references', () => {
  it('resolves to the named env var when it is set', () => {
    vi.stubEnv('CHATWOOT_SERVICE_TOKEN', FIXTURE_A)
    expect(resolveChatwootToken('env:CHATWOOT_SERVICE_TOKEN')).toBe(FIXTURE_A)
  })

  it('throws — never falls back to the literal reference string — when the var is unset', () => {
    vi.stubEnv('CHATWOOT_SERVICE_TOKEN', undefined)
    expect(() => resolveChatwootToken('env:CHATWOOT_SERVICE_TOKEN')).toThrow(ChatwootCredentialRefError)
  })

  it('throws — never falls back to empty — when the var is set but empty', () => {
    vi.stubEnv('CHATWOOT_SERVICE_TOKEN', '')
    expect(() => resolveChatwootToken('env:CHATWOOT_SERVICE_TOKEN')).toThrow(ChatwootCredentialRefError)
  })

  it('the thrown error names the exact missing var, and nothing else', () => {
    vi.stubEnv('CHATWOOT_SERVICE_TOKEN', undefined)
    try {
      resolveChatwootToken('env:CHATWOOT_SERVICE_TOKEN')
      expect.unreachable('expected a throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ChatwootCredentialRefError)
      expect((e as ChatwootCredentialRefError).varName).toBe('CHATWOOT_SERVICE_TOKEN')
    }
  })

  it('SABOTAGE: the error message never contains a value sitting in another env var', () => {
    vi.stubEnv('CHATWOOT_SERVICE_TOKEN', undefined)
    vi.stubEnv('SOME_OTHER_TENANT_TOKEN', FIXTURE_B)
    vi.stubEnv('EMA_CHATWOOT_TOKEN', FIXTURE_C)
    try {
      resolveChatwootToken('env:CHATWOOT_SERVICE_TOKEN')
      expect.unreachable('expected a throw')
    } catch (e) {
      const message = (e as Error).message
      expect(message).not.toContain(FIXTURE_B)
      expect(message).not.toContain(FIXTURE_C)
      expect(message).toContain('CHATWOOT_SERVICE_TOKEN')
    }
  })

  it('SABOTAGE: two bindings referencing two different vars resolve independently — no cross-tenant bleed', () => {
    vi.stubEnv('CHATWOOT_SERVICE_TOKEN', FIXTURE_A)
    vi.stubEnv('SOME_OTHER_TENANT_TOKEN', FIXTURE_B)
    expect(resolveChatwootToken('env:CHATWOOT_SERVICE_TOKEN')).toBe(FIXTURE_A)
    expect(resolveChatwootToken('env:SOME_OTHER_TENANT_TOKEN')).toBe(FIXTURE_B)
  })
})

describe('getChatwootConfig — the single choke point both mirror consumers go through', () => {
  it('passes a literal-token binding through unchanged', () => {
    const cfg = getChatwootConfig({ base_url: 'https://inbox.epic.dm', account_id: '2', token: FIXTURE_A })
    expect(cfg).toEqual({ baseUrl: 'https://inbox.epic.dm', accountId: '2', token: FIXTURE_A })
  })

  it('resolves a reference-token binding at call time', () => {
    vi.stubEnv('CHATWOOT_SERVICE_TOKEN', FIXTURE_A)
    const cfg = getChatwootConfig({ base_url: 'https://inbox.epic.dm', account_id: '2', token: 'env:CHATWOOT_SERVICE_TOKEN' })
    expect(cfg.token).toBe(FIXTURE_A)
  })

  it('throws — never returns a config with an empty or wrong token — when the reference is unresolved', () => {
    vi.stubEnv('CHATWOOT_SERVICE_TOKEN', undefined)
    expect(() =>
      getChatwootConfig({ base_url: 'https://inbox.epic.dm', account_id: '2', token: 'env:CHATWOOT_SERVICE_TOKEN' }),
    ).toThrow(ChatwootCredentialRefError)
  })
})
