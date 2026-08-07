import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BUILD_INFO_SCHEMA,
  buildHealthResponse,
  evaluateBuildIdentity,
  projectPublicBuildInfo,
  type BuildInfo,
} from './contract'

const SHA = '7317fd894f97fa5d8e03f72f8947788ef3c37552'
const TREE = '9507818216b7a41ee5ee5f8f1d2b26af5a03e59a'

function productionInfo(over: Partial<BuildInfo> = {}): BuildInfo {
  return {
    schema: BUILD_INFO_SCHEMA,
    mode: 'production',
    source_sha: SHA,
    source_tree: TREE,
    source_dirty: false,
    built_at: '2026-08-06T13:20:00Z',
    ...over,
  }
}

describe('evaluateBuildIdentity', () => {
  it('accepts a well-formed production identity', () => {
    const v = evaluateBuildIdentity(productionInfo())
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.info.source_sha).toBe(SHA)
      expect(v.info.source_tree).toBe(TREE)
      expect(v.info.built_at).toBe('2026-08-06T13:20:00Z')
    }
  })

  it('accepts millisecond precision on built_at', () => {
    expect(evaluateBuildIdentity(productionInfo({ built_at: '2026-08-06T13:20:00.123Z' })).ok).toBe(true)
  })

  it.each([
    ['missing value entirely', undefined, 'build_identity_missing'],
    ['null', null, 'build_identity_missing'],
    ['an array', [], 'build_identity_missing'],
    ['a string', 'ok', 'build_identity_missing'],
  ])('rejects %s', (_label, candidate, reason) => {
    const v = evaluateBuildIdentity(candidate)
    expect(v).toEqual({ ok: false, reason })
  })

  it('rejects the development fallback', () => {
    const v = evaluateBuildIdentity({
      schema: BUILD_INFO_SCHEMA,
      mode: 'development',
      source_sha: null,
      source_tree: null,
      source_dirty: false,
      built_at: null,
    })
    expect(v).toEqual({ ok: false, reason: 'build_identity_development' })
  })

  it.each(['unknown', 'UNKNOWN', 'null', 'undefined', '', '   '])(
    'rejects the %s placeholder as unknown, not merely malformed',
    (sentinel) => {
      const v = evaluateBuildIdentity(productionInfo({ source_sha: sentinel }))
      expect(v).toEqual({ ok: false, reason: 'build_identity_unknown' })
    },
  )

  it.each([
    ['short sha', { source_sha: '7317fd8' }],
    ['uppercase sha', { source_sha: SHA.toUpperCase() }],
    ['41-char sha', { source_sha: `${SHA}a` }],
    ['non-hex sha', { source_sha: 'z'.repeat(40) }],
    ['short tree', { source_tree: '9507818' }],
    ['numeric sha', { source_sha: 12345 as unknown as string }],
    ['timestamp with offset', { built_at: '2026-08-06T13:20:00+00:00' }],
    ['date only', { built_at: '2026-08-06' }],
    ['dirty flag as string', { source_dirty: 'false' as unknown as boolean }],
    ['mode neither production nor development', { mode: 'staging' as unknown as 'production' }],
  ])('rejects %s as malformed', (_label, over) => {
    const v = evaluateBuildIdentity(productionInfo(over as Partial<BuildInfo>))
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('build_identity_malformed')
  })

  it('rejects an unsupported schema rather than guessing at the shape', () => {
    const v = evaluateBuildIdentity(productionInfo({ schema: 2 }))
    expect(v).toEqual({ ok: false, reason: 'build_identity_schema_unsupported' })
  })
})

describe('projectPublicBuildInfo', () => {
  it('publishes exactly six fields and nothing else', () => {
    const v = evaluateBuildIdentity(productionInfo())
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(Object.keys(v.info).sort()).toEqual(
      ['built_at', 'mode', 'schema', 'source_dirty', 'source_sha', 'source_tree'].sort(),
    )
  })

  it('does not carry through a field added upstream — it projects, it does not spread', () => {
    const contaminated = {
      ...productionInfo(),
      tenant_id: '43b006e4-33e0-42a8-bec7-4422ba290d79',
      access_token: 'EAAB-should-never-appear',
      token_env: 'WHATSAPP_TOKEN',
      DATABASE_URL: 'postgres://fixture-not-a-real-credential/db',
      magnus_sip_password: 'FIXTURE-VALUE',
      env: process.env,
    }
    const projected = projectPublicBuildInfo(contaminated as unknown as Record<string, unknown>)
    const serialised = JSON.stringify(projected)
    for (const forbidden of ['tenant_id', 'access_token', 'token_env', 'DATABASE_URL', 'magnus_sip_password', 'env']) {
      expect(serialised).not.toContain(forbidden)
    }
    expect(serialised).not.toContain('EAAB-should-never-appear')
  })
})

