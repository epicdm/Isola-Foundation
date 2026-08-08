/**
 * generate-deploy-staging.mjs — copy Isola's Next.js standalone output into the
 * repo-root `.deploy/isola/` directory the production run command actually
 * points at.
 *
 * Why this exists: `next build` alone produces `.next`, which still needs the
 * full workspace `node_modules` at runtime via plain `next start`. Real Replit
 * Autoscale builds (5867f18a, then again 464d486f/c8331dd1 after the
 * unrelated pnpm-recursion and snapshot_dirty defects were both independently
 * fixed) lost build output between the build phase completing and the
 * runtime container starting — `Error: Cannot find module
 * '.../artifacts/api-server/dist/index.mjs'`, a file esbuild's own log
 * confirmed it had just created. Isola's `next start` and its `.next` never
 * opened its port in the same incidents. The mechanism was never confirmed
 * (Replit's own build/runtime log collector does not expose it), so this does
 * not modify `.gitignore` or assume that is the cause — it removes the
 * dependency on which mechanism is at fault by explicitly staging a
 * self-contained runtime payload and pointing the production run command at
 * that staged copy instead of the ordinary build-output paths.
 * `inc-isola-replit-postbuild-pnpm-store-prune-2026-08-07`.
 *
 * Standalone output already traces only the modules Isola actually imports
 * into `.next/standalone` (see next.config.ts `output: 'standalone'`), so
 * staging it also reduces the runtime dependency surface versus depending on
 * the full workspace `node_modules`. `.next/static` and `public/` are not
 * included by Next's own standalone output and must be copied in separately —
 * this is Next.js's own documented manual step, not specific to this repo.
 */
