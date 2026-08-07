import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const REPLIT_CONFIG = readFileSync(`${REPO_ROOT}.replit`, 'utf8')

describe('the Replit deployment postBuild contract', () => {
  it('does not run pnpm store prune after build', () => {
    // A scaffold-generated `[deployment.postBuild]` hook ran `pnpm store prune`
    // in the same ephemeral, single-shot build container as the install it
    // claimed to clean up after. With nothing else on that filesystem to have
    // orphaned any store content yet, it removed ~711 of the ~729 just-
    // installed packages immediately before the image was packaged — both
    // artifacts still need `node_modules` at runtime (api-server externalizes
    // `@google-cloud/*`; Isola's `next start` is not standalone output), so
    // both crashed and never opened their ports.
    // `inc-isola-replit-postbuild-pnpm-store-prune-2026-08-07`.
    // Match only a real TOML section header at the start of a line, not prose
    // (e.g. this file's own explanatory comment) that happens to mention it.
    expect(REPLIT_CONFIG).not.toMatch(/^\[deployment\.postBuild\]/m)
    expect(REPLIT_CONFIG).not.toMatch(/["']pnpm["']\s*,\s*["']store["']\s*,\s*["']prune["']/)
  })

  it('still declares the deployment target unchanged', () => {
    expect(REPLIT_CONFIG).toContain('deploymentTarget = "autoscale"')
    expect(REPLIT_CONFIG).toContain('ignoreDatabaseMigrations = true')
  })
})
