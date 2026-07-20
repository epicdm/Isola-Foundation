import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Exercises the guard the way a package.json script actually invokes it:
// as a child process, with cwd set to the calling package's directory, so
// its own dotenv.config() load of ./.env is what's under test — not just
// the pure isProdDatabaseUrl(string) function.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const guardScript = path.join(__dirname, 'guard-not-prod-db.ts')

const require = createRequire(import.meta.url)
const tsxPkgDir = path.dirname(require.resolve('tsx/package.json'))
const tsxPkgJson = JSON.parse(readFileSync(path.join(tsxPkgDir, 'package.json'), 'utf8'))
const tsxCli = path.join(tsxPkgDir, tsxPkgJson.bin)

const PROD_URL = 'postgresql://user:pass@ep-fancy-cake-aiczmqqq.c-4.us-east-1.aws.neon.tech/neondb'
const DEV_URL = 'postgresql://isola:devpassword@localhost:5436/isola_dev_v2'

function runGuard(cwd: string, exportedDatabaseUrl: string | undefined): number {
  const env = { ...process.env }
  delete env.DATABASE_URL
  if (exportedDatabaseUrl !== undefined) env.DATABASE_URL = exportedDatabaseUrl
  try {
    execFileSync(process.execPath, [tsxCli, guardScript], { cwd, env, stdio: 'pipe' })
    return 0
  } catch (err) {
    return (err as { status: number }).status
  }
}

function withTempEnvFile(databaseUrl: string, fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'guard-not-prod-db-'))
  try {
    writeFileSync(path.join(dir, '.env'), `DATABASE_URL="${databaseUrl}"\n`)
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('refuses a prod DATABASE_URL that only exists in the cwd .env file (not exported)', () => {
  withTempEnvFile(PROD_URL, (dir) => {
    assert.notEqual(runGuard(dir, undefined), 0)
  })
})

test('refuses a prod DATABASE_URL that is shell-exported, even when the .env file holds a dev URL', () => {
  withTempEnvFile(DEV_URL, (dir) => {
    assert.notEqual(runGuard(dir, PROD_URL), 0)
  })
})

test('passes a dev/local DATABASE_URL loaded from the cwd .env file', () => {
  withTempEnvFile(DEV_URL, (dir) => {
    assert.equal(runGuard(dir, undefined), 0)
  })
})
