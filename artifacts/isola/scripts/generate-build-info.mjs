/**
 * generate-build-info.mjs — stamp the compiled artifact with the identity of the
 * source snapshot `next build` is about to compile.
 *
 * ── Why this runs, and why here ────────────────────────────────────────────
 *
 * Replit Autoscale publishes the WORKSPACE FILESYSTEM and then builds it. The
 * failed CB-0 publish on 2026-08-06 proved that a genuine new build, with every
 * content hash changed, can still have compiled a snapshot that preceded the
 * source we believed we were shipping. Nothing observable from outside could tell
 * the difference. So identity has to be taken INSIDE the build, from the snapshot
 * on disk, and compiled into the server.
 *
 *   `git rev-parse HEAD`        → which commit the snapshot is
 *   `git rev-parse HEAD^{tree}` → which CONTENT that commit carries
 *   `git status --porcelain -z --untracked-files=all`
 *                               → whether the snapshot is ONLY that content
 *
 * The third is not decoration. A commit identity describes a snapshot only while
 * the snapshot is that commit; the moment the workspace holds anything else —
 * modified, staged, deleted, renamed or merely UNTRACKED — the reported tree is
 * a claim about something that is not what will be compiled. Replit publishes
 * the workspace filesystem, so untracked files are shipped and compiled like any
 * other. A dirty snapshot therefore fails the build here, before `next build`,
 * rather than being reported and promoted anyway.
 *
 * The tree is the load-bearing one. Replit mints an empty deploy-marker commit at
 * publish time (`bcdd0088…` on the 2026-08-06 release), so HEAD inside the build
 * is expected to be that marker and NOT the reviewed SHA — while its tree is
 * identical to the reviewed commit's tree. `dec-foundation-active-release-line-2026-08-06`
 * states this directly: marker commits are not authoritative source identities;
 * resolve marker tree ancestry to an accepted source SHA. Hence the post-publish
 * gate asserts the TREE and treats the SHA as corroboration.
 *
 * ── Why plain `.mjs` and not `.ts` ─────────────────────────────────────────
 *
 * This file executes on the critical path of a production build, before anything
 * has been transpiled. `node` runs it with no loader, no tsx, no devDependency
 * and nothing that can be missing from a production install. The sibling release
 * tooling (`scripts/publish-gate.ts`) is TypeScript because it runs from a shell,
 * not from a build.
 *
 * ── Shape ──────────────────────────────────────────────────────────────────
 *
 * Prior art: `scripts/src/guard-not-prod-db.ts` — pure predicates, an
 * entry-point-gated `main()`, and both unit and child-process integration tests.
 * Everything below the exports is pure; `main()` is the only thing that touches
 * git, the filesystem or the clock.
 *
 * Usage:
 *   node ./scripts/generate-build-info.mjs                     # development
 *   node ./scripts/generate-build-info.mjs --require-identity  # production build
 *   node ./scripts/generate-build-info.mjs --verify            # staleness check
 *
 * `--require-identity` exits non-zero — before `next build` runs — when git is
 * unavailable, when git answers with something malformed, or when the snapshot
 * is dirty by any of the above. There is no flag that relaxes it.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BUILD_INFO_SCHEMA = 1
export const FULL_SHA = /^[0-9a-f]{40}$/

/**
 * The generator's own output, expressed relative to the repository root.
 *
 * It is tracked, so writing it makes the worktree dirty — by the generator, about
 * the generator, every single build. Excluding exactly this one path from the
 * dirtiness assessment keeps `source_dirty` meaning what it says: a human changed
 * source that HEAD does not describe. Nothing else is excluded.
 */
export const GENERATED_PATH = 'artifacts/isola/lib/build-info/generated.ts'

/**
 * Paths reported dirty that do not invalidate source identity. One entry, and it
 * is this script's own output. If this list ever grows, that is a review event.
 */
export const DIRT_EXEMPT_PATHS = Object.freeze([GENERATED_PATH])

/** How many dirty paths the failure message names before summarising the rest. */
export const DIRTY_PATHS_SHOWN = 20

export const FAILURE_REASONS = {
  gitUnavailable: 'git_metadata_unavailable',
  headMalformed: 'source_sha_malformed',
  treeMalformed: 'source_tree_malformed',
  timestampMalformed: 'built_at_malformed',
  dirtySnapshot: 'source_snapshot_dirty',
}

