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
 *   `git status --porcelain -z --untracked-files=all --ignored=matching`
 *                               → whether the snapshot is ONLY that content
 *
 * The third is not decoration. A commit identity describes a snapshot only while
 * the snapshot is that commit; the moment the workspace holds anything else —
 * modified, staged, deleted, renamed, UNTRACKED or merely IGNORED — the reported
 * tree is a claim about something that is not what will be compiled. Replit
 * publishes the workspace filesystem, so those files are shipped and compiled
 * like any other. A dirty snapshot therefore fails the build here, before
 * `next build`, rather than being reported and promoted anyway.
 *
 * `--ignored=matching` is the second correction the review forced. `.gitignore`
 * is a statement about what this repository tracks. It is NOT the deployment
 * snapshot boundary, and treating it as one left a hole big enough to drive a
 * route through: at head `a896651` the reviewer created
 * `artifacts/isola/app/dist/page.tsx`, which the repository's bare `dist` ignore
 * rule hid from `git status` entirely. The generator reported the reviewed tree
 * with `source_dirty: false`, exited 0, and `next build` compiled a public
 * `/dist` route straight into the artifact.
 * `dec-pr81-ignored-snapshot-and-six-host-coverage-must-fail-closed-2026-08-06`.
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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
  environmentFile: 'workspace_environment_file_present',
}

// ── The snapshot contract ───────────────────────────────────────────────────
//
// Every path present in the workspace falls into exactly one class. Anything
// this file cannot place into one of the first four is class 5, and class 5
// stops the build. There is no default-allow.
//
//   1 TRACKED_CLEAN      identical to the reviewed tree — git does not report it
//   2 GENERATED_EXEMPT   this generator's own output, one exact path
//   3 SNAPSHOT_EXCLUDED  proven not to reach the Replit snapshot at all
//   4 DEPENDENCY_TREE    a package-manager tree at an exact workspace location
//   5 DIRTY              everything else, including anything unrecognised
//
export const PATH_CLASS = Object.freeze({
  generatedExempt: 'generated_exempt',
  snapshotExcluded: 'snapshot_excluded',
  dependencyTree: 'dependency_tree',
  dirty: 'dirty',
})

/**
 * CLASS 3 — excluded from the Replit deployment snapshot by `.replitignore`.
 *
 * The authority is `.replitignore`, not `.gitignore`. A path listed there is not
 * uploaded, so it cannot be compiled and cannot influence the artifact. Every
 * entry below must appear in `.replitignore`; `replitignore.test.ts` pins that
 * correspondence in both directions, so this list cannot drift away from the
 * platform rule that justifies it.
 *
 * Exact repository-relative directory prefixes. Not globs, not basenames, not
 * substrings — `dist` as a bare name is precisely the mistake that produced the
 * bypass this file now closes.
 *
 * `.cache` and `.upm` are not build output — they are created by Replit's own
 * platform steps in the build container before this artifact's build script (and
 * this preflight) ever runs. Two consecutive real publish failures on
 * 2026-08-07 (builds d79ea11f, 51cc3feb) both hit `reason=snapshot_dirty` citing
 * exactly these two paths regardless of the uploaded snapshot's content,
 * confirming they are recreated fresh on every publish, not carried over.
 */
export const SNAPSHOT_EXCLUDED_PREFIXES = Object.freeze([
  '.local',
  'artifacts/api-server/dist',
  'artifacts/isola/.next',
  'artifacts/isola/.next-preview',
  'artifacts/isola/tsconfig.tsbuildinfo',
  'scripts/tsconfig.tsbuildinfo',
  '.cache',
  '.upm',
])

/**
 * CLASS 4 — package-manager dependency trees, at exact workspace locations.
 *
 * ── Why this is now proven rather than assumed ─────────────────────────────
 *
 * The previous revision left this class explicit but UNPROVEN: nothing
 * established whether Replit uploads a workspace tree or installs its own, and
 * the deployment build log is not reachable from any read-only interface. Replit
 * describes a publish as "a snapshot of your app's files AND DEPENDENCIES", so
 * the safe reading was always that the tree ships — and a shipped tree is
 * unreviewed code that `next build` compiles against, which the reviewed
 * lockfile describes only by intention.
 *
 * `dec-pr81-node-modules-excluded-and-lockfile-reinstalled-2026-08-06` closes it
 * without needing a publish to find out: every path below is excluded from the
 * deployment snapshot by `.replitignore`, and the production build reconstructs
 * the tree inside the build environment from the reviewed manifests under a
 * FROZEN lockfile before anything is compiled. So the class no longer rests on
 * "a lockfile exists"; it rests on the tree not being in the snapshot at all and
 * being rebuilt from reviewed inputs. `replitignore.test.ts` asserts the
 * exclusion against the real file with the real matcher, in both directions.
 *
 * The locations are exact and exhaustive: one per pnpm workspace package plus
 * the root. A `node_modules` anywhere else is class 5 and stops the build, so a
 * new package cannot quietly widen the exemption — adding one is a review event.
 * `generate-build-info.test.ts` pins this list against the real manifest
 * topology.
 */
