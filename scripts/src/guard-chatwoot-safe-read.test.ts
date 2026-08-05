import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FORBIDDEN_FIELDS,
  GUARD_OWN_FILES,
  findUnsafeChatwootReads,
  isGuardOwnFixtureFile,
  isScannableFile,
  projectAgentBot,
  projectAllowlist,
  projectInbox,
  stripQuery,
} from './guard-chatwoot-safe-read'

/**
 * The shape that actually leaked on 2026-08-05. Values are obvious placeholders —
 * no real credential appears in this repository, and the guard is field-driven,
 * so the value's shape is irrelevant to what it does.
 */
const PLACEHOLDER = 'PLACEHOLDER-NOT-REAL'

const LEAKED_INBOX_SHAPE = {
  id: 46,
  name: 'EPIC 295-6737 WhatsApp',
  channel_type: 'Channel::Whatsapp',
  phone_number: '+17672956737',
  provider: 'whatsapp_cloud',
  enable_auto_assignment: false,
  provider_config: {
    api_key: PLACEHOLDER,
    phone_number_id: '278390858690809',
    business_account_id: '227366173803234',
    webhook_verify_token: PLACEHOLDER,
  },
}

const LEAKED_AGENT_BOT_SHAPE = {
  id: 4,
  name: 'Isola Brain (A2)',
  description: 'Foundation agent bot',
  bot_type: 'webhook',
  outgoing_url: 'https://isola-foundation.replit.app/api/chatwoot/agent-bot',
  access_token: PLACEHOLDER,
  secret: PLACEHOLDER,
}

test('projectInbox keeps the operational fields', () => {
  const out = projectInbox(LEAKED_INBOX_SHAPE)
  assert.equal(out.id, 46)
  assert.equal(out.name, 'EPIC 295-6737 WhatsApp')
  assert.equal(out.channel_type, 'Channel::Whatsapp')
  assert.equal(out.phone_number, '+17672956737')
  assert.equal(out.enable_auto_assignment, false)
})

test('projectInbox drops provider_config entirely — the WhatsApp incident', () => {
  const out = projectInbox(LEAKED_INBOX_SHAPE)
  assert.equal('provider_config' in out, false)
  const serialised = JSON.stringify(out)
  assert.equal(serialised.includes('api_key'), false)
  assert.equal(serialised.includes('webhook_verify_token'), false)
  assert.equal(serialised.includes(PLACEHOLDER), false)
})

test('projectAgentBot drops access_token and secret — the AgentBot incident', () => {
  const out = projectAgentBot(LEAKED_AGENT_BOT_SHAPE)
  assert.equal(out.id, 4)
  assert.equal(out.name, 'Isola Brain (A2)')
  assert.equal('access_token' in out, false)
  assert.equal('secret' in out, false)
  assert.equal(JSON.stringify(out).includes('PLACEHOLDER'), false)
})

test('an unknown field Chatwoot adds tomorrow is dropped, not inspected', () => {
  const out = projectInbox({ ...LEAKED_INBOX_SHAPE, some_future_credential_bag: 'anything' })
  assert.equal('some_future_credential_bag' in out, false)
})

test('a nested object under an allowlisted name is dropped — depth cannot hide a credential', () => {
  const out = projectAllowlist({ name: { nested: 'value' }, id: 1 }, ['id', 'name'])
  assert.deepEqual(out, { id: 1 })
})

test('a bad allowlist edit fails loudly rather than leaking', () => {
  assert.throws(
    () => projectAllowlist(LEAKED_INBOX_SHAPE, ['id', 'api_key']),
    /forbidden field/i,
  )
})

test('outgoing_url keeps its shape but loses any query string', () => {
  const out = projectAgentBot({
    ...LEAKED_AGENT_BOT_SHAPE,
    outgoing_url: `https://hooks.isola.epic.dm/v1/events?token=${PLACEHOLDER}`,
  })
  assert.equal(out.outgoing_url, 'https://hooks.isola.epic.dm/v1/events?<stripped>')
  assert.equal(String(out.outgoing_url).includes(PLACEHOLDER), false)
})

test('stripQuery leaves a clean URL untouched and passes non-strings through', () => {
  assert.equal(stripQuery('https://a.example/b'), 'https://a.example/b')
  assert.equal(stripQuery(42), 42)
})

test('projecting a non-object yields an empty object rather than throwing', () => {
  assert.deepEqual(projectInbox(null), {})
  assert.deepEqual(projectInbox('a string'), {})
  assert.deepEqual(projectInbox([1, 2]), {})
})