/**
 * Is this path the generator's own output, and nothing else?
 *
 * EXACT string equality against the repository-relative path. Deliberately not a
 * prefix, a directory, a substring or a normalised comparison: a neighbour
 * (`generated.ts.bak`), a parent directory (`lib/build-info/`), a separator
 * variant (`artifacts\isola\...`) and a traversal spelling
 * (`artifacts/isola/lib/build-info/../build-info/generated.ts`) are all NOT the
 * generated file, and every one of them stays dirty. Git emits forward slashes
 * on every platform, so the only thing a looser comparison could buy is a way in.
 */
export function isDirtExempt(path) {
  return DIRT_EXEMPT_PATHS.includes(path)
}

/**
 * Undo git's C-style path quoting.
 *
 * Unreachable while we ask for `-z` (which never quotes), and kept precisely so
 * that it stays unreachable-by-accident: if a caller ever passes non-`-z` output,
 * a quoted path must not be mistaken for a different path than the one that
 * changed. A multi-byte octal escape decodes byte-wise here, which cannot round
 * -trip perfectly — and does not need to, because an imperfect decode can only
 * fail to match the one exempt path, which leaves the build refusing. Fail closed.
 */
export function unquotePath(path) {
  if (path.length < 2 || path[0] !== '"' || path[path.length - 1] !== '"') return path
  return path.slice(1, -1).replace(/\\(\\|"|n|t|r|[0-7]{3})/g, (_m, esc) => {
    if (esc === '\\') return '\\'
    if (esc === '"') return '"'
    if (esc === 'n') return '\n'
    if (esc === 't') return '\t'
    if (esc === 'r') return '\r'
    return String.fromCharCode(parseInt(esc, 8))
  })
}

/**
 * `git status --porcelain -z --untracked-files=all` → every path it names.
 *
 * ── Why `--untracked-files=all` ────────────────────────────────────────────
 *
 * `=no` was the defect the 2026-08-06 independent review proved: Replit
 * publishes the workspace FILESYSTEM, so an untracked source file is uploaded
 * and compiled by `next build` while being invisible to `source_dirty`. The
 * artifact then reported the reviewed tree, `source_dirty: false`, and the
 * six-host gate returned PASS over source nobody had reviewed. The sibling
 * release gate already had this right — `lib/release/publish-gate.ts`: "An
 * untracked file is not 'not yet in the release'. It IS in the release."
 *
 * ── Why `-z` ───────────────────────────────────────────────────────────────
 *
 * Not a detail. Without it git C-quotes any path holding a space, a quote, a
 * newline or a non-ASCII byte, and the parser has to reverse an escaping scheme
 * to learn what changed — exactly the sort of thing that quietly stops matching
 * and reports a clean tree over a dirty one. With `-z` the separator is NUL,
 * which cannot occur in a path, so nothing is ever quoted and the status bytes
 * and path bytes both arrive intact. No `.trim()` touches this output: the
 * leading space of ` M path` IS the index status column.
 *
 * Record shape is `XY<space>path`, and a rename or copy is followed by a SECOND
 * record holding the source path. Both are returned — the destination is what
 * will exist in the published filesystem, and the source disappearing from it is
 * itself a change the reviewed tree does not describe.
 *
 * A non-empty record that does not parse is returned verbatim rather than
 * dropped. A record this function does not understand is not evidence of a clean
 * tree.
 */
export function parsePorcelainZ(raw) {
  const records = String(raw ?? '').split('\0')
  const paths = []
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]
    if (record.length === 0) continue
    if (record.length < 4 || record[2] !== ' ') {
      paths.push(record)
      continue
    }
    const x = record[0]
    const y = record[1]
    paths.push(unquotePath(record.slice(3)))
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const source = records[i + 1]
      i += 1
      if (source !== undefined && source.length > 0) paths.push(unquotePath(source))
    }
  }
  return paths
}

/** Every path the snapshot carries that HEAD does not describe. */
export function dirtyPaths(raw) {
  return parsePorcelainZ(raw).filter((path) => !isDirtExempt(path))
}

/**
 * Turn raw git output into a build-info value, or say precisely why it cannot.
 *
 * Total function over strings. `head`/`tree` are `null` when git could not be
 * consulted at all, which is a different failure from git answering with
 * something malformed, and is reported as such.
 */
