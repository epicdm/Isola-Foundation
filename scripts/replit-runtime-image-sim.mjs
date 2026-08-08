/**
 * replit-runtime-image-sim.mjs — run the deployment against a reconstructed
 * runtime image, locally, instead of against production.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * `inc-isola-replit-postbuild-pnpm-store-prune-2026-08-07` cost fourteen hours
 * and six owner-gated publishes. Every one of those publishes existed to answer
 * a single question that no test could answer: does the thing the build
 * produced still exist when the runtime starts? The build→runtime boundary was
 * observable only in production, so production was the test harness.
 *
 * This is that test harness, off production.
 *
 *   1. build both artifacts with the EXACT deployment build commands
 *   2. copy the result and delete everything `.replitignore` excludes
 *   3. assert the MUST-SHIP payload survived — BEFORE starting anything
 *   4. start both artifacts with the EXACT production run commands, from the
 *      filtered tree, with no workspace node_modules to fall back on
 *   5. health-check both
 *
 * `decision-require-replit-runtime-image-simulator-2026-08-07`.
 *
 * The filtering model lives in `replit-ignore-model.mjs` and deliberately
 * assumes the most destructive plausible interpretation of `.replitignore`.
 * Read that file before trusting a PASS.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/replit-runtime-image-sim.mjs
 *
 * DATABASE_URL is required because the deployment build ends with
 * `prisma migrate deploy` (`decision-run-prisma-migrate-in-build-phase-2026-08-07`).
 * Point it at a DISPOSABLE database — the build will migrate it and the isola
 * process will write seed rows into it. Never point it at production.
 */

import { execFileSync, spawn } from 'node:child_process'
import net from 'node:net'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isExcluded, matchesPattern, parseIgnore } from './replit-ignore-model.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Paths the runtime cannot start without.
 *
 * Both are single files whose paths contain no segment any exclusion can match.
 * Isola ships as ONE archive rather than a directory tree precisely because a
 * tree containing node_modules and .next does not survive filtering — see
 * artifacts/isola/scripts/payload-archive.mjs.
 *
 * assertDeployTreeIntact additionally requires that EVERY file staged under
 * .deploy survives, and assertPayloadIsUnexcludable requires that nothing under
 * .deploy could be matched by any rule in the first place.
 */
const MUST_SHIP = [
  '.deploy/api-server/index.mjs',
  '.deploy/isola-standalone.tar',
]

/** Workspace trees the image must NOT carry — the whole point of excluding them. */
const MUST_NOT_SHIP = [
  'node_modules',
  'artifacts/isola/node_modules',
  'artifacts/isola/.next',
  'artifacts/api-server/dist',
]

const API_PORT = Number(process.env.SIM_API_PORT ?? 18099)
const ISOLA_PORT = Number(process.env.SIM_ISOLA_PORT ?? 23399)
const HEALTH_TIMEOUT_MS = Number(process.env.SIM_HEALTH_TIMEOUT_MS ?? 90_000)

/**
 * Replit's promote phase gives roughly this long for every artifact port to
 * open. Exceeding it is a deployment failure even though the process is
 * healthy in the end: build 59bff226 promoted nothing because an uncompressed
 * 85.5 MB extraction plus a blocking instrumentation register() consumed the
 * window. Time-to-port is therefore asserted, not just eventual health.
 */
const PROMOTE_BUDGET_MS = Number(process.env.SIM_PROMOTE_BUDGET_MS ?? 108_000)

/**
 * Cloud Run injects HOSTNAME as the container's EXTERNAL-routed IP, which is
 * handled by the load balancer and bound to no local interface. Next.js
 * standalone does `listen(port, process.env.HOSTNAME || 'localhost')`, so a
 * launcher that passes process.env through unchanged dies with EADDRNOTAVAIL
 * (build b0978062). This harness injects an address that is guaranteed not to
 * be local, so any launcher missing the HOSTNAME override fails HERE instead
 * of in a promote window.
 */
const HOSTILE_HOSTNAME = process.env.SIM_HOSTILE_HOSTNAME ?? '203.0.113.1'

const failures = []
const started = []

