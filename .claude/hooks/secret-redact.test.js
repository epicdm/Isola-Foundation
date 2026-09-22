'use strict';
/**
 * Tests for secret-redact.
 *
 * THE TWO REGRESSION CASES AT THE TOP ARE THE POINT OF THIS FILE. They are the
 * exact output shapes of the two exposures on 2026-08-16 that isola-guard could
 * not catch, because neither command looked like a secret read:
 *     `git remote -v`  and a line-range read of an Asterisk SIP peers config.
 * Every credential value here is FAKE and structurally equivalent to the real
 * one. Never paste a live credential into a test.
 *
 * Run: node --test .claude/hooks/secret-redact.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { redact, hasSecret } = require('./lib/secret-redact.js');

const FAKE_PAT = 'github_pat_11BAAAAAA0e2VM7XbHTzhs_FAKEFAKEFAKEfakefake123456789abcdefghij';
const FAKE_SIP = 'hux8GiJKDq1v';

// ===========================================================================
// REGRESSION — the two real 2026-08-16 exposures
// ===========================================================================

test('REGRESSION 1: `git remote -v` output — PAT in a remote URL is redacted', () => {
  const line = 'origin\thttps://epicdm:' + FAKE_PAT + '@github.com/epicdm/isolav2.git (fetch)';
  const out = redact(line);
  assert.ok(!out.includes(FAKE_PAT), 'the PAT must not survive in any form');
  // The useful, non-secret parts must remain readable or the output is useless.
  assert.ok(out.includes('github.com/epicdm/isolav2.git'), 'repo must stay readable');
  assert.ok(out.includes('origin'), 'remote name must stay readable');
  assert.ok(out.includes('epicdm'), 'username is not a secret and stays');
});

test('REGRESSION 2: SIP peers config — plaintext secret= is redacted', () => {
  const block = [
    '[livekittestagen_9666]',
    'accountcode=org_epiccommun_w65xx',
    'secret=' + FAKE_SIP,
    'host=dynamic',
    'context=billing',
  ].join('\n');
  const out = redact(block);
  assert.ok(!out.includes(FAKE_SIP), 'the SIP secret must not survive');
  assert.ok(out.includes('secret=[REDACTED:secret]'), 'and it must be labelled');
  // Everything an engineer actually needed from that read must still be there.
  assert.ok(out.includes('[livekittestagen_9666]'));
  assert.ok(out.includes('accountcode=org_epiccommun_w65xx'));
  assert.ok(out.includes('host=dynamic'));
  assert.ok(out.includes('context=billing'));
});

test('REGRESSION 3: two-segment key name (PAPERCLIP_API_TOKEN) is redacted', () => {
  // Real exposure 2026-08-16: `PAPERCLIP_API_TOKEN=pcp_board_...` leaked in
  // plaintext through this exact redactor. The prefix group only tolerated ONE
  // underscore-delimited segment before the keyword, and `_` is a word
  // character, so `\b` never anchored between "PAPERCLIP_" and "API_" — the
  // regex could never reach "TOKEN". Any two-plus segment key name had the
  // same hole.
  const FAKE_BOARD_TOKEN = 'pcp_board_FAKEFAKEFAKEfakefake0000000000000000';
  const line = 'PAPERCLIP_API_TOKEN=' + FAKE_BOARD_TOKEN;
  const out = redact(line);
  assert.ok(!out.includes(FAKE_BOARD_TOKEN), 'the board token must not survive');
  assert.ok(out.includes('PAPERCLIP_API_TOKEN=[REDACTED:token]'), 'and it must be labelled');
});

test('REGRESSION 4: camelCase / JSON-quoted secret PROPERTIES are redacted by NAME, whatever the value shape', () => {
  // Real exposure 2026-09-22: a gateway bindings store read through this pipe
  // printed two agentBotSecret/agentBotAccessToken values in the clear. They were
  // short mixed-alnum, so no SHAPE rule fired, and the `assignment` rule's `\b`
  // can never anchor before "Secret" inside a camelCase key. Every value below is
  // FAKE and shape-equivalent (short, mixed case, no vendor prefix, not hex).
  const FAKE_BOT_SECRET = 'Qx7mKp2vTn9bLw4cRz';
  const FAKE_BOT_TOKEN = 'nH3sYg8dWq5jFa2kMv1e';
  const json = '{"name":"epic-frontdesk-x","chatwootAccountId":5,"agentBotSecret":"' + FAKE_BOT_SECRET +
    '","agentBotAccessToken":"' + FAKE_BOT_TOKEN + '","inboxId":46,"status":"active"}';
  const out = redact(json);
  assert.ok(!out.includes(FAKE_BOT_SECRET), 'agentBotSecret value survived');
  assert.ok(!out.includes(FAKE_BOT_TOKEN), 'agentBotAccessToken value survived');
  assert.ok(out.includes('"agentBotSecret":"[REDACTED:secret]"'), 'must be labelled and keep the key readable');
  assert.ok(out.includes('"agentBotAccessToken":"[REDACTED:token]"'));
  // Non-secret neighbours must stay readable or the read is useless.
  assert.ok(out.includes('"chatwootAccountId":5') && out.includes('"inboxId":46') && out.includes('"status":"active"'));
  assert.ok(out.includes('"name":"epic-frontdesk-x"'));

  // Same keys in YAML and in a bare camelCase assignment.
  assert.ok(!redact('agentBotSecret: ' + FAKE_BOT_SECRET).includes(FAKE_BOT_SECRET), 'yaml camelCase');
  assert.ok(!redact('agentBotAccessToken=' + FAKE_BOT_TOKEN).includes(FAKE_BOT_TOKEN), 'bare camelCase');
  // Quoted value WITH spaces (previously a miss for the assignment rule).
  assert.ok(!redact('password: "pass phrase with spaces"').includes('pass phrase'), 'quoted value with spaces');
});

test('REGRESSION 4 controls: the property rule does not blank ordinary properties or env references', () => {
  const cfg = '{"chatwootAccountId":5,"inboxId":46,"accountId":"acct_9f2k","tokenCount":12,"status":"active"}';
  assert.strictEqual(redact(cfg), cfg, 'non-secret properties must be untouched');
  assert.strictEqual(redact('"agentBotSecret": "$BOT_SECRET"'), '"agentBotSecret": "$BOT_SECRET"', 'env ref preserved');
  assert.strictEqual(redact('agentBotAccessToken=${BOT_TOKEN}'), 'agentBotAccessToken=${BOT_TOKEN}');
  // Positive twin proving the control's key names are genuinely distinct from
  // the redacted ones: give a matching key the same value shape and it MUST fire.
  assert.ok(!redact('{"accountSecret":"acct_9f2k"}').includes('acct_9f2k'), 'control value shape is redactable when the NAME matches');
});

// ===========================================================================
// POSITIVE CONTROLS — the filter must actually fire on each shape.
// Without these, a broken regex makes every "not present" assertion vacuous.
// ===========================================================================

const SHAPES = [
  ['github classic', 'ghp_' + 'A'.repeat(36)],
  ['aws key id', 'AKIAIOSFODNN7EXAMPLE'],
  ['google api key', 'AIza' + 'B'.repeat(35)],
  ['groq key', 'gsk_' + 'C'.repeat(40)],
  ['openai key', 'sk-proj-' + 'D'.repeat(40)],
  ['slack token', 'xoxb-123456789012-abcdefghijklmno'],
  ['meta token', 'EA' + 'E'.repeat(40)],
  ['jwt', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV'],
  ['long hex', 'f'.repeat(40)],
];

for (const [label, value] of SHAPES) {
  test('positive control: ' + label + ' is redacted', () => {
    const out = redact('value is ' + value + ' end');
    assert.ok(!out.includes(value), label + ' survived redaction');
    assert.ok(out.includes('[REDACTED:'), label + ' was dropped but not labelled');
    assert.ok(out.includes('end'), 'surrounding text must survive');
  });
}

test('positive control: PEM private key block is replaced entirely', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKC\nAAAA\n-----END RSA PRIVATE KEY-----';
  const out = redact('key:\n' + pem + '\ndone');
  assert.ok(!out.includes('MIIEowIBAAKC'));
  assert.ok(out.includes('[REDACTED:private-key]'));
  assert.ok(out.includes('done'));
});

test('positive control: assignment forms all fire', () => {
  for (const key of ['password', 'token', 'api_key', 'apikey', 'client_secret', 'secretAccessKey']) {
    const out = redact(key + '=SuperSecretValue123');
    assert.ok(!out.includes('SuperSecretValue123'), key + ' was not redacted');
  }
});

// ===========================================================================
// NEGATIVE CONTROLS — over-redaction destroys the readability that makes a
// config review possible. A filter that blanks everything is not a win.
// ===========================================================================

test('env var references are preserved, not blanked', () => {
  assert.strictEqual(redact('password=$DB_PASSWORD'), 'password=$DB_PASSWORD');
  assert.strictEqual(redact('token=${GITHUB_TOKEN}'), 'token=${GITHUB_TOKEN}');
  assert.strictEqual(redact('secret=%SIP_SECRET%'), 'secret=%SIP_SECRET%');
});

test('a short git sha stays readable — 8-16 hex is not a credential', () => {
  assert.ok(redact('HEAD is 8b31853').includes('8b31853'), 'short sha must survive');
  assert.ok(redact('commit adf3230 landed').includes('adf3230'));
  // A full 40-char sha IS caught by long-hex. Documented and accepted: the sha
  // is recoverable from the short form and from git, so losing it costs nothing,
  // whereas letting 40-hex through would let real keys pass.
  const sha = 'e66827fe76dcc0444f68c4267aaeb4ac453e00e8';
  assert.ok(!redact(sha).includes(sha));
});

test('ordinary config and prose are untouched', () => {
  const cfg = 'host=dynamic\nport=5060\ncontext=billing\nallow=opus\nqualify=yes';
  assert.strictEqual(redact(cfg), cfg);
  assert.strictEqual(redact('The transfer tool does not exist.'), 'The transfer tool does not exist.');
});

test('a URL with no credential is untouched', () => {
  const u = 'https://github.com/epicdm/isolav2.git';
  assert.strictEqual(redact(u), u);
  assert.strictEqual(redact('wss://ai-agent-dl6ldsi8.livekit.cloud'), 'wss://ai-agent-dl6ldsi8.livekit.cloud');
});

// ===========================================================================
// ROBUSTNESS — the redactor sits in the output path of real commands. If it
// throws, it takes the command's entire output with it.
// ===========================================================================

test('never throws on hostile or empty input', () => {
  assert.strictEqual(redact(null), '');
  assert.strictEqual(redact(undefined), '');
  assert.strictEqual(redact(''), '');
  assert.doesNotThrow(() => redact('ÿ '.repeat(100)));
  assert.doesNotThrow(() => redact('='.repeat(10000)));
});

test('hasSecret agrees with redact', () => {
  assert.strictEqual(hasSecret('secret=' + FAKE_SIP), true);
  assert.strictEqual(hasSecret('host=dynamic'), false);
});

// ===========================================================================
// THROUGH THE PIPE — the tests above call redact() on a whole string, which is
// NOT how the caller uses this. The streaming path split on newline and
// redacted each line independently, so a multi-line PEM block passed through
// untouched while every test above stayed green.
//
//   A UNIT TEST THAT CALLS THE FUNCTION DIFFERENTLY FROM THE CALLER TESTS A
//   DIFFERENT PROGRAM.
//
// These drive the real process over stdin/stdout.
// ===========================================================================

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const FILTER = path.join(__dirname, 'lib', 'secret-redact.js');

const pipe = (input) =>
  spawnSync(process.execPath, [FILTER], { input, encoding: 'utf8' }).stdout || '';

test('PIPE: a multi-line PEM block is redacted in streaming mode', () => {
  const body = 'MIIEowIBAAKCAQEA' + 'q'.repeat(40);
  const out = pipe(
    'preamble line\n-----BEGIN RSA PRIVATE KEY-----\n' + body + '\n' + body + '\n-----END RSA PRIVATE KEY-----\ntrailing line\n'
  );
  assert.ok(!out.includes(body), 'PEM body survived the STREAM (the exact bug this closes)');
  assert.ok(out.includes('[REDACTED:private-key]'));
  assert.ok(out.includes('preamble line') && out.includes('trailing line'), 'surrounding output must survive');
});

test('PIPE: an UNTERMINATED PEM block is never released', () => {
  const body = 'MIIEowIBAAKC' + 'z'.repeat(40);
  const out = pipe('-----BEGIN PRIVATE KEY-----\n' + body + '\n');
  assert.ok(!out.includes(body), 'a truncated key must not be emitted verbatim');
});

test('PIPE: ordinary output streams through unchanged', () => {
  const out = pipe('host=dynamic\nport=5060\ncontext=billing\n');
  assert.strictEqual(out, 'host=dynamic\nport=5060\ncontext=billing\n');
});

test('PIPE: line-by-line secrets still redact, and line count is preserved', () => {
  const out = pipe('a=1\nsecret=' + FAKE_SIP + '\nb=2\n');
  assert.ok(!out.includes(FAKE_SIP));
  assert.strictEqual(out.split('\n').length, 4); // 3 lines + trailing empty
});

// ===========================================================================
// SHAPES FOUND BY ADVERSARIAL REVIEW, not by the author. Kept as the
// reviewer's own examples.
// ===========================================================================

test('REVIEW: AWS_SECRET_ACCESS_KEY is redacted despite underscores breaking \\b', () => {
  const v = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
  const out = redact('AWS_SECRET_ACCESS_KEY=' + v);
  assert.ok(!out.includes(v), 'underscored key names were the miss');
});

test('REVIEW: a bare rtp_ token is redacted — the guard would NOT have caught our own leak', () => {
  const v = 'rtp_1234567890abcdef1234567890abcdef';
  assert.ok(!redact('token is ' + v).includes(v));
  // and still caught in the Authorization form it actually leaked in
  assert.ok(!redact('Authorization: "Bearer ' + v + '"').includes(v));
});

test('REVIEW: other vendor shapes', () => {
  for (const v of ['glpat-abcdefghijklmnopqrst', 'sk_live_abcdefghijklmnopqrstuv', 'SG.abcdefghijklmnopqrst.uvwxyzabcdefghijklmno']) {
    assert.ok(!redact('k=' + v).includes(v), v.slice(0, 6) + ' survived');
  }
});

test('REVIEW: no catastrophic backtracking on adversarial input', () => {
  const started = process.hrtime.bigint();
  redact('-----BEGIN PRIVATE KEY-----\n'.repeat(400));  // many BEGINs, no END
  redact('secret='.repeat(5000));
  redact('A'.repeat(100000));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 5000, 'redaction took ' + Math.round(ms) + 'ms — possible backtracking');
});

// ESCAPED QUOTE INSIDE A CREDENTIAL VALUE — P1 found in review of PR #147,
// 2026-09-22. The quoted-value alternatives stopped at the first `"` even when
// it was escaped, so the tail of the secret survived AND the output was invalid
// JSON: {"agentBotSecret":"abc\"TAIL"} became
// {"agentBotSecret":"[REDACTED:secret]"TAIL"}. A redactor that leaks the end of
// the value it just labelled is worse than none, because the label asserts the
// value was handled.
//
// String.raw throughout, and deliberately so. The first version of these tests
// failed against a CORRECT implementation because the escaping in the TEST was
// wrong — the fixture never contained the backslash it claimed to, and two
// layers of shell quoting ate it. Verify the harness before believing it about
// the system.
test('an escaped quote inside a JSON credential value does not leak the suffix', () => {
  const input = String.raw`{"agentBotSecret":"abc\"VISIBLE_SUFFIX"}`;
  assert.ok(input.includes('\\"'), 'FIXTURE GUARD: the input must really contain an escaped quote');
  const out = redact(input);
  assert.ok(!out.includes('VISIBLE_SUFFIX'), 'suffix leaked: ' + out);
  assert.ok(out.includes('[REDACTED:secret]'), 'value should still be labelled: ' + out);
});

test('an escaped quote in a single-quoted value does not leak the suffix', () => {
  const input = String.raw`password: 'abc\'TAIL_SQ'`;
  assert.ok(input.includes("\\'"), 'FIXTURE GUARD: the input must really contain an escaped quote');
  const out = redact(input);
  assert.ok(!out.includes('TAIL_SQ'), 'single-quoted suffix leaked: ' + out);
  assert.ok(out.includes('[REDACTED:password]'), 'value should still be labelled: ' + out);
});

test('POSITIVE CONTROL: an ordinary quoted credential is still redacted', () => {
  const out = redact(String.raw`{"agentBotSecret":"plainvalue1234"}`);
  assert.ok(!out.includes('plainvalue1234'), 'control: ordinary value leaked: ' + out);
  assert.ok(out.includes('[REDACTED:secret]'));
});
