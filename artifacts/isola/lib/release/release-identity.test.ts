import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parseArgs as parseCliArgs } from '@/scripts/verify-release-identity'
import {
  CANONICAL_RELEASE_HOSTS,
  FOUNDATION_ROUTED_HOSTS,
  evaluateCoverage,
  evaluateHost,
  evaluateRelease,
  normalizeHostname,
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

  it('fails a build made from a dirty worktree, and nothing can opt out of that', () => {
    expect(evaluateHost('test.epic.dm', ok({ source_dirty: true }), expected).kind).toBe('identity_mismatch')
    // The removed `--allow-dirty` escape used to be honoured here. Passing the
    // old shape must now change nothing: there is no property that makes a dirty
    // artifact acceptable.
    const withOldEscape = { ...expected, allowDirty: true } as typeof expected
    expect(evaluateHost('test.epic.dm', ok({ source_dirty: true }), withOldEscape).kind).toBe('identity_mismatch')
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

// ── Exact canonical host coverage ───────────────────────────────────────────
//
// Judging only whether every SUPPLIED verdict is acceptable makes omission
// indistinguishable from success. At head a896651 five canonical hosts passed
// with the sixth absent, one host passed alone, and duplicates padded the count
// — each printing RELEASE_IDENTITY=PASS.
// dec-pr81-ignored-snapshot-and-six-host-coverage-must-fail-closed-2026-08-06.

describe('normalizeHostname', () => {
  it('folds case and one trailing dot — both are the same DNS name', () => {
    expect(normalizeHostname('TEST.EPIC.DM')).toEqual({ ok: true, host: 'test.epic.dm' })
    expect(normalizeHostname('test.epic.dm.')).toEqual({ ok: true, host: 'test.epic.dm' })
    expect(normalizeHostname('  test.epic.dm  ')).toEqual({ ok: true, host: 'test.epic.dm' })
  })

  it('refuses anything that is not purely a hostname', () => {
    const refused = [
      '',
      '   ',
      'https://test.epic.dm',
      'test.epic.dm/api/health',
      'test.epic.dm:443',
      'user:pass@test.epic.dm',
      'test.epic.dm?x=1',
      'test.epic.dm#frag',
      'test.epic.dm..',
      '.test.epic.dm',
      'test..epic.dm',
      '-test.epic.dm',
      'test.epic.dm-',
      'tëst.epic.dm',
      'тест.epic.dm',
      'test .epic.dm',
    ]
    for (const raw of refused) {
      expect({ raw, ok: normalizeHostname(raw).ok }).toEqual({ raw, ok: false })
    }
    expect(normalizeHostname(undefined).ok).toBe(false)
    expect(normalizeHostname(42).ok).toBe(false)
  })

  it('a punycode label is well-formed but is not a canonical host', () => {
    expect(normalizeHostname('xn--tst-6la.epic.dm').ok).toBe(true)
    expect(CANONICAL_RELEASE_HOSTS).not.toContain('xn--tst-6la.epic.dm')
  })
})

describe('evaluateCoverage — the canonical set, exactly once each', () => {
  const hosts = (names: string[]) => names.map((h) => ({ host: h }))

  it('the canonical set is the six routed hostnames, with no duplicates', () => {
    expect([...CANONICAL_RELEASE_HOSTS]).toEqual([
      'test.epic.dm',
      'app.isola.epic.dm',
      'isola.epic.dm',
      'ema.epic.dm',
      'staging.isola.epic.dm',
      'isola-foundation.replit.app',
    ])
    expect(new Set(CANONICAL_RELEASE_HOSTS).size).toBe(6)
  })

  it('all six, once each → covered', () => {
    expect(evaluateCoverage(hosts([...CANONICAL_RELEASE_HOSTS])).ok).toBe(true)
  })

  it('case and trailing-dot variants still count as coverage', () => {
    const mixed = CANONICAL_RELEASE_HOSTS.map((h, i) => (i % 2 === 0 ? h.toUpperCase() : `${h}.`))
    expect(evaluateCoverage(hosts(mixed)).ok).toBe(true)
  })

  it('zero hosts → not covered', () => {
    const c = evaluateCoverage([])
    expect(c.ok).toBe(false)
    expect(c.missing).toHaveLength(6)
  })

  it('one canonical host → not covered, and names the other five', () => {
    const c = evaluateCoverage(hosts(['isola-foundation.replit.app']))
    expect(c.ok).toBe(false)
    expect(c.missing).toEqual([
      'test.epic.dm',
      'app.isola.epic.dm',
      'isola.epic.dm',
      'ema.epic.dm',
      'staging.isola.epic.dm',
    ])
  })

  it('five unique canonical hosts → not covered, and names the sixth', () => {
    const c = evaluateCoverage(hosts(CANONICAL_RELEASE_HOSTS.slice(0, 5) as string[]))
    expect(c.ok).toBe(false)
    expect(c.missing).toEqual(['isola-foundation.replit.app'])
  })

  it('six entries containing a duplicate and a missing host → not covered', () => {
    const padded = [...CANONICAL_RELEASE_HOSTS.slice(0, 5), CANONICAL_RELEASE_HOSTS[0]]
    const c = evaluateCoverage(hosts(padded as string[]))
    expect(c.ok).toBe(false)
    expect(c.missing).toEqual(['isola-foundation.replit.app'])
    expect(c.duplicates).toEqual(['test.epic.dm'])
  })

  it('all six PLUS a duplicate → still refused; padding is not coverage', () => {
    const c = evaluateCoverage(hosts([...CANONICAL_RELEASE_HOSTS, CANONICAL_RELEASE_HOSTS[2]] as string[]))
    expect(c.ok).toBe(false)
    expect(c.missing).toEqual([])
    expect(c.duplicates).toEqual(['isola.epic.dm'])
  })

  it('an extra host cannot substitute for a missing canonical one', () => {
    const c = evaluateCoverage(hosts([...CANONICAL_RELEASE_HOSTS.slice(0, 5), 'extra.epic.dm'] as string[]))
    expect(c.ok).toBe(false)
    expect(c.missing).toEqual(['isola-foundation.replit.app'])
    expect(c.unexpected).toEqual(['extra.epic.dm'])
  })

  it('all six plus an extra → refused; release verification asserts an exact set', () => {
    const c = evaluateCoverage(hosts([...CANONICAL_RELEASE_HOSTS, 'extra.epic.dm'] as string[]))
    expect(c.ok).toBe(false)
    expect(c.unexpected).toEqual(['extra.epic.dm'])
  })

  it.each([
    ['scheme', 'https://test.epic.dm'],
    ['port', 'test.epic.dm:443'],
    ['path', 'test.epic.dm/api/health'],
    ['userinfo', 'a:b@test.epic.dm'],
    ['malformed', 'test..epic.dm'],
    ['unicode confusable', 'tеst.epic.dm'],
  ])('a %s spelling is invalid, not coverage', (_label, raw) => {
    const c = evaluateCoverage(hosts([raw, ...CANONICAL_RELEASE_HOSTS.slice(1)] as string[]))
    expect(c.ok).toBe(false)
    expect(c.invalid.map((i) => i.host)).toContain(raw)
    expect(c.missing).toContain('test.epic.dm')
  })
})

describe('evaluateRelease — coverage is part of the verdict', () => {
  const TREE_OK = TREE
  const body = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      status: 'ok',
      build: {
        schema: 1,
        mode: 'production',
        source_sha: SHA,
        source_tree: TREE_OK,
        source_dirty: false,
        built_at: '2026-08-06T12:00:00Z',
        ...over,
      },
    })
  const okProbe = (over: Record<string, unknown> = {}): HostProbe => ({
    kind: 'response',
    status: 200,
    bodyText: body(over),
  })
  const exp = { sourceTree: TREE_OK }
  const verdictsFor = (names: readonly string[], probeFor: (h: string) => HostProbe = () => okProbe()) =>
    names.map((h) => evaluateHost(h, probeFor(h), exp))

  it('all six accepted → PASS', () => {
    const r = evaluateRelease(verdictsFor(CANONICAL_RELEASE_HOSTS), exp)
    expect(r.pass).toBe(true)
    expect(r.lines.at(-1)).toBe('RELEASE_IDENTITY=PASS')
  })

  it('five accepted with one absent → FAIL, naming the missing host', () => {
    const r = evaluateRelease(verdictsFor(CANONICAL_RELEASE_HOSTS.slice(0, 5)), exp)
    expect(r.pass).toBe(false)
    expect(r.lines.join('\n')).toContain('never checked: isola-foundation.replit.app')
  })

  it('one accepted host → FAIL', () => {
    expect(evaluateRelease(verdictsFor(['isola-foundation.replit.app']), exp).pass).toBe(false)
  })

  it('zero hosts → FAIL', () => {
    expect(evaluateRelease([], exp).pass).toBe(false)
  })

  it('duplicate padding → FAIL', () => {
    const padded = [...CANONICAL_RELEASE_HOSTS.slice(0, 5), CANONICAL_RELEASE_HOSTS[0]]
    const r = evaluateRelease(verdictsFor(padded), exp)
    expect(r.pass).toBe(false)
    expect(r.lines.join('\n')).toContain('duplicate hostname')
  })

  it.each([
    ['transport failure', { kind: 'transport_error', detail: 'ECONNREFUSED' } as HostProbe],
    ['timeout', { kind: 'transport_error', detail: 'aborted due to timeout' } as HostProbe],
    ['HTTP 503', { kind: 'response', status: 503, bodyText: '{"status":"error"}' } as HostProbe],
    ['non-JSON body', { kind: 'response', status: 200, bodyText: '<!doctype html>' } as HostProbe],
    ['missing build block', { kind: 'response', status: 200, bodyText: '{"status":"ok"}' } as HostProbe],
  ])('one host with a %s fails the whole release, at every position', (_label, bad) => {
    for (const target of CANONICAL_RELEASE_HOSTS) {
      const r = evaluateRelease(
        verdictsFor(CANONICAL_RELEASE_HOSTS, (h) => (h === target ? bad : okProbe())),
        exp,
      )
      expect({ target, pass: r.pass }).toEqual({ target, pass: false })
    }
  })

  it.each([
    ['dirty', { source_dirty: true }],
    ['wrong tree', { source_tree: 'f'.repeat(40) }],
    ['development identity', { mode: 'development' }],
    ['unknown placeholder', { source_sha: 'unknown' }],
  ])('one %s host fails the whole release, at every position', (_label, over) => {
    for (const target of CANONICAL_RELEASE_HOSTS) {
      const r = evaluateRelease(
        verdictsFor(CANONICAL_RELEASE_HOSTS, (h) => (h === target ? okProbe(over) : okProbe())),
        exp,
      )
      expect({ target, pass: r.pass }).toEqual({ target, pass: false })
    }
  })

  it('a divergent host fails and is reported as divergence, not just mismatch', () => {
    const r = evaluateRelease(
      verdictsFor(CANONICAL_RELEASE_HOSTS, (h) =>
        h === 'ema.epic.dm' ? okProbe({ source_tree: 'e'.repeat(40) }) : okProbe(),
      ),
      exp,
    )
    expect(r.pass).toBe(false)
    expect(r.divergentTrees.length).toBeGreaterThan(0)
  })

  it('six-host consensus on the WRONG tree still fails', () => {
    const wrong = 'c'.repeat(40)
    const r = evaluateRelease(verdictsFor(CANONICAL_RELEASE_HOSTS, () => okProbe({ source_tree: wrong })), exp)
    expect(r.pass).toBe(false)
    expect(r.divergentTrees).toEqual([])
  })
})

describe('verify-release-identity CLI arguments', () => {
  it('accepts the release form', () => {
    const a = parseCliArgs(['--expect-tree', TREE, '--expect-sha', SHA])
    expect(a.errors).toEqual([])
    expect(a.expectTree).toBe(TREE)
    expect(a.diagnosticHosts).toEqual([])
  })

  it('rejects --allow-dirty by name, explaining why it is gone', () => {
    const a = parseCliArgs(['--expect-tree', TREE, '--allow-dirty'])
    expect(a.errors.join(' ')).toContain('--allow-dirty was removed')
  })

  it('rejects --host by name, pointing at the diagnostic replacement', () => {
    const a = parseCliArgs(['--expect-tree', TREE, '--host', 'test.epic.dm'])
    expect(a.errors.join(' ')).toContain('--host was removed')
    expect(a.errors.join(' ')).toContain('--diagnostic-host')
  })

  it('rejects an unknown argument rather than ignoring it', () => {
    expect(parseCliArgs(['--expect-tree', TREE, '--yolo']).errors.join(' ')).toContain('unknown argument')
  })

  it('rejects a flag whose value is missing or is another flag', () => {
    expect(parseCliArgs(['--expect-tree']).errors.join(' ')).toContain('requires a value')
    expect(parseCliArgs(['--expect-tree', '--expect-sha', SHA]).errors.join(' ')).toContain('requires a value')
  })

  it('collects diagnostic hosts, which are a different mode entirely', () => {
    const a = parseCliArgs(['--expect-tree', TREE, '--diagnostic-host', 'test.epic.dm', '--diagnostic-host', 'ema.epic.dm'])
    expect(a.errors).toEqual([])
    expect(a.diagnosticHosts).toEqual(['test.epic.dm', 'ema.epic.dm'])
  })

  it('the runner never narrows a release run, and the diagnostic path cannot print PASS', () => {
    const source = readFileSync(fileURLToPath(new URL('../../scripts/verify-release-identity.ts', import.meta.url)), 'utf8')
    // The release path always spreads the canonical set.
    expect(source).toContain('[...CANONICAL_RELEASE_HOSTS]')
    // The diagnostic path strips the verdict line and exits with its own code.
    expect(source).toContain("RELEASE_IDENTITY=NOT_EVALUATED")
    expect(source).toContain('process.exit(3)')
    expect(source).not.toContain('allowDirty')
  })
})
