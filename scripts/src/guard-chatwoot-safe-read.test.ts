import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'

import {
  FORBIDDEN_FIELDS,
  GUARD_OWN_FILES,
  findPrintedCredential,
  findUnsafeChatwootReads,
  isCommandLike,
  isGuardOwnFixtureFile,
  isProjectionMarker,
  isProse,
  isScannableFile,
  mentionsChatwootEndpoint,
  projectAgentBot,
  projectAllowlist,
  projectInbox,
  stripQuery,
} from './guard-chatwoot-safe-read'

/**
 * Synthetic credential values, BUILT AT RUNTIME.
 *
 * Two reasons, both deliberate, and both inherited from the CB-0 route tests:
 * the file then contains no `secret_name: '<literal>'` assignment for a scanner
 * (ours or GitHub's) to flag, and a fresh value each run means a test cannot
 * accidentally pass because an assertion was comparing against a constant that
 * had been copied into the code under test.
 */
const synthetic = (label: string): string =>
  `SYNTHETIC-${label}-${randomBytes(12).toString('hex')}-NOT-A-REAL-VALUE`

const SYNTHETIC = {
  api_key: synthetic('API-KEY'),
  webhook_verify_token: synthetic('VERIFY-TOKEN'),
  access_token: synthetic('ACCESS-TOKEN'),
  secret: synthetic('HMAC-SECRET'),
  url_token: synthetic('URL-TOKEN'),
} as const

/** Every synthetic value, for "this must appear nowhere" assertions. */
const ALL_SYNTHETIC: readonly string[] = Object.values(SYNTHETIC)

/** The shape that actually leaked on 2026-08-05. */
const LEAKED_INBOX_SHAPE = {
  id: 46,
  name: 'EPIC 295-6737 WhatsApp',
  channel_type: 'Channel::Whatsapp',
  phone_number: '+17672956737',
  provider: 'whatsapp_cloud',
  enable_auto_assignment: false,
  provider_config: {
    api_key: SYNTHETIC.api_key,
    phone_number_id: '278390858690809',
    business_account_id: '227366173803234',
    webhook_verify_token: SYNTHETIC.webhook_verify_token,
  },
}

const LEAKED_AGENT_BOT_SHAPE = {
  id: 4,
  name: 'Isola Brain (A2)',
  description: 'Foundation agent bot',
  bot_type: 'webhook',
  outgoing_url: 'https://isola-foundation.replit.app/api/chatwoot/agent-bot',
  access_token: SYNTHETIC.access_token,
  secret: SYNTHETIC.secret,
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
  for (const value of ALL_SYNTHETIC) assert.equal(serialised.includes(value), false)
})

test('projectAgentBot drops access_token and secret — the AgentBot incident', () => {
  const out = projectAgentBot(LEAKED_AGENT_BOT_SHAPE)
  assert.equal(out.id, 4)
  assert.equal(out.name, 'Isola Brain (A2)')
  assert.equal('access_token' in out, false)
  assert.equal('secret' in out, false)
  const serialised = JSON.stringify(out)
  for (const value of ALL_SYNTHETIC) assert.equal(serialised.includes(value), false)
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
    outgoing_url: `https://hooks.isola.epic.dm/v1/events?token=${SYNTHETIC.url_token}`,
  })
  assert.equal(out.outgoing_url, 'https://hooks.isola.epic.dm/v1/events?<stripped>')
  assert.equal(String(out.outgoing_url).includes(SYNTHETIC.url_token), false)
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
    '# the agent_bot read on /api/v1/accounts/5/inboxes/{id}/agent_bot leaks access_token',
    '// see /api/v1/accounts/5/inboxes/46 for the WhatsApp channel',
  ].join('\n')
  assert.deepEqual(findUnsafeChatwootReads('defect.md', prose), [])
})