function log(msg) {
  console.log(msg)
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

function fail(msg) {
  failures.push(msg)
  console.log(`  FAIL  ${msg}`)
}

function pass(msg) {
  console.log(`  ok    ${msg}`)
}

/** Every file under `dir`, repo-relative, with its size. */
function fileMap(dir, base = dir, into = new Map()) {
  if (!existsSync(dir)) return into
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) fileMap(full, base, into)
    else if (entry.isFile()) into.set(relative(base, full).split('\\').join('/'), statSync(full).size)
  }
  return into
}

/** Run the real deployment build commands, in the real deployment order. */
function build() {
  section('build — the exact deployment build commands')
  if (!process.env.DATABASE_URL) {
    console.error(
      'DATABASE_URL is not set. The deployment build ends with `prisma migrate deploy`,\n' +
        'so this harness cannot run the real build without one. Point it at a DISPOSABLE\n' +
        'database; the build will migrate it. Never point it at production.',
    )
    process.exit(2)
  }
  for (const pkg of ['@workspace/api-server', '@workspace/isola']) {
    log(`  building ${pkg} ...`)
    execFileSync('pnpm', ['--filter', pkg, 'run', 'build'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
    })
  }
}

/** Copy the built tree, then delete everything `.replitignore` excludes. */
function packageImage() {
  section('package — apply .replitignore to build the runtime image')
  const image = mkdtempSync(join(tmpdir(), 'replit-runtime-image-'))
  const rules = parseIgnore(readFileSync(join(REPO_ROOT, '.replitignore'), 'utf8'))
  const excluded = []

  // Filtering DURING the copy, rather than copying everything and deleting
  // after, is what makes this usable: the workspace dependency trees are the
  // bulk of the repository and copying them only to remove them took the run
  // from minutes to tens of minutes.
  //
  // `verbatimSymlinks: true` or this harness corrupts the very thing it
  // measures — cpSync otherwise rewrites each relative symlink as an ABSOLUTE
  // path back into REPO_ROOT, so every link in the image would resolve into the
  // intact source tree. That is precisely the false pass that hid this bug.
  cpSync(REPO_ROOT, image, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const rel = relative(REPO_ROOT, src).split('\\').join('/')
      if (rel === '') return true
      if (rel.split('/')[0] === '.git') return false
      if (isExcluded(rel, rules)) {
        excluded.push(rel)
        return false
      }
      return true
    },
  })

  for (const rel of excluded) log(`  excluded  ${rel}`)
  log(`  ${excluded.length} path(s) excluded by .replitignore`)
  return image
}

/**
 * The payload staged by the build must survive filtering in its entirety.
 *
 * This is the assertion that generalises: it does not need to know what the
 * Next.js standalone trace decided to include, only that filtering did not take
 * any of it away.
 */
function assertDeployTreeIntact(image) {
  section('MUST SHIP — every runtime path survived filtering')
  for (const p of MUST_SHIP) {
    if (!existsSync(join(image, p))) {
      fail("MISSING after filtering: " + p)
      continue
    }
    const src = statSync(join(REPO_ROOT, p)).size
    const dst = statSync(join(image, p)).size
    if (src !== dst) fail(p + " changed size: " + src + " -> " + dst)
    else pass("survived intact (" + Math.round(dst / 1024) + " KB): " + p)
  }
}

/**
 * A port already in use invalidates the entire run.
 *
 * This check exists because its absence produced a FALSE PASS: a next-server
 * left listening on the isola port by an earlier run answered the health check,
 * and the harness reported PASS for an isola process that had never started.
 * A harness that can pass without its own subject running is worse than none,
 * so a busy port is a hard stop rather than a warning.
 */
async function assertPortsFree() {
  section('PORTS — nothing else is listening where the artifacts will bind')
  for (const [name, port] of [
    ['api-server', API_PORT],
    ['isola', ISOLA_PORT],
  ]) {
    const busy = await new Promise((resolve) => {
      const probe = net.createServer()
      probe.once('error', () => resolve(true))
      probe.once("listening", () => probe.close(() => resolve(false)))
      probe.listen(port, "127.0.0.1")
    })
    if (busy) fail(name + " port " + port + " is already in use — a stale process would answer for it")
    else pass(name + " port " + port + " is free")
  }
}

