/**
 * The service door, proven closed — and proven OPENABLE, which is the half
 * that makes the rest mean anything.
 *
 * Nearly every assertion here is a refusal. A file full of refusals passes
 * perfectly against a function that refuses everything, including a correct
 * credential — so `AUTHENTICATES a correct caller` is not a nicety at the
 * bottom of the file, it is the positive control the whole file leans on. If it
 * ever goes red, every other test in here has stopped meaning anything.
 */

import { describe, expect, it } from 'vitest'

import {
  bearerFrom,
  resolveServiceCaller,
  serviceAuthEnvFrom,
  type ServiceAuthEnv,
} from './service-auth'

const TOKEN = 'x'.repeat(43) // shaped like a 32-byte base64url secret
const TENANT = 'tenant-uat-0001'

const configured: ServiceAuthEnv = {
  enabled: 'true',
  token: TOKEN,
  tenantId: TENANT,
}

const bearer = (t: string) => `Bearer ${t}`

describe('the positive control — this door can actually open', () => {
  it('AUTHENTICATES a correct caller and resolves the configured tenant', () => {
    const result = resolveServiceCaller(bearer(TOKEN), configured)
    expect(result).toEqual({ ok: true, tenantId: TENANT })
  })
})

describe('the kill-switch is default OFF', () => {
  it('refuses when the switch is absent', () => {
    expect(resolveServiceCaller(bearer(TOKEN), { ...configured, enabled: undefined })).toEqual({
      ok: false,
      reason: 'disabled',
    })
  })

  // "on unless explicitly off" is the shape that turns a typo into an open door.
  for (const value of ['false', 'TRUE', 'True', '1', 'yes', '']) {
    it(`refuses when the switch is ${JSON.stringify(value)} — only exactly "true" enables`, () => {
      expect(resolveServiceCaller(bearer(TOKEN), { ...configured, enabled: value })).toEqual({
        ok: false,
        reason: 'disabled',
      })
    })
  }

  it('checks the switch BEFORE comparing, so a disabled surface cannot be probed', () => {
    // Correct token, switch off. If the answer distinguished "right token but
    // disabled" from "wrong token", a disabled deployment would still confirm
    // a guessed secret.
    const right = resolveServiceCaller(bearer(TOKEN), { ...configured, enabled: 'false' })
    const wrong = resolveServiceCaller(bearer('completely-different'), {
      ...configured,
      enabled: 'false',
    })
    expect(right).toEqual(wrong)
  })
})

describe('an unconfigured token NEVER authenticates', () => {
  it('refuses an empty bearer against an empty configured token', () => {
    // The failure this exists to stop: a deploy that forgets the secret, where
    // "" === "" would otherwise be a match and the surface opens to everyone.
    expect(resolveServiceCaller('Bearer ', { ...configured, token: '' })).not.toMatchObject({
      ok: true,
    })
  })

  it('refuses even a syntactically valid bearer when no token is configured', () => {
    expect(resolveServiceCaller(bearer('anything'), { ...configured, token: undefined })).toEqual({
      ok: false,
      reason: 'not-configured',
    })
  })

  it('refuses when the token is set but the TENANT BINDING is missing', () => {
    // A token with no tenant is the "one key over all tenants" case arriving by
    // omission rather than by design. It must fail closed, never default.
    expect(resolveServiceCaller(bearer(TOKEN), { ...configured, tenantId: undefined })).toEqual({
      ok: false,
      reason: 'not-configured',
    })
    expect(resolveServiceCaller(bearer(TOKEN), { ...configured, tenantId: '   ' })).toEqual({
      ok: false,
      reason: 'not-configured',
    })
  })
})