test('a heading that OPENS with a bare method reads as an instruction, not a title', () => {
  // Narrowed deliberately under the bare-method/path rule: "GET <path> …" at the
  // start of a line is an instruction wherever it appears, including a markdown
  // heading. To write it as narration, lead with the noun — as the test above
  // does. This is the one case where the ruling's mechanical criterion is
  // stricter than a human reading, and stricter is the right side to err on.
  const findings = findUnsafeChatwootReads(
    'defect.md',
    '# GET /api/v1/accounts/5/inboxes/{id}/agent_bot leaks access_token',
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'unprojected_chatwoot_read')
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

/* ------------------------------------------------------------------------ *
 * REGRESSION — the three shapes that review proved were NOT caught.
 *
 * Every one of these is a real incident command with a pipe appended. The
 * original rule order asked "does this look projected?" first, accepted `jq`
 * as proof that it was, and returned early before the credential-field rule
 * ever ran — so the guard reported the repository CLEAN on all three.
 * ------------------------------------------------------------------------ */

const INBOX_READ = `curl -sS "$CW/api/v1/accounts/5/inboxes/46"`
const AGENT_BOT_READ = `curl -sS "$CW/api/v1/accounts/5/inboxes/46/agent_bot"`

test('BYPASS 1 — inbox endpoint piped to a jq selecting .provider_config', () => {
  const findings = findUnsafeChatwootReads('runbook.sh', `${INBOX_READ} | jq '.provider_config'`)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'forbidden_field_printed')
  assert.match(findings[0].reason, /provider_config/)
})

test('BYPASS 2 — inbox endpoint piped to a jq selecting .provider_config.api_key', () => {
  const findings = findUnsafeChatwootReads(
    'runbook.sh',
    `${INBOX_READ} | jq '.provider_config.api_key'`,
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'forbidden_field_printed')
})

test('BYPASS 3 — AgentBot endpoint piped to a jq selecting .access_token', () => {
  const findings = findUnsafeChatwootReads('runbook.sh', `${AGENT_BOT_READ} | jq '.access_token'`)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'forbidden_field_printed')
  assert.match(findings[0].reason, /access_token/)
})

test('using jq is not by itself evidence of projection', () => {
  assert.equal(isProjectionMarker(`jq '{id, name}'`), true)
  assert.equal(isProjectionMarker(`jq '.provider_config'`), false)
  assert.equal(isProjectionMarker(`jq '.access_token'`), false)
})

test('every forbidden field the owner ruling names is caught when selected and printed', () => {
  const required = [
    'provider_config',
    'api_key',
    'access_token',
    'webhook_verify_token',
    'verify_token',
    'app_secret',
    'hmac_secret',
  ]
  for (const field of required) {
    assert.ok(FORBIDDEN_FIELDS.includes(field), `${field} must be forbidden`)
    assert.equal(
      findPrintedCredential(`echo "$RESP" | jq '.${field}'`),
      field,
      `selecting .${field} into a sink must be a finding`,
    )
  }
})

test('an Authorization-style header reaching a sink is caught', () => {
  assert.equal(findPrintedCredential('echo "Authorization: Bearer $TOK"'), 'authorization header')
  assert.equal(
    findPrintedCredential('console.log("api_access_token: " + tok)'),
    'authorization header',
  )
  // Using a credential header is not printing one — a curl must not cry wolf.
  assert.equal(findPrintedCredential('curl -H "api_access_token: $TOK" https://x.example'), null)
})

test('the correctly-projected authenticated read is not flagged', () => {
  // Every legitimate Chatwoot read carries an auth header AND pipes to jq. If
  // the guard flagged this it would be crying wolf on the command operators are
  // told to run, and it would be ignored within a week.
  const safe = `curl -sS -H "api_access_token: $TOK" "$CW/api/v1/accounts/5/inboxes/46" | jq '{id, name, channel_type}'`
  assert.equal(findPrintedCredential(safe), null)
  assert.deepEqual(findUnsafeChatwootReads('runbook.sh', safe), [])
})

test('a request header does not excuse selecting a credential downstream', () => {
  const bad = `curl -sS -H "api_access_token: $TOK" "$CW/api/v1/accounts/5/inboxes/46" | jq '.provider_config'`
  const findings = findUnsafeChatwootReads('runbook.sh', bad)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'forbidden_field_printed')
})

/* ------------------------------------------------------- output sinks */

test('the sink list covers stderr, stdout writes and the PowerShell forms', () => {
  const sinks = [
    'console.error(inbox.provider_config)',
    'console.warn(inbox.provider_config)',
    'process.stdout.write(bot.access_token)',
    'process.stderr.write(bot.access_token)',
    `printf '%s' "$(echo "$R" | jq -r '.api_key')"`,
    `cat resp.json | jq '.access_token' | tee leak.txt`,
    'Write-Host $inbox.provider_config',
    'Write-Output $bot.access_token',
    '$bot | Select-Object -ExpandProperty access_token | ConvertTo-Json',
  ]
  for (const line of sinks) {
    assert.notEqual(findPrintedCredential(line), null, `must flag: ${line}`)
  }
})

