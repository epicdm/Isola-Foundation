import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CW00_EXCEPTION,
  checksumMigrationFile,
  evaluate,
  hasBlockingFindings,
  readRepositoryChecksums,
  readRepositoryChecksumVariants,
  redactedTarget,
  type LedgerRow,
} from './guard-cw00-checksum-exception'

const NAME = CW00_EXCEPTION.migrationName
const PROD = CW00_EXCEPTION.productionChecksum
const REPAIRED = CW00_EXCEPTION.repairedChecksum

function applied(migration_name: string, checksum: string): LedgerRow {
  return { migration_name, checksum, finished_at: new Date(), rolled_back_at: null }
}

test('the approved exception is permitted — exactly this name and this checksum pair', () => {
  const findings = evaluate([applied(NAME, PROD)], new Map([[NAME, REPAIRED]]))
  assert.equal(findings.length, 1)
  assert.equal(findings[0].status, 'approved-exception')
  assert.equal(hasBlockingFindings(findings), false)
})

test('an ordinary matching migration passes', () => {
  const findings = evaluate([applied('20260101000000_a', 'aa')], new Map([['20260101000000_a', 'aa']]))
  assert.equal(findings[0].status, 'match')
  assert.equal(hasBlockingFindings(findings), false)
})

test('ANY other migration with a changed checksum is blocking', () => {
  const findings = evaluate([applied('20260101000000_a', 'aa')], new Map([['20260101000000_a', 'bb']]))
  assert.equal(findings[0].status, 'MISMATCH')
  assert.equal(hasBlockingFindings(findings), true)
})

test('the exception does NOT generalise to a different migration name', () => {
  const findings = evaluate([applied('20260101000000_other', PROD)], new Map([['20260101000000_other', REPAIRED]]))
  assert.equal(findings[0].status, 'MISMATCH')
  assert.equal(hasBlockingFindings(findings), true)
})

test('blocking when the PRODUCTION checksum is not the recorded original', () => {
  const findings = evaluate([applied(NAME, 'deadbeef')], new Map([[NAME, REPAIRED]]))
  assert.equal(findings[0].status, 'MISMATCH')
  assert.match(String(findings[0].detail), /ledger row is not the one the exception covers/)
  assert.equal(hasBlockingFindings(findings), true)
})

test('blocking when the REPOSITORY checksum is not the recorded repaired value', () => {
  const findings = evaluate([applied(NAME, PROD)], new Map([[NAME, 'cafebabe']]))
  assert.equal(findings[0].status, 'MISMATCH')
  assert.match(String(findings[0].detail), /edited again after the approved repair/)
  assert.equal(hasBlockingFindings(findings), true)
})

test('blocking when an applied migration has no file in the repository', () => {
  const findings = evaluate([applied('20260101000000_gone', 'aa')], new Map())
  assert.equal(findings[0].status, 'MISSING-FILE')
  assert.equal(hasBlockingFindings(findings), true)
})

test('rolled-back and unfinished ledger rows are not treated as applied', () => {
  const rows: LedgerRow[] = [
    { migration_name: 'x', checksum: 'aa', finished_at: null, rolled_back_at: new Date() },
    { migration_name: 'y', checksum: 'bb', finished_at: null, rolled_back_at: null },
  ]
  assert.deepEqual(evaluate(rows, new Map()), [])
})

test('checksums are line-ending independent — a CRLF checkout agrees with LF', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cw00-guard-'))
  try {
    const a = path.join(dir, 'lf.sql')
    const b = path.join(dir, 'crlf.sql')
    writeFileSync(a, 'SELECT 1;\nSELECT 2;\n')
    writeFileSync(b, 'SELECT 1;\r\nSELECT 2;\r\n')
    assert.equal(checksumMigrationFile(a), checksumMigrationFile(b))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readRepositoryChecksums walks migration directories and ignores stray files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cw00-guard-dir-'))
  try {
    mkdirSync(path.join(dir, '20260101000000_a'))
    writeFileSync(path.join(dir, '20260101000000_a', 'migration.sql'), 'SELECT 1;\n')
    mkdirSync(path.join(dir, '20260102000000_no_sql'))
    writeFileSync(path.join(dir, 'migration_lock.toml'), 'provider = "postgresql"\n')

    const map = readRepositoryChecksums(dir)
    assert.equal(map.size, 1)
    assert.ok(map.has('20260101000000_a'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('redactedTarget exposes host and database only, never credentials', () => {
  const out = redactedTarget('postgresql://someuser:sup3rsecret@db.example.com:5432/neondb')
  assert.equal(out, 'db.example.com/neondb')
  assert.ok(!out.includes('sup3rsecret'))
  assert.ok(!out.includes('someuser'))
  assert.equal(redactedTarget(undefined), '(DATABASE_URL unset)')
  assert.equal(redactedTarget('not a url'), '(unparseable DATABASE_URL)')
})

test('a CRLF-applied ledger checksum is recognised as identical content, not drift', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cw00-crlf-'))
  try {
    mkdirSync(path.join(dir, '20260101000000_a'))
    writeFileSync(path.join(dir, '20260101000000_a', 'migration.sql'), 'SELECT 1;\nSELECT 2;\n')
    const variants = readRepositoryChecksumVariants(dir).get('20260101000000_a')!
    assert.notEqual(variants.lf, variants.crlf)

    // Ledger recorded the CRLF rendering (migration applied from a Windows checkout).
    const findings = evaluate([applied('20260101000000_a', variants.crlf)], readRepositoryChecksumVariants(dir))
    assert.equal(findings[0].status, 'match-line-endings')
    assert.equal(hasBlockingFindings(findings), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('line-ending tolerance does NOT hide real content drift', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cw00-drift-'))
  try {
    mkdirSync(path.join(dir, '20260101000000_a'))
    writeFileSync(path.join(dir, '20260101000000_a', 'migration.sql'), 'SELECT 1;\n')
    const findings = evaluate([applied('20260101000000_a', 'a'.repeat(64))], readRepositoryChecksumVariants(dir))
    assert.equal(findings[0].status, 'MISMATCH')
    assert.equal(hasBlockingFindings(findings), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the recorded exception values are the real ones, not placeholders', () => {
  assert.match(PROD, /^[0-9a-f]{64}$/)
  assert.match(REPAIRED, /^[0-9a-f]{64}$/)
  assert.notEqual(PROD, REPAIRED)
  assert.equal(PROD, 'a67295d73829ac254daa326e71d2cfb3eaf4660e387115df50cd8d59b64f8882')
})