describe('buildHealthResponse', () => {
  it('serves 200 with provenance in production when identity is good', () => {
    const r = buildHealthResponse(productionInfo(), { isProduction: true })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      status: 'ok',
      build: {
        schema: 1,
        mode: 'production',
        source_sha: SHA,
        source_tree: TREE,
        source_dirty: false,
        built_at: '2026-08-06T13:20:00Z',
      },
    })
  })

  it.each([
    ['the development fallback', { mode: 'development', source_sha: null, source_tree: null, built_at: null }, 'build_identity_development'],
    ['an unknown placeholder', { source_sha: 'unknown' }, 'build_identity_unknown'],
    ['a malformed sha', { source_sha: 'nope' }, 'build_identity_malformed'],
    ['a missing sha', { source_sha: null }, 'build_identity_missing'],
  ])('fails closed with 503 in production for %s', (_label, over, reason) => {
    const r = buildHealthResponse(productionInfo(over as Partial<BuildInfo>), { isProduction: true })
    expect(r.status).toBe(503)
    expect(r.body).toEqual({ status: 'error', build: { schema: 1, error: reason } })
  })

  it('never reports status ok alongside an unusable identity in production', () => {
    const r = buildHealthResponse(productionInfo({ source_sha: 'unknown' }), { isProduction: true })
    expect(r.body.status).not.toBe('ok')
  })

  it('labels the development fallback explicitly outside production, and publishes no identity', () => {
    const r = buildHealthResponse(
      { schema: 1, mode: 'development', source_sha: null, source_tree: null, source_dirty: false, built_at: null },
      { isProduction: false },
    )
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ status: 'ok', build: { schema: 1, mode: 'development' } })
    expect(JSON.stringify(r.body)).not.toContain('source_sha')
  })

  it('still fails closed outside production for a MALFORMED identity — dev is not a licence', () => {
    const r = buildHealthResponse(productionInfo({ source_sha: 'nope' }), { isProduction: false })
    expect(r.status).toBe(503)
  })

  it('takes no caller input: repeated calls with the same value are identical', () => {
    const a = buildHealthResponse(productionInfo(), { isProduction: true })
    const b = buildHealthResponse(productionInfo(), { isProduction: true })
    expect(a).toEqual(b)
  })
})

// ── the wired route ─────────────────────────────────────────────────────────
//
// The contract above is pure; this proves app/api/health/route.ts is actually
// wired to it, reads the COMPILED constant, and cannot be steered by a caller.
//
// The mocked identity is a DISTINCTIVE fixture, deliberately not any real release
// SHA. A negative control on 2026-08-06 proved why: when the mock carried the
// genuine accepted SHA, a route that hardcoded that SHA instead of reading
// BUILD_INFO passed every test. A value that could never be hardcoded by an
// honest mistake is the only thing that distinguishes reading from asserting.

vi.mock('@/lib/build-info/generated', () => ({
  BUILD_INFO: {
    schema: 1,
    mode: 'production',
    source_sha: '0123456789abcdef0123456789abcdef01234567',
    source_tree: 'fedcba9876543210fedcba9876543210fedcba98',
    source_dirty: false,
    built_at: '2026-08-06T13:20:00Z',
  },
}))

describe('GET /api/health', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns the compiled build identity', async () => {
    const { GET } = await import('@/app/api/health/route')
    const res = await GET()
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      status: 'ok',
      build: {
        schema: 1,
        mode: 'production',
        source_sha: '0123456789abcdef0123456789abcdef01234567',
        source_tree: 'fedcba9876543210fedcba9876543210fedcba98',
        source_dirty: false,
        built_at: '2026-08-06T13:20:00Z',
      },
    })
  })

  it('ignores every environment variable that looks like an identity override', async () => {
    vi.stubEnv('SOURCE_SHA', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    vi.stubEnv('SOURCE_TREE', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    vi.stubEnv('BUILD_INFO', '{"source_sha":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}')
    vi.stubEnv('REPL_DEPLOYMENT_ID', '3392da47-714d-4ddd-a7e3-88be0bb4f578')
    vi.stubEnv('GIT_COMMIT', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    const { GET } = await import('@/app/api/health/route')
    const body = (await (await GET()).json()) as { build: { source_sha: string } }
    expect(body.build.source_sha).toBe('0123456789abcdef0123456789abcdef01234567')
    expect(JSON.stringify(body)).not.toContain('deadbeef')
    expect(JSON.stringify(body)).not.toContain('3392da47')
  })

  it('exposes no tenant, identity, credential or environment data', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fixture-not-a-real-credential/db')
    vi.stubEnv('WHATSAPP_TOKEN', 'EAAB-should-never-appear')
    const { GET } = await import('@/app/api/health/route')
    const serialised = JSON.stringify(await (await GET()).json())
    for (const forbidden of [
      'tenant_id',
      'tenant',
      'access_token',
      'token_env',
      'consumer_account_id',
      'user',
      'email',
      'session',
      'cookie',
      'DATABASE_URL',
      'postgres://',
      'EAAB',
      'password',
      'secret',
    ]) {
      expect(serialised).not.toContain(forbidden)
    }
  })

  it('publishes only the agreed top-level keys', async () => {
    const { GET } = await import('@/app/api/health/route')
    const body = (await (await GET()).json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['build', 'status'])
  })
})