/* --------------------------------------------------------- PowerShell */

test('a PowerShell read of a sensitive endpoint is scanned and flagged', () => {
  assert.equal(isScannableFile('ops/chatwoot-inbox.ps1'), true)
  assert.equal(isScannableFile('ops/chatwoot.psm1'), true)
  const findings = findUnsafeChatwootReads(
    'ops/chatwoot-inbox.ps1',
    '$r = Invoke-RestMethod "$CW/api/v1/accounts/5/inboxes/46"',
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'unprojected_chatwoot_read')
})

test('PowerShell object output of a credential field is flagged', () => {
  const findings = findUnsafeChatwootReads(
    'ops/chatwoot-inbox.ps1',
    ['$r = Get-Inbox 46', 'Write-Host $r.provider_config'].join('\n'),
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'forbidden_field_printed')
  assert.equal(findings[0].line, 2)
})

test('commented-out code that prints a credential is still flagged', () => {
  // Commented-out code gets uncommented. Prose that merely NAMES a field does
  // not select it, and stays exempt — that is the distinction being drawn.
  const findings = findUnsafeChatwootReads('ops.ts', '// console.log(inbox.provider_config)')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'forbidden_field_printed')
})

test('a finding never carries the offending line or any value from it', () => {
  const line = `${INBOX_READ} | jq '.provider_config' # ${SYNTHETIC.api_key}`
  const findings = findUnsafeChatwootReads('runbook.sh', line)
  assert.equal(findings.length, 1)
  const serialised = JSON.stringify(findings)
  for (const value of ALL_SYNTHETIC) assert.equal(serialised.includes(value), false)
  assert.equal(serialised.includes('curl'), false)
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

test('the guard excludes only its own fixture-bearing files, by exact path', () => {
  assert.equal(GUARD_OWN_FILES.length, 3)
  for (const own of GUARD_OWN_FILES) {
    assert.equal(isGuardOwnFixtureFile(own), true, own)
  }
  // A runbook cannot be parked next to the guard to escape the scan.
  assert.equal(isGuardOwnFixtureFile('scripts/src/chatwoot-runbook.md'), false)
  assert.equal(isGuardOwnFixtureFile('docs/isola/runbook.md'), false)
})

test('the exclusion is an exact path match, not a filename suffix match', () => {
  // The earlier `endsWith` form silently excluded any file that happened to sit
  // at `<anything>/src/guard-chatwoot-safe-read.ts`. Only the real paths count.
  assert.equal(isGuardOwnFixtureFile('artifacts/isola/src/guard-chatwoot-safe-read.ts'), false)
  assert.equal(isGuardOwnFixtureFile('vendor/scripts/src/guard-chatwoot-safe-read.ts'), false)
  assert.equal(isGuardOwnFixtureFile('a/b/guard-chatwoot-safe-read.test.ts'), false)
})

test('the package-relative spelling is no longer excluded — discovery is root-anchored', () => {
  // It only ever existed to paper over the cwd bug. File discovery now resolves
  // the repository root, so `src/…` can never be produced for these files, and
  // keeping the alias would exclude a real `src/guard-chatwoot-safe-read.ts`.
  assert.equal(isGuardOwnFixtureFile('src/guard-chatwoot-safe-read.ts'), false)
  assert.equal(isGuardOwnFixtureFile('src/guard-chatwoot-safe-read.test.ts'), false)
})

/* --------------------------------------------- markdown bullet equivalence */

const BULLETS = ['*', '-', '+'] as const

test('an unsafe command is flagged identically under *, - and + bullets', () => {
  const unsafe = `${INBOX_READ} | jq '.provider_config'`
  const kinds = BULLETS.map((b) => {
    const findings = findUnsafeChatwootReads('plan.md', `${b} ${unsafe}`)
    assert.equal(findings.length, 1, `bullet ${b} must produce exactly one finding`)
    return findings[0].kind
  })
  assert.deepEqual(kinds, ['forbidden_field_printed', 'forbidden_field_printed', 'forbidden_field_printed'])
})

test('an unprojected read is flagged identically under *, - and + bullets', () => {
  for (const b of BULLETS) {
    const findings = findUnsafeChatwootReads('plan.md', `${b} **Capture:** \`${INBOX_READ}\``)
    assert.equal(findings.length, 1, `bullet ${b}`)
    assert.equal(findings[0].kind, 'unprojected_chatwoot_read')
  }
})

test('plain explanatory prose stays exempt under *, - and + alike', () => {
  const sentences = [
    'a call to GET /api/v1/accounts/5/inboxes/46 returned provider_config, which we then filtered',
    'the AgentBot read at /api/v1/accounts/5/inboxes/46/agent_bot is what leaked the token',
  ]
  for (const b of BULLETS) {
    for (const sentence of sentences) {
      assert.deepEqual(
        findUnsafeChatwootReads('defect.md', `${b} ${sentence}`),
        [],
        `bullet ${b}: ${sentence}`,
      )
    }
  }
})

test('a bullet holding a runnable command is operational content, not prose', () => {
  // The distinction is a code span: an instruction to run something, versus a
  // sentence narrating a call that already happened.
  assert.equal(isCommandLike('**Before-state:** `GET /api/v1/accounts/5/webhooks`'), true)
  assert.equal(isCommandLike('`Invoke-RestMethod "$CW/api/v1/accounts/5/inboxes/46"`'), true)
  assert.equal(isCommandLike('a call to GET /api/v1/accounts/5/inboxes/46 returned provider_config'), false)
  assert.equal(isProse('- **Before-state:** `GET /api/v1/accounts/5/webhooks`'), false)
  assert.equal(isProse('- the endpoint returned more than we expected'), true)
})

/* ----------------------------------------------- abbreviated endpoint paths */

test('an abbreviated endpoint is detected in both ellipsis spellings', () => {
  assert.equal(mentionsChatwootEndpoint('GET …/webhooks'), true)
  assert.equal(mentionsChatwootEndpoint('GET .../webhooks'), true)
  assert.equal(mentionsChatwootEndpoint('DELETE …/inboxes/46'), true)
  assert.equal(mentionsChatwootEndpoint('…/agent_bot'), true)
})

test('a sentence that merely trails off is not an endpoint', () => {
  // The detection must be narrow: ellipsis immediately followed by a Chatwoot
  // resource. Prose is full of ellipses.
  assert.equal(mentionsChatwootEndpoint('we captured the flags first …'), false)
  assert.equal(mentionsChatwootEndpoint('the response was large ... so we trimmed it'), false)
  assert.equal(mentionsChatwootEndpoint('see the plan for details ...'), false)
  assert.deepEqual(
    findUnsafeChatwootReads('plan.md', '- the retirement went fine … nothing else changed'),
    [],
  )
})

test('the fifth R1 instruction — an abbreviated verification read — is now flagged', () => {
  for (const bullet of BULLETS) {
    const findings = findUnsafeChatwootReads(
      'plan.md',
      `${bullet} **Verification:** \`GET …/webhooks\` no longer lists 72 or 73`,
    )
    assert.equal(findings.length, 1, `bullet ${bullet}`)
    assert.equal(findings[0].kind, 'unprojected_chatwoot_read')
  }
  // ASCII spelling, same outcome.
  const ascii = findUnsafeChatwootReads('plan.md', '- **Verification:** `GET .../webhooks` unchanged')
  assert.equal(ascii.length, 1)
  assert.equal(ascii[0].kind, 'unprojected_chatwoot_read')
})

test('an abbreviated read flowing into an unsafe sink is flagged as a credential print', () => {
  const findings = findUnsafeChatwootReads('runbook.sh', `curl -sS "$CW/…/webhooks" | jq '.secret'`)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'forbidden_field_printed')
})

test('an abbreviated read that is explicitly projected is clean', () => {
  const safe = `curl -sS -H "api_access_token: $TOK" "$CW/…/webhooks" | jq '[.payload[] | {id, url, name, subscriptions, account_id}]'`
  assert.deepEqual(findUnsafeChatwootReads('runbook.sh', safe), [])
})

test('narrative prose about an abbreviated endpoint stays exempt', () => {
  const narrative = [
    'A prior GET request to …/webhooks returned every secret, which is how the leak happened.',
    'The …/agent_bot read was the second exposure that day.',
  ]
  for (const line of narrative) {
    assert.deepEqual(findUnsafeChatwootReads('defect.md', line), [], line)
    for (const bullet of BULLETS) {
      assert.deepEqual(findUnsafeChatwootReads('defect.md', `${bullet} ${line}`), [], `${bullet} ${line}`)
    }
  }
})

/* ------------------------------------------------ imperative / bare method */

test('a bare HTTP method against a path is operational under every bullet', () => {
  for (const bullet of BULLETS) {
    const findings = findUnsafeChatwootReads(
      'plan.md',
      `${bullet} GET \`/api/v1/accounts/5/webhooks\``,
    )
    assert.equal(findings.length, 1, `bullet ${bullet}`)
    assert.equal(findings[0].kind, 'unprojected_chatwoot_read')
  }
})

test('an imperative instruction to run the request is operational', () => {
  assert.equal(isCommandLike('Run the webhook GET and inspect the output.'), true)
  assert.equal(isCommandLike('Call /api/v1/accounts/5/webhooks and record the ids.'), true)
  assert.equal(isCommandLike('Capture using the before-state read.'), true)
  assert.equal(isCommandLike('Verify using the webhook list.'), true)
  const findings = findUnsafeChatwootReads('plan.md', '- Fetch /api/v1/accounts/5/webhooks and record it')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'unprojected_chatwoot_read')
})