export function deriveBuildInfo({ head, tree, porcelainZ, builtAt }) {
  if (head === null || tree === null) {
    return { ok: false, reason: FAILURE_REASONS.gitUnavailable }
  }
  if (typeof head !== 'string' || !FULL_SHA.test(head)) {
    return { ok: false, reason: FAILURE_REASONS.headMalformed }
  }
  if (typeof tree !== 'string' || !FULL_SHA.test(tree)) {
    return { ok: false, reason: FAILURE_REASONS.treeMalformed }
  }
  if (typeof builtAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(builtAt)) {
    return { ok: false, reason: FAILURE_REASONS.timestampMalformed }
  }
  const dirty = dirtyPaths(porcelainZ ?? '')
  return {
    ok: true,
    // The paths themselves, not just the flag: the build refuses on dirt and has
    // to be able to say WHICH paths, or the operator cannot clear it.
    dirty,
    info: {
      schema: BUILD_INFO_SCHEMA,
      mode: 'production',
      source_sha: head,
      source_tree: tree,
      source_dirty: dirty.length > 0,
      built_at: builtAt,
    },
  }
}

export const DEVELOPMENT_BUILD_INFO = {
  schema: BUILD_INFO_SCHEMA,
  mode: 'development',
  source_sha: null,
  source_tree: null,
  source_dirty: false,
  built_at: null,
}

const BANNER = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Written by \`artifacts/isola/scripts/generate-build-info.mjs\`, which runs as the
 * first step of \`pnpm --filter @workspace/isola run build\`, before \`next build\`.
 *
 * The value committed here is the DEVELOPMENT placeholder. It is tracked on
 * purpose, so that \`next dev\`, \`tsc\` and \`vitest\` always resolve this module —
 * and so that if the generator ever fails to run in a production build, what
 * ships is a value \`/api/health\` refuses to serve as provenance rather than a
 * plausible-looking identity. Fail closed by default, not by configuration.
 */`

/** Render the module. Deterministic: same input, byte-identical output. */
export function renderBuildInfoModule(info) {
  const literal = [
    '{',
    `  schema: ${JSON.stringify(info.schema)},`,
    `  mode: ${JSON.stringify(info.mode)},`,
    `  source_sha: ${JSON.stringify(info.source_sha)},`,
    `  source_tree: ${JSON.stringify(info.source_tree)},`,
    `  source_dirty: ${JSON.stringify(info.source_dirty)},`,
    `  built_at: ${JSON.stringify(info.built_at)},`,
    '}',
  ].join('\n')
  return `${BANNER}\nimport type { BuildInfo } from './contract'\n\nexport const BUILD_INFO: BuildInfo = ${literal}\n`
}

/**
 * Read the identity back out of an already-written module.
 *
 * Deliberately a strict literal parse rather than an import: `--verify` has to be
 * able to report that a file on disk is stale, and importing it would only tell
 * us what a module system decided to give us.
 */
export function parseBuildInfoModule(source) {
  const field = (name) => {
    const m = new RegExp(`\\n\\s*${name}:\\s*(null|true|false|"[^"]*"),`).exec(source)
    if (!m) return undefined
    return JSON.parse(m[1])
  }
  const schema = /\n\s*schema:\s*(\d+),/.exec(source)
  if (!schema) return null
  return {
    schema: Number(schema[1]),
    mode: field('mode'),
    source_sha: field('source_sha'),
    source_tree: field('source_tree'),
    source_dirty: field('source_dirty'),
    built_at: field('built_at'),
  }
}

/**
 * Is the identity on disk still the identity of the current source?
 *
 * `built_at` is excluded from the comparison on purpose — it changes on every
 * run and says nothing about which source was compiled. Staleness is a statement
 * about sha, tree and dirtiness.
 */
export function isGeneratedIdentityStale(existing, fresh) {
  if (existing === null || existing === undefined) return true
  return (
    existing.schema !== fresh.schema ||
    existing.mode !== fresh.mode ||
    existing.source_sha !== fresh.source_sha ||
    existing.source_tree !== fresh.source_tree ||
    existing.source_dirty !== fresh.source_dirty
  )
}

export function parseArgs(argv) {
  return {
    requireIdentity: argv.includes('--require-identity'),
    verify: argv.includes('--verify'),
  }
}

// ── Impure edge ─────────────────────────────────────────────────────────────

function gitOrNull(repoRoot, args, { raw = false } = {}) {
  try {
    const out = execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    // `raw` output is returned byte-for-byte. Porcelain is column-significant —
    // the leading space of ` M path` IS the index status column — and under `-z`
    // the separator is NUL, so there is no trailing newline to strip and nothing
    // that may be trimmed without destroying structure.
    return raw ? out : out.trim()
  } catch {
    return null
  }
}

