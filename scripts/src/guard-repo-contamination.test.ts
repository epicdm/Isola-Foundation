import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ALLOWED_BUNDLES,
  LARGE_FILE_BYTES,
  evaluate,
  formatHuman,
  hasBlockingFindings,
  isBundleFile,
  isPrismaSchemaBackup,
  normalise,
} from './guard-repo-contamination'

// The two files the Replit Agent actually committed on 2026-07-31.
const AGENT_BUNDLE = 'foundation-lane-2b4fba8.bundle'
const AGENT_SCHEMA_BACKUP = 'artifacts/isola/prisma/schema.prisma.backup.1785530798'

// Real paths from this repository that must never be flagged.
const LEGITIMATE = [
  'artifacts/isola/lib/context/context-bundle.ts',
  'artifacts/isola/lib/context/context-bundle.test.ts',
  'artifacts/isola/prisma/schema.prisma',
  'artifacts/isola/prisma/migrations/20260731140000_channel_binding/migration.sql',
  'artifacts/isola/prisma/migrations/20260731200000_projected_activity/migration.sql',
  'artifacts/isola/prisma/migrations/migration_lock.toml',
  'evidence/stage1/isola-stage1.bundle',
  'package.json',
  'scripts/src/guard-repo-contamination.ts',
]

test('the incident bundle is a finding', () => {
  const findings = evaluate([AGENT_BUNDLE])
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.kind, 'unapproved_bundle')
  assert.equal(findings[0]?.file, AGENT_BUNDLE)
  assert.ok(hasBlockingFindings(findings))
})

test('the incident Prisma schema backup is a finding', () => {
  const findings = evaluate([AGENT_SCHEMA_BACKUP])
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.kind, 'prisma_schema_backup')
  assert.equal(findings[0]?.file, AGENT_SCHEMA_BACKUP)
})

test('both incident files are caught together', () => {
  const findings = evaluate([AGENT_BUNDLE, AGENT_SCHEMA_BACKUP, ...LEGITIMATE])
  assert.equal(findings.length, 2)
  assert.deepEqual(
    findings.map((f) => f.kind).sort(),
    ['prisma_schema_backup', 'unapproved_bundle'],
  )
})

test('legitimate repository files are never flagged', () => {
  const findings = evaluate(LEGITIMATE)
  assert.deepEqual(findings, [])
  assert.equal(hasBlockingFindings(findings), false)
})

test('context-bundle source files are not bundles', () => {
  // The name contains "bundle"; the extension does not. This is the near-miss
  // that would make the guard useless if it were wrong.
  assert.equal(isBundleFile('artifacts/isola/lib/context/context-bundle.ts'), false)
  assert.equal(isBundleFile('artifacts/isola/lib/context/context-bundle.test.ts'), false)
  assert.equal(isBundleFile('foundation-lane-2b4fba8.bundle'), true)
})

test('the canonical Prisma schema and its migrations are not backups', () => {
  assert.equal(isPrismaSchemaBackup('artifacts/isola/prisma/schema.prisma'), false)
  assert.equal(
    isPrismaSchemaBackup('artifacts/isola/prisma/migrations/20260731140000_channel_binding/migration.sql'),
    false,
  )
  assert.equal(isPrismaSchemaBackup(AGENT_SCHEMA_BACKUP), true)
  assert.equal(isPrismaSchemaBackup('prisma/schema.prisma.backup.1'), true)
})

test('the allowlisted bundle is permitted, and only exactly it', () => {
  assert.deepEqual(evaluate([...ALLOWED_BUNDLES]), [])
  // A lookalike in another directory is NOT allowlisted.
  const findings = evaluate(['evidence/stage2/isola-stage1.bundle'])
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.kind, 'unapproved_bundle')
})

test('a large unapproved bundle is labelled large, but size never gates the finding', () => {
  const big = evaluate([AGENT_BUNDLE], () => LARGE_FILE_BYTES + 1)
  assert.match(big[0]?.reason ?? '', /large/)

  const tiny = evaluate([AGENT_BUNDLE], () => 12)
  assert.equal(tiny.length, 1, 'a small bundle is still a finding')
  assert.doesNotMatch(tiny[0]?.reason ?? '', /large/)
})

test('a missing size degrades to null rather than throwing', () => {
  const findings = evaluate([AGENT_BUNDLE], () => null)
  assert.equal(findings[0]?.bytes, null)
})

test('windows-style separators are normalised', () => {
  assert.equal(normalise('artifacts\\isola\\prisma\\schema.prisma.backup.1'), 'artifacts/isola/prisma/schema.prisma.backup.1')
  assert.equal(evaluate(['artifacts\\isola\\prisma\\schema.prisma.backup.1']).length, 1)
})

test('an empty tree is clean', () => {
  assert.deepEqual(evaluate([]), [])
  assert.deepEqual(evaluate(['']), [])
})

test('findings are reported by name and size only, never contents', () => {
  const text = formatHuman(evaluate([AGENT_BUNDLE], () => 70413463))
  assert.match(text, /foundation-lane-2b4fba8\.bundle/)
  assert.match(text, /70413463 B/)
  assert.match(text, /refusing to proceed/)
  // The clean message must not imply a failure.
  assert.match(formatHuman([]), /clean/)
})

test('findings are sorted deterministically', () => {
  const a = evaluate([AGENT_BUNDLE, AGENT_SCHEMA_BACKUP]).map((f) => f.file)
  const b = evaluate([AGENT_SCHEMA_BACKUP, AGENT_BUNDLE]).map((f) => f.file)
  assert.deepEqual(a, b)
})