test('an imperative verb used as a NOUN mid-sentence does not make prose operational', () => {
  // "a call to GET …" — matching the verb anywhere would flag every write-up of
  // the incident. The imperative must open the instruction.
  const narrative = 'a call to GET /api/v1/accounts/5/inboxes/46 returned provider_config'
  assert.equal(isCommandLike(narrative), false)
  assert.deepEqual(findUnsafeChatwootReads('defect.md', `> ${narrative}`), [])
  assert.deepEqual(findUnsafeChatwootReads('defect.md', narrative), [])
})

test("the owner's narrative example is exempt and the operational one is scanned", () => {
  assert.deepEqual(
    findUnsafeChatwootReads(
      'defect.md',
      'A prior GET request to /api/v1/accounts/5/inboxes/46 returned provider_config.',
    ),
    [],
  )
  const operational = findUnsafeChatwootReads(
    'plan.md',
    'GET /api/v1/accounts/5/inboxes/46 and print the response.',
  )
  assert.equal(operational.length, 1)
})

test('in a script an unmarked line is code, not prose', () => {
  // Markdown paragraphs are narration; a bare line in a shell script is not.
  assert.equal(
    findUnsafeChatwootReads('runbook.sh', '"$CW/api/v1/accounts/5/inboxes/46"').length,
    1,
  )
  assert.deepEqual(findUnsafeChatwootReads('plan.md', 'the inboxes endpoint /api/v1/accounts/5/inboxes/46 exists'), [])
})