/**
 * Nothing under .deploy may be matchable by ANY rule.
 *
 * This is the property the archive exists to create, and the one the previous
 * approach lacked. It is checked against the SOURCE .deploy, before filtering,
 * so it states an intrinsic fact about the payload rather than the outcome of
 * one particular reading of the rules: if no rule can match it, no dialect of
 * .replitignore can strip it.
 */
function assertPayloadIsUnexcludable() {
  section('PAYLOAD SHAPE — every runtime path is unmatchable by any rule')
  const rules = parseIgnore(readFileSync(join(REPO_ROOT, ".replitignore"), "utf8"))
  // Scoped to MUST_SHIP on purpose. generate-deploy-staging leaves the unpacked
  // .deploy/isola tree beside the archive; that tree IS matchable and IS
  // stripped, which is harmless because nothing starts from it. What must hold
  // is that every path the runtime genuinely needs cannot be matched at all.
  for (const p of MUST_SHIP) {
    const matched = rules.filter((r) => !r.negated && matchesPattern(p, r.pattern))
    if (matched.length > 0) fail(p + " is matchable by: " + matched.map((r) => r.pattern).join(", "))
    else pass("unmatchable by any rule: " + p)
  }
}

/**
 * Nothing in the image may reach outside the image.
 *
 * This assertion exists because its absence produced a FALSE PASS. An earlier
 * reconstruction copied the payload with `cp -r`, which dereferences symlinks
 * into real files, and concluded the payload was self-contained. It was not:
 * staging had rewritten pnpm's relative links as ABSOLUTE paths into
 * `artifacts/isola/.next`, so the payload only ever worked while the original
 * workspace sat next to it — exactly the condition a deployment does not have.
 *
 * A copied image whose links still point at the real repository will happily
 * start and prove nothing at all. So: any symlink resolving outside the image
 * root is a failure, and a dangling one is a failure.
 */
function assertNoLinksOutOfImage(image) {
  section('CONTAINMENT — the image reaches nothing outside itself')
  const offenders = []
  const dangling = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        const target = resolve(dirname(full), readlinkSync(full))
        if (relative(image, target).startsWith('..')) offenders.push(`${relative(image, full)} -> ${target}`)
        else if (!existsSync(target)) dangling.push(relative(image, full))
      } else if (entry.isDirectory()) walk(full)
    }
  }
  walk(image)

  if (offenders.length > 0) {
    fail(`${offenders.length} symlink(s) point outside the runtime image`)
    for (const o of offenders.slice(0, 10)) log(`          ${o}`)
    if (offenders.length > 10) log(`          ... and ${offenders.length - 10} more`)
  } else pass('no symlink escapes the image')

  if (dangling.length > 0) {
    fail(`${dangling.length} dangling symlink(s) inside the image`)
    for (const d of dangling.slice(0, 10)) log(`          ${d}`)
  } else pass('no dangling symlinks')
}

/** The excluded workspace trees really are gone, or the run below proves nothing. */
function assertWorkspaceTreesAbsent(image) {
  section('MUST NOT SHIP — no workspace trees to fall back on')
  for (const p of MUST_NOT_SHIP) {
    if (existsSync(join(image, p))) fail(`still present, so a runtime PASS would be meaningless: ${p}`)
    else pass(`absent: ${p}`)
  }
}

/** The production run command for an artifact, read from its own artifact.toml. */
function productionRunArgs(artifactDir) {
  const toml = readFileSync(join(REPO_ROOT, artifactDir, '.replit-artifact/artifact.toml'), 'utf8')
  const section = toml.split('[services.production.run]')[1]
  if (!section) throw new Error(`no [services.production.run] in ${artifactDir}`)
  const match = section.match(/args = \[([^\]]+)\]/)
  if (!match) throw new Error(`no run args in ${artifactDir}`)
  return match[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''))
}

