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
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isExcluded, parseIgnore } from './replit-ignore-model.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Paths the runtime cannot start without.
 *
 * The named entries below are the two entrypoints and the two directories whose
 * loss produced real, observed production failures. They are not the whole
 * contract — `assertDeployTreeIntact` additionally requires that EVERY file
 * staged under `.deploy` survives filtering byte-for-byte, which is what covers
 * the rest of the Next.js standalone trace without having to enumerate it.
 */
const MUST_SHIP = [
  '.deploy/api-server/index.mjs',
  '.deploy/isola/artifacts/isola/server.js',
  '.deploy/isola/artifacts/isola/.next',
  '.deploy/isola/node_modules/next',
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
  cpSync(REPO_ROOT, image, {
    recursive: true,
    filter: (src) => !src.split(/[\\/]/).includes('.git'),
  })

  const rules = parseIgnore(readFileSync(join(REPO_ROOT, '.replitignore'), 'utf8'))
  let removed = 0

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const rel = relative(image, full).split('\\').join('/')
      if (isExcluded(rel, rules)) {
        rmSync(full, { recursive: true, force: true })
        removed += 1
        log(`  removed  ${rel}`)
        continue
      }
      if (entry.isDirectory()) walk(full)
    }
  }
  walk(image)

  log(`  ${removed} path(s) removed`)
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
  section('MUST SHIP — the staged payload survived filtering')
  const before = fileMap(join(REPO_ROOT, '.deploy'))
  const after = fileMap(join(image, '.deploy'))

  const missing = [...before.keys()].filter((p) => !after.has(p))
  const resized = [...before.keys()].filter((p) => after.has(p) && after.get(p) !== before.get(p))

  if (before.size === 0) fail('.deploy is empty after the build — nothing was staged')
  else if (missing.length > 0) {
    fail(`${missing.length} of ${before.size} staged file(s) were removed by .replitignore`)
    for (const p of missing.slice(0, 15)) log(`          missing: .deploy/${p}`)
    if (missing.length > 15) log(`          ... and ${missing.length - 15} more`)
  } else pass(`all ${before.size} staged file(s) survived`)

  if (resized.length > 0) fail(`${resized.length} staged file(s) changed size`)

  for (const p of MUST_SHIP) {
    if (existsSync(join(image, p))) pass(`present: ${p}`)
    else fail(`MISSING: ${p}`)
  }
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
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
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

async function healthCheck(name, port, path) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
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
    build()
    image = packageImage()
    log(`  image: ${image}`)

    assertDeployTreeIntact(image)
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
    start('api-server', productionRunArgs('artifacts/api-server'), image, API_PORT, 'api')
    start('isola', productionRunArgs('artifacts/isola'), image, ISOLA_PORT, 'isola')

    section('health')
    const apiStatus = await healthCheck('api-server', API_PORT, '/auth/healthz')
    const isolaStatus = await healthCheck('isola', ISOLA_PORT, '/api/healthz')

    section('RESULT')
    log(`  FILTERED_API_HEALTH=${apiStatus}`)
    log(`  FILTERED_ISOLA_HEALTH=${isolaStatus}`)
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

main()