function main(argv) {
  const args = parseArgs(argv)
  const here = dirname(fileURLToPath(import.meta.url))
  const repoRoot = resolve(here, '..', '..', '..')
  const outPath = join(repoRoot, GENERATED_PATH)

  const head = gitOrNull(repoRoot, ['rev-parse', 'HEAD'])
  const tree = gitOrNull(repoRoot, ['rev-parse', 'HEAD^{tree}'])
  const porcelainZ =
    gitOrNull(repoRoot, ['status', '--porcelain', '-z', '--untracked-files=all'], { raw: true }) ?? ''
  const builtAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  const derived = deriveBuildInfo({ head, tree, porcelainZ, builtAt })

  // Anything that is not a release build writes the development placeholder,
  // even when git could have answered. `mode` describes the KIND of build, not
  // the state of the repository — so a `next dev` server can never advertise a
  // production source identity, and the gate's `mode === 'production'` assertion
  // means what it says. The placeholder is byte-identical to the committed file,
  // so running `dev` also leaves the worktree clean.
  if (!args.requireIdentity && !args.verify) {
    writeFileSync(outPath, renderBuildInfoModule(DEVELOPMENT_BUILD_INFO), 'utf8')
    process.stdout.write('BUILD_IDENTITY=DEVELOPMENT\n')
    return 0
  }

  if (!derived.ok) {
    if (args.requireIdentity) {
      process.stderr.write(
        [
          `BUILD_IDENTITY=FAIL reason=${derived.reason}`,
          '',
          'This build refuses to produce an artifact whose source identity cannot be',
          'proven. A Foundation release must be able to answer, from /api/health, which',
          'source snapshot it compiled — see',
          'dec-cb0-build-identity-six-hostname-corrected-release-2026-08-06.',
          '',
          `repository root: ${repoRoot}`,
          'required: a readable git repository at that root (rev-parse HEAD and HEAD^{tree}).',
          '',
        ].join('\n'),
      )
      return 1
    }
    // --verify with no usable git identity cannot answer the question it was
    // asked, so it refuses rather than reporting "current".
    process.stderr.write(`BUILD_IDENTITY=FAIL reason=${derived.reason}\n`)
    return 1
  }

  // ── Dirty snapshot: refuse BEFORE next build ──────────────────────────────
  //
  // A snapshot carrying anything HEAD does not describe is not the tree the
  // release asserts, and `next build` would compile exactly that. Recording
  // `source_dirty: true` and exiting 0 lets the `&&` chain compile it and Replit
  // promote it, with the post-publish gate rejecting it only once it may already
  // be serving traffic — which is containment after the fact, not containment.
  //
  // There is deliberately NO --allow-dirty escape. An escape in the generator is
  // an escape in the release, and this is the one control standing between the
  // reviewed tree and the artifact. To compile a dirty tree locally, call
  // `next build` directly: it leaves the committed development placeholder in
  // place, which /api/health refuses to serve as provenance in production.
  if (args.requireIdentity && derived.info.source_dirty) {
    const shown = derived.dirty.slice(0, DIRTY_PATHS_SHOWN)
    const rest = derived.dirty.length - shown.length
    process.stderr.write(
      [
        `BUILD_IDENTITY=FAIL reason=${FAILURE_REASONS.dirtySnapshot}`,
        '',
        `The workspace carries ${derived.dirty.length} path(s) that HEAD does not describe.`,
        'Replit publishes the workspace FILESYSTEM, not the reviewed git tree, so these',
        'would be compiled into the artifact while source_tree still named the reviewed',
        'commit — an artifact whose stated identity is not what it is.',
        '',
        ...shown.map((p) => `  ${p}`),
        ...(rest > 0 ? [`  … and ${rest} more`] : []),
        '',
        'Commit them, revert them, or remove them from the workspace, then build again.',
        'See dec-pr81-untracked-and-dirty-source-must-fail-prebuild-2026-08-06.',
        '',
      ].join('\n'),
    )
    return 1
  }

  if (args.verify) {
    let existingSource = ''
    try {
      existingSource = readFileSync(outPath, 'utf8')
    } catch {
      existingSource = ''
    }
    const stale = isGeneratedIdentityStale(parseBuildInfoModule(existingSource), derived.info)
    if (stale) {
      process.stderr.write(`BUILD_IDENTITY=STALE expected_tree=${derived.info.source_tree}\n`)
      return 1
    }
    process.stdout.write(`BUILD_IDENTITY=CURRENT source_tree=${derived.info.source_tree}\n`)
    return 0
  }

  writeFileSync(outPath, renderBuildInfoModule(derived.info), 'utf8')
  process.stdout.write(
    `BUILD_IDENTITY=OK source_sha=${derived.info.source_sha} source_tree=${derived.info.source_tree} source_dirty=${derived.info.source_dirty}\n`,
  )
  return 0
}

// Entry-point gated: importing this module for tests must not run anything.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)))
}