export const DEPENDENCY_TREE_PATHS = Object.freeze([
  'node_modules',
  'artifacts/api-server/node_modules',
  'artifacts/isola/node_modules',
  'artifacts/mockup-sandbox/node_modules',
  'lib/api-client-react/node_modules',
  'lib/api-spec/node_modules',
  'lib/api-zod/node_modules',
  'lib/db/node_modules',
  'scripts/node_modules',
])

/**
 * Local environment files the production framework loads at BUILD time.
 *
 * Next.js reads `.env.${mode}.local`, `.env.local`, `.env.${mode}` and `.env`
 * during `next build` (`packages/next-env`), and every `NEXT_PUBLIC_*` value it
 * finds is INLINED into the client bundle (`packages/next/src/lib/static-env`).
 * A workspace `.env.local` therefore changes what is compiled while changing
 * nothing git can see.
 *
 * These are never exemptable, at any location, under any prefix. Production
 * configuration reaches a Foundation release through the authorised deployment
 * environment, never through an unreviewed file sitting in the workspace.
 *
 * `.env.example` is deliberately absent: it is TRACKED, and Next.js does not
 * load it.
 */
export const BUILD_CONSUMED_ENV_FILES = Object.freeze([
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.production',
  '.env.production.local',
  '.env.test',
  '.env.test.local',
])

/**
 * Every file that can change what `pnpm install` produces.
 *
 * All of these are TRACKED, so a modification is already class 1 dirt and an
 * untracked or ignored copy is already class 5 dirt — the preflight adds no new
 * detection. What it adds is TIMING and a name: these are named explicitly so
 * that when one of them is dirty the failure says "a package-manager input is
 * unreviewed" before `pnpm install` runs, rather than reporting a generic dirty
 * path after an unreviewed `.npmrc` has already steered the resolver.
 * `dec-pr81-node-modules-excluded-and-lockfile-reinstalled-2026-08-06`.
 */
export const PACKAGE_MANAGER_INPUTS = Object.freeze([
  '.npmrc',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  'artifacts/api-server/package.json',
  'artifacts/isola/package.json',
  'artifacts/mockup-sandbox/package.json',
  'lib/api-client-react/package.json',
  'lib/api-spec/package.json',
  'lib/api-zod/package.json',
  'lib/db/package.json',
  'scripts/package.json',
])

/**
 * Filenames that configure the package manager wherever they appear.
 *
 * A `.npmrc` beside any manifest is read by pnpm. Only the tracked root copy is
 * reviewed, so any other one — untracked, ignored, or in a subdirectory — must
 * stop the build. Matched by exact basename because that is how pnpm finds them.
 */
export const PACKAGE_MANAGER_CONFIG_NAMES = Object.freeze([
  '.npmrc',
  '.pnpmfile.cjs',
  'pnpmfile.js',
  '.yarnrc',
  '.yarnrc.yml',
])

/** Repository-relative directories a build-consumed env file is looked for in. */
export const ENV_PROBE_DIRECTORIES = Object.freeze([
  '',
  'artifacts/api-server',
  'artifacts/isola',
  'artifacts/mockup-sandbox',
  'lib/api-client-react',
  'lib/api-spec',
  'lib/api-zod',
  'lib/db',
  'scripts',
])

/**
 * Reduce a git-reported path to one canonical repository-relative spelling, or
 * refuse.
 *
 * Refusing is a real answer: an unnormalisable path is class 5. The point is
 * that exactly one spelling can ever reach an exemption comparison, so no
 * alternate spelling of an exempt path can be constructed. Git emits POSIX
 * separators, no leading slash and no `.`/`..` segments on every platform, so
 * anything that does not look like that did not come from git, and the safe
 * response is to treat it as dirt rather than to repair it.
 *
 * The single normalisation performed is stripping ONE trailing slash: git marks
 * a collapsed ignored directory as `path/`, and `path/` and `path` are the same
 * directory.
 */