// --- static check -----------------------------------------------------------

test('flags the exact command that leaked the Meta token', () => {
  const findings = findUnsafeChatwootReads(
    'runbook.md',
    'curl -sS -H "api_access_token: $TOK" https://inbox.epic.dm/api/v1/accounts/5/inboxes/46',
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'unprojected_chatwoot_read')
  assert.equal(findings[0].line, 1)
})

test('flags the exact command that leaked the AgentBot credentials', () => {
  const findings = findUnsafeChatwootReads(
    'runbook.sh',
    'curl -sS "$CW/api/v1/accounts/5/inboxes/46/agent_bot"',
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'unprojected_chatwoot_read')
})

test('does NOT flag the same read when it is projected through jq', () => {
  const findings = findUnsafeChatwootReads(
    'runbook.sh',
    `curl -sS "$CW/api/v1/accounts/5/inboxes/46" | jq '{id, name, channel_type}'`,
  )
  assert.deepEqual(findings, [])
})

test('does NOT flag the same read when it is projected through the helper', () => {
  const findings = findUnsafeChatwootReads(
    'ops.ts',
    'const safe = projectInbox(await get("/api/v1/accounts/5/inboxes/46"))',
  )
  assert.deepEqual(findings, [])
})

test('does NOT flag prose describing the endpoint — Port records must stay writable', () => {
  const prose = [
    '> a call to GET /api/v1/accounts/5/inboxes/46 returned provider_config',
    '# GET /api/v1/accounts/5/inboxes/{id}/agent_bot leaks access_token',
    '// see /api/v1/accounts/5/inboxes/46 for the WhatsApp channel',
  ].join('\n')
  assert.deepEqual(findUnsafeChatwootReads('defect.md', prose), [])
})

test('flags a jq filter that selects a credential field directly', () => {
  const findings = findUnsafeChatwootReads('bad.sh', "echo \"$RESPONSE\" | jq '.provider_config'")
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'forbidden_field_printed')
})

test('does not flag the mere word "secret" in ordinary prose', () => {
  assert.deepEqual(
    findUnsafeChatwootReads('notes.md', 'The shared secret is rotated by the owner.'),
    [],
  )
})

test('reports one finding per offending line, with a 1-based line number', () => {
  const findings = findUnsafeChatwootReads(
    'multi.sh',
    ['#!/bin/sh', 'curl "$CW/api/v1/accounts/5/inboxes/46"', 'echo done'].join('\n'),
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].line, 2)
})

test('FORBIDDEN_FIELDS covers both fields from both incidents', () => {
  for (const field of ['provider_config', 'api_key', 'webhook_verify_token', 'access_token', 'secret']) {
    assert.ok(FORBIDDEN_FIELDS.includes(field), `${field} must be forbidden`)
  }
})

test('the guard excludes only its own two fixture-bearing files', () => {
  assert.equal(GUARD_OWN_FILES.length, 2)
  assert.equal(isGuardOwnFixtureFile('scripts/src/guard-chatwoot-safe-read.ts'), true)
  assert.equal(isGuardOwnFixtureFile('scripts/src/guard-chatwoot-safe-read.test.ts'), true)
  // Invoked from `scripts/`, git yields the package-relative path.
  assert.equal(isGuardOwnFixtureFile('src/guard-chatwoot-safe-read.ts'), true)
  assert.equal(isGuardOwnFixtureFile('src/guard-chatwoot-safe-read.test.ts'), true)
  // A runbook cannot be parked next to the guard to escape the scan.
  assert.equal(isGuardOwnFixtureFile('scripts/src/chatwoot-runbook.md'), false)
  assert.equal(isGuardOwnFixtureFile('docs/isola/runbook.md'), false)
})

test('the own-file exclusion normalises Windows separators', () => {
  assert.equal(isGuardOwnFixtureFile('scripts\\src\\guard-chatwoot-safe-read.ts'.split('\\').join('/')), true)
})

test('scans runbooks and scripts, ignores everything else', () => {
  assert.equal(isScannableFile('docs/isola/runbook.md'), true)
  assert.equal(isScannableFile('scripts/src/thing.ts'), true)
  assert.equal(isScannableFile('ops/deploy.sh'), true)
  assert.equal(isScannableFile('image.png'), false)
  assert.equal(isScannableFile('data.json'), false)
})
