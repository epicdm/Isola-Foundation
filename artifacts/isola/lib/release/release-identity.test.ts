import { describe, expect, it } from 'vitest'

import {
  FOUNDATION_ROUTED_HOSTS,
  evaluateHost,
  evaluateRelease,
  resolveRedirect,
  type HostProbe,
} from './release-identity'

const TREE = '9507818216b7a41ee5ee5f8f1d2b26af5a03e59a'
const SHA = '7317fd894f97fa5d8e03f72f8947788ef3c37552'
const MARKER_SHA = 'bcdd00883028a3664e0c6fbb5b8de38e3d674ae9'.padEnd(40, '0').slice(0, 40)
const OTHER_TREE = 'a'.repeat(40)

const expected = { sourceTree: TREE }

function ok(over: Record<string, unknown> = {}): HostProbe {
  return {
    kind: 'response',
    status: 200,
    bodyText: JSON.stringify({
      status: 'ok',
      build: {
        schema: 1,
        mode: 'production',
        source_sha: SHA,
        source_tree: TREE,
        source_dirty: false,
        built_at: '2026-08-06T13:20:00Z',
        ...over,
      },
    }),
  }
}

describe('the six routed hostnames', () => {
  it('covers every hostname in CB-0 containment scope', () => {
    expect([...FOUNDATION_ROUTED_HOSTS]).toEqual([
      'test.epic.dm',
      'app.isola.epic.dm',
      'isola.epic.dm',
      'ema.epic.dm',
      'staging.isola.epic.dm',
      'isola-foundation.replit.app',
    ])
  })
})

