/**
 * scripts/verify-release-identity.ts — the only thing that makes network calls.
 * All judgement lives in lib/release/release-identity.ts, which is pure and tested.
 *
 * Post-publish gate. Run it AFTER an owner-controlled publish and BEFORE any
 * acceptance claim, against the tree the owner authorised:
 *
 *   npx tsx scripts/verify-release-identity.ts \
 *     --expect-tree <FULL_TREE_SHA> [--expect-sha <FULL_SHA>] [--host <name> ...]
 *
 * The authorised tree comes from the reviewed merge commit:
 *   git rev-parse <REVIEWED_SHA>^{tree}
 *
 * With no --host flags it checks all six routed Foundation hostnames. Exit 0 only
 * when every checked host serves the authorised source identity and no two hosts
 * disagree.
 *
 * This gate makes NO claim about authentication. It reads one unauthenticated
 * public endpoint. `defect-foundation-custom-domain-oidc-callback-2026-08-06` is
 * a separate open defect: only isola-foundation.replit.app currently completes
 * OIDC, and a PASS here must never be reported as tenant login working.
 *
 * Nothing but hostname, HTTP status and the four public build fields is read from
 * the responses. No header, cookie, token or environment value is collected, so
 * the output is safe to paste into Port verbatim.
 */

import {
  FOUNDATION_ROUTED_HOSTS,
  HEALTH_PATH,
  evaluateHost,
  evaluateRelease,
  resolveRedirect,
  type HostProbe,
} from '@/lib/release/release-identity'

interface Args {
  expectTree: string
  expectSha: string
  hosts: string[]
  allowDirty: boolean
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { expectTree: '', expectSha: '', hosts: [], allowDirty: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1] ?? ''
    if (flag === '--expect-tree') { a.expectTree = value.trim(); i += 1 }
    else if (flag === '--expect-sha') { a.expectSha = value.trim(); i += 1 }
    else if (flag === '--host') { if (value.trim()) a.hosts.push(value.trim()); i += 1 }
    else if (flag === '--allow-dirty') { a.allowDirty = true }
  }
  return a
}

/**
 * One request, manual redirect handling, at most one hop. `redirect: 'manual'`
 * rather than 'follow' so a bounce to a different host is a decision this gate
 * makes explicitly and reports, instead of one fetch quietly makes for it.
 */
async function probe(host: string, depth = 0): Promise<HostProbe> {
  const url = `https://${host}${HEALTH_PATH}`
  try {
    const res = await fetch(url, { redirect: 'manual', headers: { accept: 'application/json' } })
    if (res.status >= 300 && res.status < 400) {
      if (depth > 0) return { kind: 'transport_error', detail: 'more than one redirect' }
      const decision = resolveRedirect(host, res.headers.get('location'))
      if (!decision.follow) return { kind: 'transport_error', detail: decision.why }
      const target = new URL(decision.url).hostname
      const followed = await probe(target, depth + 1)
      return followed.kind === 'response' ? { ...followed, redirectedTo: target } : followed
    }
    return { kind: 'response', status: res.status, bodyText: await res.text() }
  } catch (err) {
    return { kind: 'transport_error', detail: err instanceof Error ? err.message : 'request failed' }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.expectTree) {
    process.stderr.write('--expect-tree <FULL_TREE_SHA> is required (git rev-parse <SHA>^{tree})\nRELEASE_IDENTITY=FAIL\n')
    process.exit(2)
  }

  const hosts = args.hosts.length > 0 ? args.hosts : [...FOUNDATION_ROUTED_HOSTS]
  const expected = {
    sourceTree: args.expectTree,
    ...(args.expectSha ? { sourceSha: args.expectSha } : {}),
    allowDirty: args.allowDirty,
  }

  const verdicts = []
  for (const host of hosts) {
    verdicts.push(evaluateHost(host, await probe(host), expected))
  }

  const result = evaluateRelease(verdicts, expected)
  process.stdout.write(`${result.lines.join('\n')}\n`)
  process.exit(result.pass ? 0 : 1)
}

// Entry-point gated: importing this module for tests must not make a request.
if (process.argv[1] && /verify-release-identity\.[cm]?ts$/.test(process.argv[1])) {
  void main()
}
