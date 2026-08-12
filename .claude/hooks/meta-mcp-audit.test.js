'use strict';
/**
 * Audit-sink regression suite.
 * See defect-meta-mcp-audit-persists-raw-denied-action-2026-08-11.
 *
 * At b2ecf20 the raw denied `action` reached two sinks: the persistent
 * `meta-mcp.log` line, and the denial reason written to transcript-visible
 * stderr. Both were protected only by pattern-based redaction, which by
 * construction can only remove shapes it already knows.
 *
 * These tests use a sentinel deliberately chosen NOT to match any existing
 * credential pattern, and a newline payload that would forge a second audit
 * record. Each test drives the real hook binary under a unique session id and
 * then inspects the actual session audit file on disk.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const GUARD = path.join(__dirname, 'isola-guard.js');
const S = require('./lib/isola-state.js');

// Matches none of CREDENTIAL_VALUE_RES and no credential key name. If this
// string survives anywhere, redaction is not what is protecting the sink.
const SENTINEL = 'ZZQQ-NOTATOKEN-7731-XYZ-CANARY';
// Deliberately a VALID identifier: it passes any "looks clean" test, which is
// exactly the assumption round-2 review broke. Used as a key name, a parent key
// and a tool suffix.
const SENTINEL_KEY = 'ZZQQ_NOTATOKEN_7731_XYZ_CANARY';
const FORGED = 'meta-mcp forged_tool action=list ALLOW';
// Built by codepoint so no literal separator byte sits in this source file.
const LINE_SEPARATORS = [0x85, 0x2028, 0x2029].map((c) => String.fromCodePoint(c));

let n = 0;
function runOnce(toolInput, toolName = 'mcp__meta_developer_tools__devtools_app') {
  const session = `audit-test-${process.pid}-${++n}`;
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ session_id: session, tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
    timeout: 20000,
  });
  const stderrOut = (r.stdout || '') + (r.stderr || '');
  const logPath = path.join(S.dirFor(session), 'meta-mcp.log');
  const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  return {
    verdict: r.status === 2 ? 'DENY' : 'ALLOW',
    stderrOut,
    logText,
    logLines: logText.split('\n').filter((l) => l.trim() !== ''),
  };
}

test('unknown action: sentinel appears in neither stderr nor the audit file', () => {
  const res = runOnce({ action: SENTINEL, app_id: '123' });
  assert.strictEqual(res.verdict, 'DENY');
  assert.ok(!res.stderrOut.includes(SENTINEL), 'sentinel must not reach stderr');
  assert.ok(!res.logText.includes(SENTINEL), 'sentinel must not be persisted');
  assert.match(res.logText, /action=unknown/);
  assert.match(res.logText, /DENY:meta-mcp-unknown-action/);
});

test('unknown action: audit line carries a bounded ref, not the value', () => {
  const res = runOnce({ action: SENTINEL, app_id: '123' });
  assert.match(res.logText, /ref=[0-9a-f]{8}\b/);
  assert.ok(!res.logText.includes(SENTINEL));
});

test('newline payload cannot forge a second audit record', () => {
  const res = runOnce({ action: `basic_settings\n${FORGED}`, app_id: '123' });
  assert.strictEqual(res.verdict, 'DENY');
  assert.strictEqual(res.logLines.length, 1, 'exactly one audit line per decision');
  assert.ok(!res.logText.includes('forged_tool'), 'forged record must not be persisted');
  assert.ok(!res.stderrOut.includes('forged_tool'), 'forged record must not reach stderr');
});

test('newline payload does not leak the raw action to stderr', () => {
  const res = runOnce({ action: `zzz\n${FORGED}\n${SENTINEL}`, app_id: '123' });
  assert.ok(!res.stderrOut.includes(SENTINEL));
  assert.ok(!res.stderrOut.includes('forged_tool'));
});

test('malformed (non-string) action is denied and logged as unknown', () => {
  const res = runOnce({ action: { nested: SENTINEL }, app_id: '123' });
  assert.strictEqual(res.verdict, 'DENY');
  assert.match(res.logText, /action=unknown/);
  assert.ok(!res.logText.includes(SENTINEL));
  assert.ok(!res.stderrOut.includes(SENTINEL));
});

test('omitted action is denied and logged as unknown', () => {
  const res = runOnce({ app_id: '123' });
  assert.strictEqual(res.verdict, 'DENY');
  assert.match(res.logText, /action=unknown/);
});

test('unknown TOOL is denied and logs no raw action', () => {
  const res = runOnce({ action: SENTINEL }, 'mcp__meta_developer_tools__devtools_totally_unknown');
  assert.strictEqual(res.verdict, 'DENY');
  assert.match(res.logText, /action=unknown/);
  assert.ok(!res.logText.includes(SENTINEL));
  assert.ok(!res.stderrOut.includes(SENTINEL));
});

test('unexpected key with a sentinel VALUE is denied without echoing the value', () => {
  const res = runOnce({ action: 'basic_settings', app_id: '123', surprise_key: SENTINEL });
  assert.strictEqual(res.verdict, 'DENY');
  assert.match(res.logText, /DENY:meta-mcp-unexpected-key/);
  assert.ok(!res.stderrOut.includes(SENTINEL), 'unexpected-key value must not be echoed');
  assert.ok(!res.logText.includes(SENTINEL));
});

test('a key NAME carrying a newline cannot forge a record', () => {
  const res = runOnce({ action: 'basic_settings', app_id: '123', [`k\n${FORGED}`]: 'v' });
  assert.strictEqual(res.verdict, 'DENY');
  assert.strictEqual(res.logLines.length, 1);
  assert.ok(!res.stderrOut.includes('forged_tool'));
});

test('ALLOWED action records its canonical allowlisted name', () => {
  const res = runOnce({ action: 'basic_settings', app_id: '123' });
  assert.strictEqual(res.verdict, 'ALLOW');
  assert.strictEqual(res.logLines.length, 1);
  assert.match(res.logText, /action=basic_settings/);
  assert.match(res.logText, /ALLOW/);
  assert.ok(!/ref=/.test(res.logText), 'an allowed decision needs no correlator');
});

// ---- round-2 review: a syntactically CLEAN label is still untrusted -----
// The previous version echoed any label matching ^[A-Za-z0-9_.[\]-]+$. That is
// not a safety property: this sentinel is perfectly "clean" and was reproduced
// verbatim in the denial reason. No input-derived label is echoed now.
test('sentinel as a syntactically valid unexpected KEY NAME never appears', () => {
  const res = runOnce({ action: 'basic_settings', app_id: '1', [SENTINEL_KEY]: 'v' });
  assert.strictEqual(res.verdict, 'DENY');
  assert.match(res.logText, /DENY:meta-mcp-unexpected-key/);
  assert.ok(!res.stderrOut.includes(SENTINEL_KEY), 'clean key name must not reach stderr');
  assert.ok(!res.logText.includes(SENTINEL_KEY), 'clean key name must not be persisted');
  assert.match(res.stderrOut, /ref [0-9a-f]{8}/);
});

test('sentinel as the PARENT KEY of access_token never appears', () => {
  const res = runOnce({ action: 'basic_settings', app_id: '1', [SENTINEL_KEY]: { access_token: 'zzz' } });
  assert.strictEqual(res.verdict, 'DENY');
  assert.ok(!res.stderrOut.includes(SENTINEL_KEY), 'credential-hit PATH must not reach stderr');
  assert.ok(!res.logText.includes(SENTINEL_KEY));
});

test('sentinel inside a NESTED-ACTION path never appears', () => {
  const res = runOnce({ action: 'basic_settings', app_id: '1', [SENTINEL_KEY]: { action: 'security' } });
  assert.strictEqual(res.verdict, 'DENY');
  assert.ok(!res.stderrOut.includes(SENTINEL_KEY), 'nested-action path must not reach stderr');
  assert.ok(!res.logText.includes(SENTINEL_KEY));
});

test('unknown TOOL suffix text never reaches stderr or the audit file', () => {
  const res = runOnce({ action: 'list' }, `mcp__meta_developer_tools__${SENTINEL_KEY}`);
  assert.strictEqual(res.verdict, 'DENY');
  assert.ok(!res.stderrOut.includes(SENTINEL_KEY), 'tool suffix must not reach stderr');
  assert.ok(!res.logText.includes(SENTINEL_KEY), 'tool suffix must not be persisted');
  assert.match(res.logText, /unknown-tool/);
  assert.match(res.logText, /toolref=[0-9a-f]{8}/);
});

test('Unicode line separators cannot forge a record', () => {
  for (const sep of LINE_SEPARATORS) {
    const res = runOnce({ action: `x${sep}${FORGED}`, app_id: '1' });
    assert.strictEqual(res.logLines.length, 1, `one line for separator U+${sep.codePointAt(0).toString(16)}`);
    assert.ok(!res.logText.includes('forged_tool'));
    assert.ok(!res.stderrOut.includes('forged_tool'));
  }
});

test('a clean key name is withheld even when nothing else is wrong', () => {
  const res = runOnce({ action: 'basic_settings', app_id: '1', harmless_looking_key: 'v' });
  assert.strictEqual(res.verdict, 'DENY');
  assert.ok(!res.stderrOut.includes('harmless_looking_key'));
});

test('every audit line is exactly one line, across a mixed sequence', () => {
  for (const input of [
    { action: 'basic_settings', app_id: '1' },
    { action: SENTINEL, app_id: '1' },
    { action: `x\n${FORGED}`, app_id: '1' },
  ]) {
    const res = runOnce(input);
    assert.strictEqual(res.logLines.length, 1, `one line for ${JSON.stringify(input).slice(0, 40)}`);
  }
});