import { existsSync, cpSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const isolaDir = resolve(here, '..')
const repoRoot = resolve(isolaDir, '..', '..')

const standaloneDir = join(isolaDir, '.next', 'standalone')
const staticSrc = join(isolaDir, '.next', 'static')
const publicSrc = join(isolaDir, 'public')

const deployDir = join(repoRoot, '.deploy', 'isola')
const stagedAppDir = join(deployDir, 'artifacts', 'isola')
const staticDest = join(stagedAppDir, '.next', 'static')
const publicDest = join(stagedAppDir, 'public')
const entrypoint = join(stagedAppDir, 'server.js')

// Archive path — the ACTUAL runtime payload that ships in the Repl layer.
//
// Why an archive and not just the directory:
//
// `.replitignore`'s depth-agnostic patterns mean that even with `!.deploy`
// re-including the whole `.deploy/` subtree at the end of the file, the
// earlier `node_modules` and `artifacts/isola/.next` exclusions both match
// paths INSIDE `.deploy/isola/` (e.g. `.deploy/isola/node_modules/` and
// `.deploy/isola/artifacts/isola/.next/`). Under correct last-match-wins
// semantics `!.deploy` should win, and the runtime image simulator confirms
// it does; but two consecutive real publish attempts (builds 6503e43f and
// bc305e92) failed with isola not opening port 23359 even though api-server
// (no nested `node_modules`, no `.next`) opened port 8080 immediately — the
// exact asymmetry the simulator predicts when `!.deploy` re-inclusion is NOT
// applied to descendant paths that are also matched by earlier rules.
//
// A tar archive at `.deploy/isola-standalone.tar` sidesteps the issue
// entirely: the path has NO segment that matches any `.replitignore`
// exclusion, so `!.deploy` is the ONLY rule that touches it, and it
// unambiguously re-includes a single file.  `start-prod-server.mjs` unpacks
// it to `/tmp/isola-rt` at container start before running server.js.
//
// `dec-isola-replitignore-node-modules-vs-deploy-re-inclusion-2026-08-08`
const archivePath = join(repoRoot, '.deploy', 'isola-standalone.tar')

function main() {
  if (!existsSync(standaloneDir)) {
    console.error(`generate-deploy-staging: ${standaloneDir} does not exist. Did \`next build\` run first?`)
    process.exit(1)
  }

  rmSync(deployDir, { recursive: true, force: true })
  mkdirSync(deployDir, { recursive: true })
  // `verbatimSymlinks: true` is load-bearing, not a detail.
  //
  // pnpm's standalone output is 24 symlinks over a `.pnpm` store: the public
  // package names in `node_modules` point into `node_modules/.pnpm/...`. Every
  // one of those links is RELATIVE and resolves inside `standalone/`, so the
  // directory is self-contained as Next.js produced it.
  //
  // Node's `cpSync` defaults to `verbatimSymlinks: false`, which RESOLVES each
  // relative link and writes it back as an ABSOLUTE path pointing at the
  // ORIGINAL location. A plain recursive copy therefore produced:
  //
  //   .deploy/isola/artifacts/isola/node_modules/next
  //     -> /home/runner/workspace/artifacts/isola/.next/standalone/node_modules/.pnpm/next@…/node_modules/next
  //
  // pointing straight back into `artifacts/isola/.next` — which `.replitignore`
  // excludes from the deployment image. The payload staged precisely to survive
  // the build→runtime boundary thus depended entirely on a directory that does
  // not cross it. isola died with `Cannot find module 'next'` before its banner
  // while api-server — a single esbuild bundle, no symlinks — started normally.
  // That is the exact asymmetry observed in production on 2026-08-07/08.
  //
  // Copying verbatim keeps the links relative, so they continue to resolve
  // within the staged copy and the payload depends on nothing outside itself.
  //
  // NOT `dereference: true`: that option governs how the SOURCE path itself is
  // resolved, and does not materialise symlinks encountered during the
  // recursive walk — verified on node v22.22.0, where a dereferenced copy still
  // produced a symlink. `pnpm run sim:runtime-image` asserts that no link in the
  // packaged image escapes it, which is what catches this class of mistake.
  cpSync(standaloneDir, deployDir, { recursive: true, verbatimSymlinks: true })

  if (existsSync(staticSrc)) {
    mkdirSync(staticDest, { recursive: true })
    cpSync(staticSrc, staticDest, { recursive: true })
  }

  if (existsSync(publicSrc)) {
    mkdirSync(publicDest, { recursive: true })
    cpSync(publicSrc, publicDest, { recursive: true })
  }

  if (!existsSync(entrypoint)) {
    console.error(
      `generate-deploy-staging: staged entrypoint is missing after copy: ${entrypoint}\n` +
        `This means the deploy stage itself did not survive being written — ` +
        `stop here rather than shipping a build the runtime cannot start.`,
    )
    process.exit(1)
  }

  // --- archive fallback ---
  //
  // Create a single tar archive of the staged directory.  The directory is
  // retained for local development and for the assertion above; the ARCHIVE
  // is what actually ships (see archivePath declaration above for the full
  // rationale).  `start-prod-server.mjs` unpacks it at runtime.
  //
  // `tar` flags:
  //   -c  create
  //   -f  output file
  //   -C  change to this directory before adding files (makes paths relative)
  //   .   add everything in that directory
  //
  // Symlinks are stored as symlink entries (not dereferenced) by default,
  // which is what we want — the relative pnpm symlinks inside node_modules/
  // must stay relative so they resolve inside the extraction directory.
  console.log('generate-deploy-staging: creating runtime archive ...')
  rmSync(archivePath, { force: true })
  try {
    execFileSync('tar', ['-cf', archivePath, '-C', deployDir, '.'], { stdio: 'inherit' })
  } catch (err) {
    console.error(`generate-deploy-staging: tar failed: ${String(err)}`)
    process.exit(1)
  }
  const archiveStat = statSync(archivePath)
  if (archiveStat.size === 0) {
    console.error(`generate-deploy-staging: archive is empty: ${archivePath}`)
    process.exit(1)
  }
  console.log(
    `generate-deploy-staging: archive ready: ${archivePath} ` +
      `(${(archiveStat.size / 1024 / 1024).toFixed(1)} MB)`,
  )

  console.log(`DEPLOY_STAGING=OK entrypoint=${entrypoint} archive=${archivePath}`)
}

main()
