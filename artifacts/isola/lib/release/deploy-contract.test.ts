import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  CONTRACT,
  RUNTIME_PATHS,
  bindsAllInterfaces,
  pathIsMatchable,
  registerIsNonBlocking,
} from '@/scripts/guard-replit-deploy-contract.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

describe('C1 — the runtime binds all interfaces', () => {
  it('accepts an explicit override', () => {
    expect(bindsAllInterfaces("env: { ...process.env, HOSTNAME: '0.0.0.0' }")).toBe(true)
    expect(bindsAllInterfaces('env: { HOSTNAME: "::" }')).toBe(true)
  })

  it('rejects forwarding the environment unchanged — the exact PR#92 defect', () => {
    expect(bindsAllInterfaces('spawn(node, [server], { env: process.env })')).toBe(false)
  })

  it('rejects merely mentioning HOSTNAME without overriding it', () => {
    // Reading it is not forcing it. Cloud Run sets it to an external-routed IP.
    expect(bindsAllInterfaces('const host = process.env.HOSTNAME || "localhost"')).toBe(false)
    expect(bindsAllInterfaces('// remember to set HOSTNAME')).toBe(false)
  })

  it('rejects binding localhost, which Replit documents as unsupported', () => {
    expect(bindsAllInterfaces("HOSTNAME: '127.0.0.1'")).toBe(false)
    expect(bindsAllInterfaces("HOSTNAME: 'localhost'")).toBe(false)
  })
})

describe('C2 — register() does not block the HTTP listener', () => {
  const wrap = (body: string) => `export async function register() {\n${body}\n}\n`

  it('accepts work that is fired and not awaited', () => {
    expect(registerIsNonBlocking(wrap('  void runSeedingBackground();'))).toBe(true)
  })

  it('rejects an awaited seed — Next.js opens the port only after register() resolves', () => {
    expect(registerIsNonBlocking(wrap('  await runSeedingBackground();'))).toBe(false)
  })

  it('rejects a register() that fires nothing in the background at all', () => {
    expect(registerIsNonBlocking(wrap('  await prisma.agent.findFirst();'))).toBe(false)
  })
})

describe('C3 — the runtime payload is unmatchable by .replitignore', () => {
  const ignore = ['node_modules', 'artifacts/isola/.next', 'artifacts/api-server/dist'].join('\n')

  it('matches an excluded name at ANY depth, which is what stripped the payload', () => {
    expect(pathIsMatchable('.deploy/isola/node_modules/next/package.json', ignore)).toBe(true)
    expect(pathIsMatchable('.deploy/isola/artifacts/isola/.next/BUILD_ID', ignore)).toBe(true)
  })

  it('does not match the shipped archive or the api-server bundle', () => {
    expect(pathIsMatchable('.deploy/isola-standalone.tar', ignore)).toBe(false)
    expect(pathIsMatchable('.deploy/api-server/index.mjs', ignore)).toBe(false)
  })

  it('ignores `!` re-inclusion, because it does not rescue descendants', () => {
    // Shipped in build b202729 precisely to test this. It did not work, so the
    // guard must not be reassured by its presence.
    const withNegation = `${ignore}\n!.deploy`
    expect(pathIsMatchable('.deploy/isola/node_modules/next/package.json', withNegation)).toBe(true)
  })

  it('does not match a lookalike that is not a real path segment', () => {
    expect(pathIsMatchable('docs/node_modules.md', ignore)).toBe(false)
    expect(pathIsMatchable('node_modules_backup/x.js', ignore)).toBe(false)
  })
})

describe('the contract holds against the real repository', () => {
  it('every runtime path is unmatchable by the real .replitignore', () => {
    const ignore = readFileSync(`${REPO_ROOT}.replitignore`, 'utf8')
    for (const p of RUNTIME_PATHS) {
      expect({ p, matchable: pathIsMatchable(p, ignore) }).toEqual({ p, matchable: false })
    }
  })

  it('the real launcher forces the bind address', () => {
    const pkg = JSON.parse(readFileSync(`${REPO_ROOT}artifacts/isola/package.json`, 'utf8')) as {
      scripts: Record<string, string>
    }
    const launcher = pkg.scripts['start:prod'].match(/([\w./-]+\.mjs)/)
    expect(launcher).not.toBeNull()
    const source = readFileSync(`${REPO_ROOT}artifacts/isola/${launcher![1].replace(/^\.\//, '')}`, 'utf8')
    expect(bindsAllInterfaces(source)).toBe(true)
  })

  it('the real instrumentation does not block the listener', () => {
    expect(registerIsNonBlocking(readFileSync(`${REPO_ROOT}artifacts/isola/instrumentation.ts`, 'utf8'))).toBe(true)
  })

  it('the guard runs FIRST in the deployment build, so it fails before anything expensive', () => {
    // This repository has no CI: a guard only runs if it is chained into a
    // package.json script. An opt-in check is one someone skips in a hurry.
    const pkg = JSON.parse(readFileSync(`${REPO_ROOT}artifacts/isola/package.json`, 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts.build.startsWith('node ./scripts/guard-replit-deploy-contract.mjs &&')).toBe(true)
  })

  it('names every check it enforces', () => {
    expect(Object.keys(CONTRACT)).toHaveLength(3)
  })
})