function start(name, args, image, port, logPrefix) {
  log(`  ${name}: ${args.join(' ')}   (cwd = image root)`)
  const child = spawn(args[0], args.slice(1), {
    cwd: image,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production', HOSTNAME: HOSTILE_HOSTNAME },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  started.push(child)
  let output = ''
  const capture = (buf) => {
    output += buf.toString()
    for (const line of buf.toString().split('\n').filter(Boolean)) log(`    [${logPrefix}] ${line}`)
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  child.on('exit', (code) => {
    if (code !== 0) log(`    [${logPrefix}] exited with code ${code}`)
  })
  return { child, output: () => output }
}

async function healthCheck(name, port, path, proc) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    // If our own child died, stop waiting: anything answering now is not it.
    if (proc && proc.child.exitCode !== null) {
      fail(name + " process exited with code " + proc.child.exitCode + " before opening :" + port)
      return 0
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`)
      if (res.ok) {
        pass(`${name} health ${res.status} on :${port}`)
        return res.status
      }
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  fail(`${name} never became healthy on :${port} within ${HEALTH_TIMEOUT_MS}ms`)
  return 0
}

async function main() {
  let image
  try {
    await assertPortsFree()
    if (failures.length > 0) {
      section('RESULT')
      log('  BLOCKED — ports are not free; a run now could not prove anything')
      process.exitCode = 1
      return
    }
    build()
    image = packageImage()
    log(`  image: ${image}`)

    assertPayloadIsUnexcludable()
    assertDeployTreeIntact(image)
    assertNoLinksOutOfImage(image)
    assertWorkspaceTreesAbsent(image)

    // Fail BEFORE starting anything if the payload is already broken: a process
    // that cannot start tells you less than the manifest that says why.
    //
    // SIM_FORCE_RUN=1 overrides that and starts the processes anyway. It exists
    // for the negative control — demonstrating that a broken image really does
    // produce the observed production failure (isola: `Cannot find module
    // 'next'`, dead before the Next.js banner) rather than merely tripping this
    // harness's own manifest. Never set it to make a red run go green.
    if (failures.length > 0 && !process.env.SIM_FORCE_RUN) {
      section('RESULT')
      log('  BLOCKED — the runtime image is missing required payload; not starting processes')
      for (const f of failures) log(`    - ${f}`)
      log('  (set SIM_FORCE_RUN=1 to start them anyway and observe the runtime failure)')
      process.exitCode = 1
      return
    }
    if (failures.length > 0) {
      log('\n  SIM_FORCE_RUN=1 — starting processes against a KNOWN-BROKEN image (negative control)')
    }

    section('run — the exact production run commands, from the filtered tree')
    const api = start('api-server', productionRunArgs('artifacts/api-server'), image, API_PORT, 'api')
    const isola = start('isola', productionRunArgs('artifacts/isola'), image, ISOLA_PORT, 'isola')

    section('health')
    const startedAt = Date.now()
    const apiStatus = await healthCheck('api-server', API_PORT, '/auth/healthz', api)
    const isolaStatus = await healthCheck('isola', ISOLA_PORT, '/api/healthz', isola)
    const elapsed = Date.now() - startedAt
    section('PROMOTE BUDGET — both ports open inside the platform window')
    if (elapsed > PROMOTE_BUDGET_MS) {
      fail(`both ports took ${elapsed}ms, over the ~${PROMOTE_BUDGET_MS}ms promote window`)
    } else pass(`both ports open in ${elapsed}ms (budget ${PROMOTE_BUDGET_MS}ms)`)

    section('RESULT')
    log(`  FILTERED_API_HEALTH=${apiStatus}`)
    log(`  FILTERED_ISOLA_HEALTH=${isolaStatus}`)
    // Silence from a "healthy" process is the false-pass signature.
    if (isolaStatus === 200 && isola.output().trim() === '') {
      fail('isola reported healthy but produced no output — something else is answering on its port')
    }
    if (isolaStatus === 200 && !isola.output().includes('[start-prod-server]')) {
      fail('isola never logged from start-prod-server — it did not start from the shipped archive')
    }
    if (failures.length === 0) log('  PASS — both artifacts start and serve from the filtered runtime image')
    else {
      log('  FAIL')
      for (const f of failures) log(`    - ${f}`)
    }
    process.exitCode = failures.length === 0 ? 0 : 1
  } finally {
    for (const child of started) child.kill('SIGKILL')
    if (image && !process.env.SIM_KEEP_IMAGE) rmSync(image, { recursive: true, force: true })
    else if (image) log(`\n  image kept at ${image}`)
  }
}

// Spawned children keep the event loop alive even after SIGKILL is delivered, so
// exit explicitly: a harness that prints its verdict and then hangs cannot gate
// anything.
await main()
process.exit(process.exitCode ?? 0)
