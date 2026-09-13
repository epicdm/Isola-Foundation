import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { scanEstateForModelLiterals } from './report-paperclip-key-expiry'

// Same shape as guard-not-prod-db.integration.test.ts: exercise the script
// as a real child process so its own dotenv load and exit-code behaviour
// are under test, not just the pure functions.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const reportScript = path.join(__dirname, 'report-paperclip-key-expiry.ts')

const require = createRequire(import.meta.url)
const tsxPkgDir = path.dirname(require.resolve('tsx/package.json'))
const tsxPkgJson = JSON.parse(readFileSync(path.join(tsxPkgDir, 'package.json'), 'utf8'))
const tsxCli = path.join(tsxPkgDir, tsxPkgJson.bin)

function runReport(cwd: string, env: Record<string, string | undefined>): { status: number; stderr: string } {
  const fullEnv = { ...process.env, ...env }
  try {
    execFileSync(process.execPath, [tsxCli, reportScript], { cwd, env: fullEnv, stdio: 'pipe' })
    return { status: 0, stderr: '' }
  } catch (err) {
    const e = err as { status: number; stderr: Buffer }
    return { status: e.status, stderr: e.stderr?.toString() ?? '' }
  }
}

test('refuses to run when PAPERCLIP_DATABASE_URL is unset (fails closed, does not guess a database)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'report-paperclip-key-expiry-'))
  try {
    const result = runReport(dir, { PAPERCLIP_DATABASE_URL: undefined })
    assert.notEqual(result.status, 0)
    assert.ok(result.stderr.includes('PAPERCLIP_DATABASE_URL'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('picks up PAPERCLIP_DATABASE_URL from a cwd .env file, the same precedence as guard-not-prod-db', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'report-paperclip-key-expiry-'))
  try {
    // An unreachable host is enough to prove the value was READ -- the
    // script should get past the "unset" refusal and fail later trying to
    // connect, not repeat the unset-var error.
    writeFileSync(path.join(dir, '.env'), 'PAPERCLIP_DATABASE_URL="postgresql://u:p@127.0.0.1:1/nonexistent"\n')
    const result = runReport(dir, { PAPERCLIP_DATABASE_URL: undefined })
    assert.notEqual(result.status, 0)
    assert.ok(
      !result.stderr.includes('PAPERCLIP_DATABASE_URL is not set'),
      `expected a connection failure, not the unset-var refusal; got: ${result.stderr}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanEstateForModelLiterals finds a literal on disk and records the real file path, skipping node_modules', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'model-scan-'))
  try {
    writeFileSync(path.join(dir, 'cost-table.ts'), `export const MODEL = "deepseek-chat"\n`)
    mkdirSync(path.join(dir, 'node_modules'))
    writeFileSync(path.join(dir, 'node_modules', 'vendored.ts'), `export const MODEL = "deepseek-old-vendored"\n`)

    const byModel = scanEstateForModelLiterals([dir], [/^deepseek-[a-z0-9.-]+$/i])

    assert.ok(byModel.has('deepseek-chat'))
    assert.ok([...byModel.get('deepseek-chat')!][0].endsWith('cost-table.ts'))
    assert.ok(!byModel.has('deepseek-old-vendored'), 'node_modules must be skipped')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanEstateForModelLiterals does not follow a symlink out of the scanned root (Codex-caught fix)', (t) => {
  const outside = mkdtempSync(path.join(tmpdir(), 'model-scan-outside-'))
  const root = mkdtempSync(path.join(tmpdir(), 'model-scan-root-'))
  try {
    writeFileSync(path.join(outside, 'secret-cost-table.ts'), `export const MODEL = "deepseek-outside-the-root"\n`)
    writeFileSync(path.join(root, 'inside.ts'), `export const MODEL = "deepseek-inside-the-root"\n`)
    try {
      symlinkSync(outside, path.join(root, 'escape-link'), 'dir')
    } catch (err) {
      // Creating a directory symlink needs elevated privileges on some
      // Windows configurations. Skip rather than fail the suite on a
      // platform limitation unrelated to the fix under test.
      t.skip(`symlink creation not permitted in this environment: ${(err as Error).message}`)
      return
    }

    const byModel = scanEstateForModelLiterals([root], [/^deepseek-[a-z0-9.-]+$/i])

    assert.ok(byModel.has('deepseek-inside-the-root'))
    assert.ok(!byModel.has('deepseek-outside-the-root'), 'the symlink must not be followed out of the root')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('scanEstateForModelLiterals on a root with no matches returns empty (positive control is the test above)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'model-scan-empty-'))
  try {
    writeFileSync(path.join(dir, 'unrelated.ts'), `export const X = "hello"\n`)
    const byModel = scanEstateForModelLiterals([dir], [/^deepseek-[a-z0-9.-]+$/i])
    assert.equal(byModel.size, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