export function normalizeSnapshotPath(raw) {
  if (typeof raw !== 'string') return null
  const withoutTrailingSlash = raw.endsWith('/') ? raw.slice(0, -1) : raw
  if (withoutTrailingSlash.length === 0) return null
  if (withoutTrailingSlash.includes('\\')) return null
  if (withoutTrailingSlash.includes('//')) return null
  if (withoutTrailingSlash.startsWith('/')) return null
  if (withoutTrailingSlash.endsWith('/')) return null
  if (/^[A-Za-z]:/.test(withoutTrailingSlash)) return null
  const segments = withoutTrailingSlash.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null
  return withoutTrailingSlash
}

/** Is `path` exactly `prefix`, or something inside it? Never a partial segment. */
function isUnderPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`)
}

/** The last path segment. */
function baseName(path) {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

/**
 * Place one path into exactly one class.
 *
 * Order is load-bearing. The environment-file test runs FIRST, before any
 * exemption can be consulted, so no present or future exemption prefix can ever
 * shelter a build-consumed env file.
 */
export function classifySnapshotPath(raw) {
  const path = normalizeSnapshotPath(raw)
  if (path === null) {
    return { path: String(raw), class: PATH_CLASS.dirty, reason: 'unnormalisable path' }
  }
  if (BUILD_CONSUMED_ENV_FILES.includes(baseName(path))) {
    return { path, class: PATH_CLASS.dirty, reason: 'build-consumed environment file' }
  }
  if (DIRT_EXEMPT_PATHS.includes(path)) {
    return { path, class: PATH_CLASS.generatedExempt, reason: "this generator's own output" }
  }
  for (const prefix of SNAPSHOT_EXCLUDED_PREFIXES) {
    if (isUnderPrefix(path, prefix)) {
      return { path, class: PATH_CLASS.snapshotExcluded, reason: `excluded from the Replit snapshot by .replitignore (${prefix})` }
    }
  }
  for (const prefix of DEPENDENCY_TREE_PATHS) {
    if (isUnderPrefix(path, prefix)) {
      return { path, class: PATH_CLASS.dependencyTree, reason: `pnpm dependency tree (${prefix}), pinned by the tracked lockfile` }
    }
  }
  return { path, class: PATH_CLASS.dirty, reason: 'not accounted for by the snapshot contract' }
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
 * `--ignored=matching` adds `!! path` records, and reports an ignored DIRECTORY
 * collapsed as `!! path/` rather than enumerating what is inside it. That is why
 * `normalizeSnapshotPath` strips one trailing slash: `path/` and `path` are the
 * same directory, and the classification has to see them as one thing.
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

/**
 * Classify every path git reported. Returns the class-5 entries — the ones that
 * stop the build — alongside the accounted-for ones, so the failure message can
 * say WHY a path was refused rather than only that it was.
 */
export function classifySnapshot(raw) {
  const entries = parsePorcelainZ(raw).map(classifySnapshotPath)
  return {
    entries,
    dirty: entries.filter((e) => e.class === PATH_CLASS.dirty),
    accounted: entries.filter((e) => e.class !== PATH_CLASS.dirty),
  }
}

/** Every path the snapshot carries that the snapshot contract does not account for. */
export function dirtyPaths(raw) {
  return classifySnapshot(raw).dirty.map((e) => e.path)
}

/**
 * Turn raw git output into a build-info value, or say precisely why it cannot.
 *
 * Total function over strings. `head`/`tree` are `null` when git could not be
 * consulted at all, which is a different failure from git answering with
 * something malformed, and is reported as such.
 */
export function deriveBuildInfo({ head, tree, porcelainZ, builtAt, envFiles = /** @type {string[]} */ ([]) }) {
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
  const classified = classifySnapshot(porcelainZ ?? '')
  // A filesystem probe finds build-consumed env files even where no ignore rule
  // exists to make git mention them. Union, de-duplicated, order preserved.
  const probed = (Array.isArray(envFiles) ? envFiles : [])
    .map((p) => classifySnapshotPath(p))
    .filter((e) => e.class === PATH_CLASS.dirty)
  const seen = new Set(classified.dirty.map((e) => e.path))
  const dirtyEntries = [...classified.dirty]
  for (const e of probed) {
    if (!seen.has(e.path)) { seen.add(e.path); dirtyEntries.push(e) }
  }
  const dirty = dirtyEntries.map((e) => e.path)
  return {
    ok: true,
    // The paths themselves, not just the flag: the build refuses on dirt and has
    // to be able to say WHICH paths and WHY, or the operator cannot clear it.
    dirty,
    dirtyEntries,
    accounted: classified.accounted,
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
    preflight: argv.includes('--preflight'),
  }
}

/**
 * Decide whether dependency installation may proceed.
 *
 * Runs BEFORE `pnpm install`, because installation is itself steerable: an
 * unreviewed `.npmrc` changes the registry and the resolver, an unreviewed
 * `.pnpmfile.cjs` rewrites every manifest as it is read, and an unreviewed
 * lockfile changes what is fetched. Detecting any of that afterwards is
 * detecting it too late — the tree `next build` compiles against already exists.
 *
 * The one difference from the post-install gate: workspace dependency
 * directories are QUARANTINE rather than dirt. They are excluded from the
 * deployment snapshot and about to be rebuilt from the frozen lockfile, so their
 * contents at this moment cannot reach the artifact. Everything else the
 * snapshot contract does not account for still stops the build, including
 * build-consumed environment files.
 */
export function evaluatePreflight(porcelainZ, envFiles = /** @type {string[]} */ ([])) {
  const entries = parsePorcelainZ(porcelainZ ?? '').map(classifySnapshotPath)
  for (const p of Array.isArray(envFiles) ? envFiles : []) {
    const e = classifySnapshotPath(p)
    if (!entries.some((x) => x.path === e.path)) entries.push(e)
  }

  const quarantine = entries.filter((e) => e.class === PATH_CLASS.dependencyTree)
  const blocking = entries.filter((e) => e.class === PATH_CLASS.dirty)

  // Name the package-manager inputs separately. Same detection, louder failure.
  const packageConfig = blocking.filter(
    (e) =>
      PACKAGE_MANAGER_INPUTS.includes(e.path) || PACKAGE_MANAGER_CONFIG_NAMES.includes(baseName(e.path)),
  )

  return { ok: blocking.length === 0, blocking, packageConfig, quarantine }
}

/**
 * Is the package manager about to run the version the repository pinned?
 *
 * `packageManager` in the root manifest is the reviewed pin. A MAJOR mismatch is
 * a real determinism risk — it is what changes lockfile semantics and resolution
 * — so it fails. Minor and patch drift is allowed: a frozen lockfile of a given
 * version installs the same tree across them, and refusing would make the gate
 * depend on the deployment image's exact pnpm build rather than on anything that
 * affects the artifact.
 */
export function evaluatePackageManagerPin(declared, running) {
  if (typeof declared !== 'string' || declared.trim() === '') {
    return { ok: false, reason: 'no packageManager declared in the root manifest' }
  }
  const m = /^([a-z]+)@(\d+)\.(\d+)\.(\d+)/.exec(declared.trim())
  if (!m) return { ok: false, reason: `packageManager "${declared}" is not <name>@<major.minor.patch>` }
  const [, name, major] = m
  if (name !== 'pnpm') return { ok: false, reason: `packageManager names ${name}; this build chain uses pnpm` }
  if (typeof running !== 'string' || !/^\d+\./.test(running.trim())) {
    return { ok: false, reason: 'could not determine the running pnpm version' }
  }
  const runningMajor = running.trim().split('.')[0]
  if (runningMajor !== major) {
    return { ok: false, reason: `pinned pnpm ${major}.x but pnpm ${running.trim()} is running` }
  }
  return { ok: true, pinned: declared.trim(), running: running.trim() }
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

/**
 * Look for build-consumed env files directly, rather than trusting that an
 * ignore rule exists to make git mention them.
 *
 * Only ever records PATHS. Nothing here opens a file, so no value from one can
 * reach a build log, a transcript or a Port record.
 */
export function probeEnvFiles(repoRoot, exists) {
  const found = []
  for (const dir of ENV_PROBE_DIRECTORIES) {
    for (const name of BUILD_CONSUMED_ENV_FILES) {
      const rel = dir === '' ? name : `${dir}/${name}`
      if (exists(join(repoRoot, rel))) found.push(rel)
    }
  }
  return found
}

/** The reviewed package-manager pin, or null when the manifest cannot be read. */
function readPackageManagerPin(repoRoot) {
  try {
    return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).packageManager ?? null
  } catch {
    return null
  }
}

/** Run a command for its stdout, or null. Used only for `pnpm --version`. */
function gitFreeCommand(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' }).trim()
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
    gitOrNull(repoRoot, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignored=matching'], {
      raw: true,
    }) ?? ''
  const envFiles = probeEnvFiles(repoRoot, existsSync)
  const builtAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  // ── Preflight: may dependency installation proceed? ───────────────────────
  //
  // Deliberately BEFORE the identity checks. It has a different job and a
  // different moment: identity describes what will be compiled, preflight
  // decides whether the package manager may be trusted to run at all.
  if (args.preflight) {
    if (head === null || tree === null) {
      process.stderr.write(`BUILD_PREFLIGHT=FAIL reason=${FAILURE_REASONS.gitUnavailable}\n`)
      return 1
    }
    const pin = evaluatePackageManagerPin(
      readPackageManagerPin(repoRoot),
      gitFreeCommand('pnpm', ['--version']),
    )
    const pre = evaluatePreflight(porcelainZ, envFiles)
    if (!pin.ok || !pre.ok) {
      const shown = pre.blocking.slice(0, DIRTY_PATHS_SHOWN)
      const rest = pre.blocking.length - shown.length
      process.stderr.write(
        [
          `BUILD_PREFLIGHT=FAIL reason=${!pin.ok ? 'package_manager_pin' : pre.packageConfig.length > 0 ? 'package_manager_input_unreviewed' : 'snapshot_dirty'}`,
          '',
          ...(!pin.ok ? [`package manager: ${pin.reason}`, ''] : []),
          ...(pre.packageConfig.length > 0
            ? [
                'A package-manager input is not the reviewed one. Installation is steerable —',
                'an unreviewed .npmrc changes the registry and the resolver, a .pnpmfile.cjs',
                'rewrites manifests as they are read — so this stops BEFORE pnpm install, not',
                'after the tree it would have produced already exists.',
                '',
              ]
            : []),
          // Paths only. Nothing here has opened any of these files.
          ...shown.map((e) => `  ${e.path}${e.reason ? `  — ${e.reason}` : ''}`),
          ...(rest > 0 ? [`  … and ${rest} more`] : []),
          '',
          'See dec-pr81-node-modules-excluded-and-lockfile-reinstalled-2026-08-06.',
          '',
        ].join('\n'),
      )
      return 1
    }
    process.stdout.write(
      `BUILD_PREFLIGHT=OK package_manager=${pin.pinned} running=${pin.running} quarantined_dependency_trees=${pre.quarantine.length}\n`,
    )
    return 0
  }

  const derived = deriveBuildInfo({ head, tree, porcelainZ, builtAt, envFiles })

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
    const entries = derived.dirtyEntries ?? derived.dirty.map((p) => ({ path: p, reason: '' }))
    const envEntries = entries.filter((e) => e.reason === 'build-consumed environment file')
    const shown = entries.slice(0, DIRTY_PATHS_SHOWN)
    const rest = entries.length - shown.length
    const reason = envEntries.length > 0 ? FAILURE_REASONS.environmentFile : FAILURE_REASONS.dirtySnapshot
    process.stderr.write(
      [
        `BUILD_IDENTITY=FAIL reason=${reason}`,
        '',
        `The workspace carries ${entries.length} path(s) the snapshot contract does not account for.`,
        'Replit publishes the workspace FILESYSTEM, not the reviewed git tree, so these',
        'would be compiled into the artifact while source_tree still named the reviewed',
        'commit — an artifact whose stated identity is not what it is. Being ignored by',
        '.gitignore does not keep a file out of the snapshot; only .replitignore does.',
        '',
        // Paths only. Nothing here has opened any of these files.
        ...shown.map((e) => `  ${e.path}${e.reason ? `  — ${e.reason}` : ''}`),
        ...(rest > 0 ? [`  … and ${rest} more`] : []),
        '',
        ...(envEntries.length > 0
          ? [
              'A build-consumed environment file is present in the workspace. Next.js loads',
              '.env, .env.local, .env.<mode> and .env.<mode>.local during `next build` and',
              'inlines every NEXT_PUBLIC_* value into the client bundle, so this changes what',
              'is compiled while changing nothing the reviewed tree can express. Production',
              'configuration must arrive through the authorised deployment environment.',
              '',
            ]
          : []),
        'Commit them, revert them, or remove them from the workspace, then build again.',
        'See dec-pr81-untracked-and-dirty-source-must-fail-prebuild-2026-08-06 and',
        'dec-pr81-ignored-snapshot-and-six-host-coverage-must-fail-closed-2026-08-06.',
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