describe('evaluateHost', () => {
  it('passes on an exact tree match', () => {
    const v = evaluateHost('test.epic.dm', ok(), expected)
    expect(v.kind).toBe('ok')
    expect(v.sourceTree).toBe(TREE)
  })

  it('passes when HEAD is a Replit deploy marker but the tree is the authorised one', () => {
    // Replit mints an empty marker commit at publish time; its tree is the
    // reviewed tree. Asserting only the SHA would fail a correct release.
    const v = evaluateHost('test.epic.dm', ok({ source_sha: MARKER_SHA }), expected)
    expect(v.kind).toBe('ok')
  })

  it('fails on the wrong tree — the exact CB-0 failure mode', () => {
    const v = evaluateHost('test.epic.dm', ok({ source_tree: OTHER_TREE }), expected)
    expect(v.kind).toBe('identity_mismatch')
    expect(v.detail).toContain(OTHER_TREE)
  })

  it('fails on the wrong sha when a sha is asserted, and not when it is not', () => {
    expect(evaluateHost('test.epic.dm', ok({ source_sha: MARKER_SHA }), { sourceTree: TREE, sourceSha: SHA }).kind).toBe(
      'identity_mismatch',
    )
    expect(evaluateHost('test.epic.dm', ok({ source_sha: MARKER_SHA }), { sourceTree: TREE }).kind).toBe('ok')
  })

  it('fails a build made from a dirty worktree', () => {
    expect(evaluateHost('test.epic.dm', ok({ source_dirty: true }), expected).kind).toBe('identity_mismatch')
    expect(evaluateHost('test.epic.dm', ok({ source_dirty: true }), { ...expected, allowDirty: true }).kind).toBe('ok')
  })

  it('distinguishes a transport failure from an unhealthy application', () => {
    expect(evaluateHost('ema.epic.dm', { kind: 'transport_error', detail: 'getaddrinfo ENOTFOUND' }, expected).kind).toBe(
      'transport_failure',
    )
    expect(
      evaluateHost('ema.epic.dm', { kind: 'response', status: 502, bodyText: '{"status":"error"}' }, expected).kind,
    ).toBe('unhealthy')
  })

  it('reports a 503 build-identity failure as unhealthy and repeats the reason the artifact gave', () => {
    const v = evaluateHost('test.epic.dm', {
      kind: 'response',
      status: 503,
      bodyText: JSON.stringify({ status: 'error', build: { schema: 1, error: 'build_identity_development' } }),
    }, expected)
    expect(v.kind).toBe('unhealthy')
    expect(v.detail).toContain('build_identity_development')
  })

  it('fails on malformed JSON', () => {
    expect(evaluateHost('test.epic.dm', { kind: 'response', status: 200, bodyText: '<html>oops' }, expected).kind).toBe(
      'malformed_body',
    )
    expect(evaluateHost('test.epic.dm', { kind: 'response', status: 200, bodyText: '[1,2,3]' }, expected).kind).toBe(
      'malformed_body',
    )
  })

  it('fails an artifact that predates the contract and has no build block at all', () => {
    const v = evaluateHost('test.epic.dm', { kind: 'response', status: 200, bodyText: '{"status":"ok"}' }, expected)
    expect(v.kind).toBe('identity_missing')
  })

  it('fails an unknown placeholder rather than accepting it', () => {
    expect(evaluateHost('test.epic.dm', ok({ source_tree: 'unknown' }), expected).kind).toBe('identity_unknown')
    expect(evaluateHost('test.epic.dm', ok({ source_sha: '' }), expected).kind).toBe('identity_unknown')
  })

  it('fails a development identity — a dev server is not a release', () => {
    const v = evaluateHost('test.epic.dm', {
      kind: 'response',
      status: 200,
      bodyText: JSON.stringify({ status: 'ok', build: { schema: 1, mode: 'development' } }),
    }, expected)
    expect(v.kind).toBe('identity_development')
  })

  it.each([
    ['a short sha', { source_sha: '7317fd8' }],
    ['a short tree', { source_tree: '9507818' }],
    ['an offset timestamp', { built_at: '2026-08-06T13:20:00+00:00' }],
    ['a non-boolean dirty flag', { source_dirty: 'no' }],
    ['an unsupported schema', { schema: 99 }],
  ])('fails %s as malformed', (_label, over) => {
    expect(evaluateHost('test.epic.dm', ok(over), expected).kind).toBe('identity_malformed')
  })

  it('reports nothing but hostname, status and the public build fields', () => {
    const v = evaluateHost('test.epic.dm', ok(), expected)
    expect(Object.keys(v).sort()).toEqual(
      ['builtAt', 'detail', 'host', 'kind', 'sourceDirty', 'sourceSha', 'sourceTree'].sort(),
    )
  })
})

describe('resolveRedirect', () => {
  it('follows a redirect to another routed host on the same path', () => {
    expect(resolveRedirect('test.epic.dm', 'https://isola-foundation.replit.app/api/health')).toEqual({
      follow: true,
      url: 'https://isola-foundation.replit.app/api/health',
    })
  })

  it('refuses a redirect that changes the path', () => {
    const r = resolveRedirect('test.epic.dm', 'https://isola-foundation.replit.app/auth/login')
    expect(r.follow).toBe(false)
  })

  it('refuses a redirect to a host outside the routed set', () => {
    expect(resolveRedirect('test.epic.dm', 'https://evil.example.com/api/health').follow).toBe(false)
  })

  it('refuses a downgrade to http and a missing Location', () => {
    expect(resolveRedirect('test.epic.dm', 'http://isola.epic.dm/api/health').follow).toBe(false)
    expect(resolveRedirect('test.epic.dm', null).follow).toBe(false)
  })
})

