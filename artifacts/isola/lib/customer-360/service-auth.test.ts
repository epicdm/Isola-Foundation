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
const OTHER_TOKEN = 'y'.repeat(43) // a SECOND caller's own, different secret
const TENANT = 'tenant-uat-0001'

const configured: ServiceAuthEnv = {
  enabled: 'true',
  tokens: [TOKEN],
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
    expect(resolveServiceCaller('Bearer ', { ...configured, tokens: [''] })).toEqual({
      ok: false,
      reason: 'not-configured',
    })
    // The positive control, in the same test rather than elsewhere in the file:
    // `.not.toMatchObject({ ok: true })` passes against a function that refuses
    // everything, so on its own the line above proves nothing.
    expect(resolveServiceCaller(bearer(TOKEN), configured)).toEqual({ ok: true, tenantId: TENANT })
  })

  it('refuses even a syntactically valid bearer when no token is configured', () => {
    expect(resolveServiceCaller(bearer('anything'), { ...configured, tokens: [] })).toEqual({
      ok: false,
      reason: 'not-configured',
    })
  })

  it('a set of nothing but BLANKS is an empty set, not a set of one', () => {
    // The shape the set introduces: a second secret file that exists but is
    // empty would otherwise arrive as a one-entry set and satisfy a naive
    // length check, reopening exactly the hole the line above closes.
    for (const blanks of [[''], ['', '  '], ['\t', '\n', '']]) {
      expect(resolveServiceCaller(bearer(''), { ...configured, tokens: blanks })).toEqual({
        ok: false,
        reason: 'not-configured',
      })
      expect(resolveServiceCaller(bearer('anything'), { ...configured, tokens: blanks })).toEqual({
        ok: false,
        reason: 'not-configured',
      })
    }
    // The positive control for the three refusals above: the SAME call shape
    // with one real entry alongside the blanks does open. Without it, a
    // resolveServiceCaller that refused everything would pass this test.
    expect(resolveServiceCaller(bearer(TOKEN), { ...configured, tokens: ['', TOKEN, '  '] })).toEqual(
      { ok: true, tenantId: TENANT },
    )
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

describe('several callers, ONE tenant', () => {
  // Why this exists at all, measured 2026-09-07: production and staging each
  // hold their own distinct 44-character token for the same tenant, and
  // Foundation had only ever been told about staging's. The alternative — give
  // production staging's value — would have made them one principal, after
  // which staging's access could not be revoked without taking production
  // down. A set of callers is the thing that keeps them separable.
  const twoCallers: ServiceAuthEnv = { ...configured, tokens: [TOKEN, OTHER_TOKEN] }

  it('authenticates EITHER caller', () => {
    expect(resolveServiceCaller(bearer(TOKEN), twoCallers)).toEqual({ ok: true, tenantId: TENANT })
    expect(resolveServiceCaller(bearer(OTHER_TOKEN), twoCallers)).toEqual({
      ok: true,
      tenantId: TENANT,
    })
  })

  it('still refuses a credential that is in NEITHER entry', () => {
    expect(resolveServiceCaller(bearer('z'.repeat(43)), twoCallers)).toEqual({
      ok: false,
      reason: 'mismatch',
    })
  })

  it('REVOCATION WORKS: dropping one entry refuses that caller and only that caller', () => {
    // This is the property option A would have destroyed, so it is asserted
    // rather than assumed. Both halves matter: the removed caller must lose
    // access, and the remaining caller must keep it in the same breath.
    const revoked: ServiceAuthEnv = { ...configured, tokens: [OTHER_TOKEN] }
    expect(resolveServiceCaller(bearer(TOKEN), revoked)).toEqual({ ok: false, reason: 'mismatch' })
    expect(resolveServiceCaller(bearer(OTHER_TOKEN), revoked)).toEqual({
      ok: true,
      tenantId: TENANT,
    })
  })

  it('every accepted credential resolves the SAME tenant — a set of callers is not a set of tenants', () => {
    // The ruling this must not widen. Whichever entry matched, the tenant comes
    // from configuration, so no entry can carry a tenant of its own.
    for (const t of [TOKEN, OTHER_TOKEN]) {
      expect(resolveServiceCaller(bearer(t), twoCallers)).toEqual({ ok: true, tenantId: TENANT })
    }
  })

  it('the kill-switch still precedes the whole set', () => {
    for (const t of [TOKEN, OTHER_TOKEN]) {
      expect(resolveServiceCaller(bearer(t), { ...twoCallers, enabled: undefined })).toEqual({
        ok: false,
        reason: 'disabled',
      })
    }
  })
})

describe('serviceAuthEnvFrom enumerates the accepted set', () => {
  it('maps the names and ignores everything else', () => {
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
      tokens: [TOKEN],
      tenantId: TENANT,
    })
  })

  it('collects a LABELLED second credential alongside the primary', () => {
    const env = {
      ISOLA_360_SERVICE_ENABLED: 'true',
      ISOLA_360_SERVICE_TOKEN: TOKEN,
      ISOLA_360_SERVICE_TOKEN_PROD: OTHER_TOKEN,
      ISOLA_360_SERVICE_TENANT_ID: TENANT,
    } as unknown as NodeJS.ProcessEnv

    const resolved = serviceAuthEnvFrom(env)
    expect([...resolved.tokens].sort()).toEqual([TOKEN, OTHER_TOKEN].sort())
    expect(resolveServiceCaller(bearer(OTHER_TOKEN), resolved)).toEqual({
      ok: true,
      tenantId: TENANT,
    })
  })

  it('the prefix rule is CLOSED — near-miss names are not credentials', () => {
    // The control that makes this assertion mean something is the last line:
    // a name that DOES match is collected in the same call, so the empty result
    // above it cannot be an enumerator that simply collects nothing.
    const env = {
      ISOLA_360_SERVICE_ENABLED: 'true',
      ISOLA_360_SERVICE_TENANT_ID: TENANT,
      // `TOKEN` must be followed by `_`, so a plural is not a credential.
      ISOLA_360_SERVICE_TOKENS: 'not-a-credential',
      ISOLA_360_SERVICE_TOKENX: 'not-a-credential-either',
      // Wrong prefix entirely.
      ISOLA_SERVICE_TOKEN_PROD: 'nor-this',
      isola_360_service_token_prod: 'nor-this-lowercased',
    } as unknown as NodeJS.ProcessEnv

    expect(serviceAuthEnvFrom(env).tokens).toEqual([])
    expect(
      serviceAuthEnvFrom({ ...env, ISOLA_360_SERVICE_TOKEN_PROD: OTHER_TOKEN } as NodeJS.ProcessEnv)
        .tokens,
    ).toEqual([OTHER_TOKEN])
  })

  it('drops blank entries at the source, so an empty secret file is not an empty token', () => {
    const env = {
      ISOLA_360_SERVICE_ENABLED: 'true',
      ISOLA_360_SERVICE_TOKEN: TOKEN,
      ISOLA_360_SERVICE_TOKEN_STAGING: '   ',
      ISOLA_360_SERVICE_TENANT_ID: TENANT,
    } as unknown as NodeJS.ProcessEnv

    expect(serviceAuthEnvFrom(env).tokens).toEqual([TOKEN])
    expect(resolveServiceCaller('Bearer ', serviceAuthEnvFrom(env))).toEqual({
      ok: false,
      reason: 'no-bearer',
    })
    // Same pairing as above: the refusal only means something beside a caller
    // that DOES get in through the very same enumerated env.
    expect(resolveServiceCaller(bearer(TOKEN), serviceAuthEnvFrom(env))).toEqual({
      ok: true,
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
    expect(resolved.tokens).toEqual([])
    expect(resolveServiceCaller(bearer('flowise-secret'), resolved)).toEqual({
      ok: false,
      reason: 'not-configured',
    })
  })
})