/* ------------------------------------------- write responses may be discarded */

test('a write whose response body is discarded is not a finding', () => {
  const suppressed = `curl -sS -X DELETE -o /dev/null -w '%{http_code}\\n' "$CW/api/v1/accounts/5/webhooks/72"`
  assert.equal(isProjectionMarker(suppressed), true)
  assert.deepEqual(findUnsafeChatwootReads('runbook.sh', suppressed), [])
})

test('discarding the body does not excuse selecting a credential first', () => {
  const bad = `curl -sS "$CW/api/v1/accounts/5/inboxes/46" | jq '.provider_config' > /dev/null`
  const findings = findUnsafeChatwootReads('runbook.sh', bad)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'forbidden_field_printed')
})

test('the own-file exclusion normalises Windows separators', () => {
  assert.equal(isGuardOwnFixtureFile('scripts\\src\\guard-chatwoot-safe-read.ts'.split('\\').join('/')), true)
})

test('scans runbooks and scripts, ignores everything else', () => {
  assert.equal(isScannableFile('docs/isola/runbook.md'), true)
  assert.equal(isScannableFile('scripts/src/thing.ts'), true)
  assert.equal(isScannableFile('ops/deploy.sh'), true)
  assert.equal(isScannableFile('ops/deploy.ps1'), true)
  assert.equal(isScannableFile('image.png'), false)
  assert.equal(isScannableFile('data.json'), false)
})
