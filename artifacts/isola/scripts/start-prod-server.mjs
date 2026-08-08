/**
 * start-prod-server.mjs — unpack the isola standalone archive and start the
 * Next.js production server.
 *
 * Why this exists (and not just `node ../../.deploy/isola/artifacts/isola/server.js`):
 *
 * `.replitignore`'s depth-agnostic exclusion patterns (`node_modules`,
 * `artifacts/isola/.next`) both match paths INSIDE `.deploy/isola/`:
 *
 *   .deploy/isola/node_modules/          <- matched by bare `node_modules`
 *   .deploy/isola/artifacts/isola/.next/ <- matched by `artifacts/isola/.next`
 *
 * The `!.deploy` re-inclusion at the end of `.replitignore` is supposed to
 * win (last-match-wins semantics), and the runtime image simulator confirms it
 * does — but two consecutive real publishes (builds 6503e43f, bc305e92 on
 * 2026-08-08) showed api-server (flat esbuild bundle, no nested node_modules)
 * opening port 8080 immediately while isola (standalone tree with node_modules
 * and .next) never opened port 23359 in 60 seconds and was SIGTERMed.  That
 * is the exact asymmetry the simulator predicts when `!.deploy` is not applied
 * to descendant paths that are also matched by earlier exclusion rules.
 *
 * `generate-deploy-staging.mjs` now creates `.deploy/isola-standalone.tar`
 * after building the directory.  That archive path has no segment matching
 * any `.replitignore` exclusion, so `!.deploy` is its only matching rule and
 * unambiguously re-includes a single file.  This script unpacks it into
 * `/tmp/isola-rt` and runs `node /tmp/isola-rt/artifacts/isola/server.js`.
 *
 * `dec-isola-replitignore-node-modules-vs-deploy-re-inclusion-2026-08-08`
 */
import { existsSync, mkdirSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const isolaDir = resolve(here, '..')             // artifacts/isola/
const repoRoot = resolve(isolaDir, '..', '..')  // workspace root

const archivePath = join(repoRoot, '.deploy', 'isola-standalone.tar')
const unpackDir = '/tmp/isola-rt'
const serverPath = join(unpackDir, 'artifacts', 'isola', 'server.js')

if (!existsSync(archivePath)) {
  console.error(`[start-prod-server] FATAL: runtime archive not found: ${archivePath}`)
  console.error('[start-prod-server] The deployment image is missing the isola runtime payload.')
  console.error('[start-prod-server] This means generate-deploy-staging.mjs did not run during the build,')
  console.error('[start-prod-server] or the archive was excluded from the Repl layer.')
  process.exit(1)
}

console.log(`[start-prod-server] unpacking ${archivePath} → ${unpackDir}`)
mkdirSync(unpackDir, { recursive: true })

try {
  execFileSync('tar', ['-xf', archivePath, '-C', unpackDir], { stdio: 'inherit' })
} catch (err) {
  console.error(`[start-prod-server] tar extraction failed: ${String(err)}`)
  process.exit(1)
}

if (!existsSync(serverPath)) {
  console.error(`[start-prod-server] FATAL: ${serverPath} not found after extraction`)
  console.error('[start-prod-server] Archive may be corrupt or was built from an incomplete standalone.')
  process.exit(1)
}

console.log(
  `[start-prod-server] starting ${serverPath}` +
    ` PORT=${process.env.PORT ?? '(unset, Next.js defaults to 3000)'}`,
)

const server = spawn('node', [serverPath], {
  stdio: 'inherit',
  env: process.env,
})

server.on('error', (err) => {
  console.error(`[start-prod-server] server spawn error: ${err.message}`)
  process.exit(1)
})

server.on('exit', (code, signal) => {
  if (signal) {
    // Re-raise so the parent process (pnpm) also terminates with the signal.
    process.kill(process.pid, signal)
  } else {
    process.exit(code ?? 0)
  }
})

// Forward shutdown signals to the server so it can drain connections cleanly.
process.on('SIGTERM', () => server.kill('SIGTERM'))
process.on('SIGINT', () => server.kill('SIGINT'))