describe('evaluateRelease', () => {
  const hostsOk = FOUNDATION_ROUTED_HOSTS.map((h) => evaluateHost(h, ok(), expected))

  it('passes when every routed host serves the authorised identity', () => {
    const r = evaluateRelease(hostsOk, expected)
    expect(r.pass).toBe(true)
    expect(r.lines.at(-1)).toBe('RELEASE_IDENTITY=PASS')
  })

  it('fails when one host serves a different identity, and says which', () => {
    const verdicts = [
      ...hostsOk.slice(0, 5),
      evaluateHost('isola-foundation.replit.app', ok({ source_tree: OTHER_TREE }), expected),
    ]
    const r = evaluateRelease(verdicts, expected)
    expect(r.pass).toBe(false)
    expect(r.divergentTrees).toHaveLength(2)
    expect(r.lines.join('\n')).toContain('deployment divergence')
    expect(r.lines.join('\n')).toContain('isola-foundation.replit.app')
  })

  // A host that fails WITHOUT reporting a tree contributes nothing to the
  // divergence set, so `divergentTrees` cannot catch it — only the requirement
  // that every host be `ok` can. Asserted separately for each shape, because a
  // gate that tolerates "five of six" is how a half-routed deployment gets
  // called a release.
  it.each([
    ['a transport failure', { kind: 'transport_error', detail: 'getaddrinfo ENOTFOUND' } as HostProbe],
    ['an unhealthy 503', { kind: 'response', status: 503, bodyText: '{"status":"error","build":{"schema":1}}' } as HostProbe],
    ['a missing build block', { kind: 'response', status: 200, bodyText: '{"status":"ok"}' } as HostProbe],
    ['a non-JSON body', { kind: 'response', status: 200, bodyText: '<html>gateway</html>' } as HostProbe],
  ])('fails when a single host answers with %s, even though the rest agree', (_label, probe) => {
    const verdicts = [...hostsOk.slice(0, 5), evaluateHost('isola-foundation.replit.app', probe, expected)]
    const r = evaluateRelease(verdicts, expected)
    expect(r.pass).toBe(false)
    // Nothing to diverge from: the failing host reported no tree at all.
    expect(r.divergentTrees).toEqual([])
    expect(r.lines.at(-1)).toBe('RELEASE_IDENTITY=FAIL')
    expect(r.lines.join('\n')).toContain('isola-foundation.replit.app')
  })

  it('fails when a single host reports a DIRTY build, even though the rest agree', () => {
    const verdicts = [...hostsOk.slice(0, 5), evaluateHost('ema.epic.dm', ok({ source_dirty: true }), expected)]
    const r = evaluateRelease(verdicts, expected)
    expect(r.pass).toBe(false)
    expect(r.divergentTrees).toEqual([])
    expect(r.lines.join('\n')).toContain('ema.epic.dm')
  })

  it('fails when every host agrees on the WRONG identity — agreement is not correctness', () => {
    const verdicts = FOUNDATION_ROUTED_HOSTS.map((h) => evaluateHost(h, ok({ source_tree: OTHER_TREE }), expected))
    const r = evaluateRelease(verdicts, expected)
    expect(r.pass).toBe(false)
    expect(r.divergentTrees).toEqual([])
  })

  it('fails on an abbreviated authorised tree — a prefix is not an identity', () => {
    const r = evaluateRelease([evaluateHost('test.epic.dm', ok(), { sourceTree: '9507818' })], { sourceTree: '9507818' })
    expect(r.pass).toBe(false)
    expect(r.lines.join('\n')).toContain('40 hex characters')
  })

  it('fails when nothing was checked at all', () => {
    expect(evaluateRelease([], expected).pass).toBe(false)
  })

  it('prints no header, cookie, token or environment value', () => {
    const verdicts = [
      evaluateHost('test.epic.dm', { kind: 'transport_error', detail: 'getaddrinfo ENOTFOUND ema.epic.dm' }, expected),
      ...hostsOk,
    ]
    const text = evaluateRelease(verdicts, expected).lines.join('\n')
    for (const forbidden of ['set-cookie', 'Cookie', 'authorization', 'Bearer', 'token', 'DATABASE_URL', 'connect.sid']) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })

  it('makes no claim about authentication', () => {
    const text = evaluateRelease(hostsOk, expected).lines.join('\n').toLowerCase()
    expect(text).not.toContain('oidc')
    expect(text).not.toContain('logged in')
    expect(text).not.toContain('authenticated')
  })
})
