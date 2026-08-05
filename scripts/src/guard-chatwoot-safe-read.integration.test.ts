import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Exercises the guard the way `pnpm --filter @workspace/scripts
 * guard-chatwoot-safe-read` actually invokes it: as a child process, in a real
 * git working tree, so what is under test is the CLI contract — the exit code,
 * the file discovery through `git ls-files`, and above all what the process
 * writes to stdout and stderr.
 *
 * The unit tests can only prove that a returned `Finding` carries no credential.
 * They cannot prove the PROCESS does not print one: a stray `console.log(line)`
 * in the reporting path, or an exception whose message quotes the offending
 * file, would leak exactly the value the guard exists to protect and every unit
 * test would still pass. That is what this file closes.
 *
 * Prior art: `guard-not-prod-db.integration.test.ts`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const guardScript = path.join(__dirname, 'guard-chatwoot-safe-read.ts')

const require = createRequire(import.meta.url)
const tsxPkgDir = path.dirname(require.resolve('tsx/package.json'))
const tsxPkgJson = JSON.parse(readFileSync(path.join(tsxPkgDir, 'package.json'), 'utf8'))
const tsxCli = path.join(tsxPkgDir, tsxPkgJson.bin)

interface GuardRun {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
  readonly thrown: string
}

function runGuard(cwd: string, args: readonly string[] = []): GuardRun {
  try {
    const stdout = execFileSync(process.execPath, [tsxCli, guardScript, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return { status: 0, stdout, stderr: '', thrown: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string }
    return {
      status: e.status ?? -1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      // The whole error, not just its message — a payload could hide on any
      // property of a child-process error object.
      thrown: `${e.message ?? ''}\n${JSON.stringify(err, Object.getOwnPropertyNames(err ?? {}))}`,
    }
  }
}

/** A throwaway git working tree holding exactly one file. */
function withRepo(fileName: string, contents: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'guard-chatwoot-safe-read-'))
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'pipe' })
    writeFileSync(path.join(dir, fileName), contents)
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Generated per run: nothing here is a literal that could outlive the test. */
const SECRET = `SYNTHETIC-CLI-${randomBytes(12).toString('hex')}-NOT-A-REAL-VALUE`

const PROHIBITED_RUNBOOK = [
  '#!/bin/sh',
  '# Read the WhatsApp inbox configuration.',
  `curl -sS -H "api_access_token: ${SECRET}" "$CW/api/v1/accounts/5/inboxes/46" | jq '.provider_config'`,
  '',
].join('\n')

const SAFE_RUNBOOK = [
  '#!/bin/sh',
  '# Read the WhatsApp inbox configuration, projected through the allowlist.',
  `curl -sS -H "api_access_token: $CHATWOOT_TOKEN" "$CW/api/v1/accounts/5/inboxes/46" | jq '{id, name, channel_type, phone_number}'`,
  '',
].join('\n')

test('CLI exits non-zero on a prohibited fixture', () => {
  withRepo('runbook.sh', PROHIBITED_RUNBOOK, (dir) => {
    const run = runGuard(dir)
    assert.notEqual(run.status, 0)
    assert.equal(run.status, 1)
    assert.match(run.stdout, /unsafe Chatwoot read/)
    assert.match(run.stdout, /runbook\.sh:3/)
  })
})

test('CLI exits zero on a safe allowlisted fixture', () => {
  withRepo('runbook.sh', SAFE_RUNBOOK, (dir) => {
    const run = runGuard(dir)
    assert.equal(run.status, 0)
    assert.match(run.stdout, /clean/)
  })
})

test('CLI never prints the synthetic secret to stdout, stderr or the thrown error', () => {
  withRepo('runbook.sh', PROHIBITED_RUNBOOK, (dir) => {
    for (const args of [[], ['--json']]) {
      const run = runGuard(dir, args)
      assert.notEqual(run.status, 0, `expected a finding for args ${JSON.stringify(args)}`)
      assert.equal(run.stdout.includes(SECRET), false, 'secret reached stdout')
      assert.equal(run.stderr.includes(SECRET), false, 'secret reached stderr')
      assert.equal(run.thrown.includes(SECRET), false, 'secret reached the thrown error')
      // Nor the offending command line itself.
      assert.equal(run.stdout.includes('curl'), false, 'raw command line reached stdout')
    }
  })
})

test('CLI --json reports the finding as structured data, still without the secret', () => {
  withRepo('runbook.sh', PROHIBITED_RUNBOOK, (dir) => {
    const run = runGuard(dir, ['--json'])
    const parsed = JSON.parse(run.stdout) as {
      clean: boolean
      findings: Array<{ file: string; line: number; kind: string; reason: string }>
    }
    assert.equal(parsed.clean, false)
    assert.equal(parsed.findings.length, 1)
    assert.equal(parsed.findings[0].kind, 'forbidden_field_printed')
    assert.equal(parsed.findings[0].file, 'runbook.sh')
    assert.equal(parsed.findings[0].line, 3)
    assert.equal(JSON.stringify(parsed).includes(SECRET), false)
  })
})

test('CLI scans a PowerShell runbook — the primary shell on this platform', () => {
  const psRunbook = [
    '# Read the bound agent bot.',
    `$bot = Invoke-RestMethod -Headers @{ api_access_token = "${SECRET}" } "$CW/api/v1/accounts/5/inboxes/46/agent_bot"`,
    'Write-Host $bot.access_token',
    '',
  ].join('\n')

  withRepo('chatwoot-agent-bot.ps1', psRunbook, (dir) => {
    const run = runGuard(dir, ['--json'])
    assert.equal(run.status, 1)
    const parsed = JSON.parse(run.stdout) as {
      findings: Array<{ file: string; line: number; kind: string }>
    }
    // Line 2 reads the endpoint unprojected; line 3 prints the token.
    assert.equal(parsed.findings.length, 2)
    assert.deepEqual(
      parsed.findings.map((f) => f.line),
      [2, 3],
    )
    assert.equal(run.stdout.includes(SECRET), false)
    assert.equal(run.stderr.includes(SECRET), false)
  })
})
