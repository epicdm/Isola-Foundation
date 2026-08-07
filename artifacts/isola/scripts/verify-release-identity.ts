/**
 * scripts/verify-release-identity.ts — the only thing that makes network calls.
 * All judgement lives in lib/release/release-identity.ts, which is pure and tested.
 *
 * Post-publish gate. Run it AFTER an owner-controlled publish and BEFORE any
 * acceptance claim, against the tree the owner authorised:
 *
 *   npx tsx scripts/verify-release-identity.ts \
 *     --expect-tree <FULL_TREE_SHA> [--expect-sha <FULL_SHA>]
 *
 * The authorised tree comes from the reviewed merge commit:
 *   git rev-parse <REVIEWED_SHA>^{tree}
 *
 * The release check ALWAYS covers the complete canonical routed host set. There
 * is no way to narrow it, because narrowing it was a bypass: `--host` used to
 * let a one-host spot check exit 0 while five routed hosts went unverified, and
 * `--allow-dirty` used to let six dirty hosts pass.
 * `dec-pr81-ignored-snapshot-and-six-host-coverage-must-fail-closed-2026-08-06`
 * removed both. Unknown arguments are refused rather than ignored, so an old
 * command line fails loudly instead of quietly doing less than it says.
 *
 * For investigating ONE host there is `--diagnostic-host <name>`, which is not a
 * release check and cannot be mistaken for one: it never prints
 * RELEASE_IDENTITY=PASS and always exits non-zero.
 *
 * Exit codes:
 *   0  release PASS — every canonical host serves the authorised identity
 *   1  release FAIL
 *   2  usage error
 *   3  diagnostic run — no release claim was made, and none can be
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
  CANONICAL_RELEASE_HOSTS,
  HEALTH_PATH,
  evaluateHost,
  evaluateRelease,
  resolveRedirect,
  type HostProbe,
} from '@/lib/release/release-identity'

export interface Args {
  expectTree: string
  expectSha: string
  /** Non-empty only in diagnostic mode, which can never produce a release PASS. */
  diagnosticHosts: string[]
  errors: string[]
}

/**
 * Strict. An argument this does not recognise is an ERROR, not something to skip.
 *
 * `--host` and `--allow-dirty` are named explicitly so an operator or a script
 * still carrying them is told what happened and why, rather than seeing a
 * generic parse failure and reaching for a workaround.
 */
export function parseArgs(argv: string[]): Args {
  const a: Args = { expectTree: '', expectSha: '', diagnosticHosts: [], errors: [] }
  const needsValue = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.trim() === '' || value.startsWith('--')) {
      a.errors.push(`${flag} requires a value`)
      return ''
    }
    return value.trim()
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    switch (flag) {
      case '--expect-tree': a.expectTree = needsValue(flag, argv[i + 1]); i += 1; break
      case '--expect-sha': a.expectSha = needsValue(flag, argv[i + 1]); i += 1; break
      case '--diagnostic-host': {
        const v = needsValue(flag, argv[i + 1]); i += 1
        if (v) a.diagnosticHosts.push(v)
        break
      }
      case '--host':
        a.errors.push('--host was removed: it allowed a partial check to exit successfully while routed hosts went unverified. The release gate always covers the full canonical set; use --diagnostic-host to investigate one host (it can never report PASS).')
        i += 1
        break
      case '--allow-dirty':
        a.errors.push('--allow-dirty was removed: a release verifier must not be able to turn a dirty artifact into a PASS.')
        break
      default:
        a.errors.push(`unknown argument ${JSON.stringify(flag)}`)
    }
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
  if (args.errors.length > 0) {
    process.stderr.write(`${args.errors.map((e) => `  ${e}`).join('\n')}\nRELEASE_IDENTITY=FAIL\n`)
    process.exit(2)
  }
  if (!args.expectTree) {
    process.stderr.write('--expect-tree <FULL_TREE_SHA> is required (git rev-parse <SHA>^{tree})\nRELEASE_IDENTITY=FAIL\n')
    process.exit(2)
  }

  const expected = {
    sourceTree: args.expectTree,
    ...(args.expectSha ? { sourceSha: args.expectSha } : {}),
  }
  const diagnostic = args.diagnosticHosts.length > 0
  const hosts = diagnostic ? args.diagnosticHosts : [...CANONICAL_RELEASE_HOSTS]

  const verdicts = []
  for (const host of hosts) {
    verdicts.push(evaluateHost(host, await probe(host), expected))
  }

  const result = evaluateRelease(verdicts, expected)

  // A diagnostic run reports what it saw and stops there. It does not print the
  // release verdict line at all — not even FAIL — because the only thing worth
  // saying about a partial check is that it was not a release check.
  if (diagnostic) {
    const seen = result.lines.filter((l) => !l.startsWith('RELEASE_IDENTITY='))
    process.stdout.write(
      [
        ...seen,
        '',
        'RELEASE_IDENTITY=NOT_EVALUATED',
        `DIAGNOSTIC ONLY — ${hosts.length} host(s) probed by hand. Canonical release coverage`,
        `was NOT performed and no release claim is made. Run without --diagnostic-host to`,
        `check all ${CANONICAL_RELEASE_HOSTS.length} required hostnames.`,
        '',
      ].join('\n'),
    )
    process.exit(3)
  }

  process.stdout.write(`${result.lines.join('\n')}\n`)
  process.exit(result.pass ? 0 : 1)
}

// Entry-point gated: importing this module for tests must not make a request.
if (process.argv[1] && /verify-release-identity\.[cm]?ts$/.test(process.argv[1])) {
  void main()
}