describe('the bearer itself', () => {
  it('refuses a missing, empty or non-bearer Authorization header', () => {
    for (const header of [null, undefined, '', '   ', 'Basic abc', 'Token abc', 'Bearer', 'Bearer   ']) {
      expect(resolveServiceCaller(header, configured)).not.toMatchObject({ ok: true })
    }
  })

  it('CONTROL: those same headers are rejected by the parser for the stated reason', () => {
    // Proves the loop above refuses because the header is unusable, not because
    // some unrelated earlier check happened to fire.
    expect(bearerFrom(null)).toBeNull()
    expect(bearerFrom('Basic abc')).toBeNull()
    expect(bearerFrom('Bearer   ')).toBeNull()
    expect(bearerFrom('Bearer abc')).toBe('abc')
    expect(bearerFrom('bearer abc')).toBe('abc') // scheme is case-insensitive
  })

  it('refuses a wrong token as a mismatch, not as a configuration problem', () => {
    expect(resolveServiceCaller(bearer('y'.repeat(43)), configured)).toEqual({
      ok: false,
      reason: 'mismatch',
    })
  })

  it('REFUSES a wrong-length token instead of throwing', () => {
    // The trap this guards: node's timingSafeEqual THROWS on unequal lengths.
    // Compared raw, a one-character token would produce a 500 rather than a
    // 401 — which both leaks that the length was wrong and turns a bad
    // credential into an error page. Digesting first makes both sides 32 bytes.
    for (const wrong of ['a', 'short', 'z'.repeat(500)]) {
      expect(() => resolveServiceCaller(bearer(wrong), configured)).not.toThrow()
      expect(resolveServiceCaller(bearer(wrong), configured)).toEqual({
        ok: false,
        reason: 'mismatch',
      })
    }
  })
})

describe('per-tenant, unreachable by construction', () => {
  it('takes exactly two parameters — there is no channel for a caller tenant', () => {
    // This is the construction claim, asserted rather than described. The
    // function receives an Authorization header and an env. A request, a body
    // and a path are all absent from its scope, so no edit INSIDE it can start
    // honouring a caller-supplied tenant: the value is not there to read.
    expect(resolveServiceCaller.length).toBe(2)
  })

  it('resolves the tenant from configuration alone — same credential, different deployment', () => {
    const a = resolveServiceCaller(bearer(TOKEN), { ...configured, tenantId: 'tenant-a' })
    const b = resolveServiceCaller(bearer(TOKEN), { ...configured, tenantId: 'tenant-b' })
    expect(a).toEqual({ ok: true, tenantId: 'tenant-a' })
    expect(b).toEqual({ ok: true, tenantId: 'tenant-b' })
  })

  it('a token scopes to ONE tenant — there is no wildcard value', () => {
    // Whatever is configured is a literal tenant id, including strings that
    // look like a wildcard. Nothing in this module treats any value specially,
    // so "one key over all tenants" has no representation to be written in.
    for (const suspicious of ['*', 'all', 'ALL', '%']) {
      expect(resolveServiceCaller(bearer(TOKEN), { ...configured, tenantId: suspicious })).toEqual({
        ok: true,
        tenantId: suspicious,
      })
    }
  })
})

describe('serviceAuthEnvFrom reads exactly three variables', () => {
  it('maps the three names and ignores everything else', () => {
    const env = {
      ISOLA_360_SERVICE_ENABLED: 'true',
      ISOLA_360_SERVICE_TOKEN: TOKEN,
      ISOLA_360_SERVICE_TENANT_ID: TENANT,
      // Present on purpose: must not be consulted.
      ISOLA_AGENT_TOOLS_TOKEN: 'a-different-surfaces-secret',
      ISOLA_360_SERVICE_TENANT: 'wrong-name',
    } as unknown as NodeJS.ProcessEnv

    expect(serviceAuthEnvFrom(env)).toEqual({
      enabled: 'true',
      token: TOKEN,
      tenantId: TENANT,
    })
  })

  it('does NOT fall back to the agent-tools token', () => {
    // Reusing that credential would let a token minted for a Flowise tool
    // catalogue read every customer's AR. Ruled out explicitly, and asserted.
    const env = {
      ISOLA_360_SERVICE_ENABLED: 'true',
      ISOLA_AGENT_TOOLS_TOKEN: 'flowise-secret',
      ISOLA_360_SERVICE_TENANT_ID: TENANT,
    } as unknown as NodeJS.ProcessEnv

    const resolved = serviceAuthEnvFrom(env)
    expect(resolved.token).toBeUndefined()
    expect(resolveServiceCaller(bearer('flowise-secret'), resolved)).toEqual({
      ok: false,
      reason: 'not-configured',
    })
  })
})
