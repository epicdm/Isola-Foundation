#!/usr/bin/env node
/**
 * Tests for secret-store-project.
 *
 * The invariant under test is NOT "it hides things that look like secrets" —
 * that is a redactor, and a redactor is what failed on 2026-09-22 when a
 * camelCase short value did not match any credential shape. The invariant is
 * "it never emits a key it was not told to emit", which holds for fields that
 * do not exist yet.
 *
 * Every negative assertion below has a positive control in the same run: a test
 * that proves the projector CAN emit, so "the secret was absent" can never pass
 * because the projector emitted nothing at all (CLAUDE.md §2.19).
 */

'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const M = require('./lib/secret-store-project.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed += 1;
    console.log('  FAIL  ' + name);
    console.log('          ' + (err && err.message));
  }
}

console.log('\nsecret-store-project\n');

// The real shape that leaked, reduced: ordinary-looking config carrying inline
// credentials under camelCase names a shape-matcher did not recognise.
const STORE = JSON.stringify({
  bindings: [
    {
      name: 'epic-frontdesk-6737',
      agentId: '48f327a1-0000-4000-8000-000000000001',
      tenantId: 'epic',
      chatwootInboxId: 8,
      chatwootAccountId: 3,
      // Deliberately NOT credential-shaped. These are tripwires: the tests
      // assert they never appear in the output. A fixture that looked like a
      // real secret would train the scanner and the reader to ignore both.
      agentBotSecret: 'FIXTURE-TRIPWIRE-SECRET-MUST-NOT-APPEAR',
      agentBotAccessToken: 'FIXTURE-TRIPWIRE-TOKEN-MUST-NOT-APPEAR',
      status: 'active',
    },
  ],
});

test('POSITIVE CONTROL: it emits the operational fields (so absence tests below mean something)', () => {
  const r = M.project(STORE, {});
  assert.strictEqual(r.ok, true, 'projection should succeed');
  assert.ok(r.output.includes('48f327a1-0000-4000-8000-000000000001'), 'agentId must be printed');
  assert.ok(r.output.includes('epic-frontdesk-6737'), 'name must be printed');
  assert.ok(r.output.includes('"chatwootInboxId": 8'), 'inbox id must be printed');
});

test('the inline credential VALUES are absent', () => {
  const r = M.project(STORE, {});
  assert.ok(!r.output.includes('FIXTURE-TRIPWIRE-SECRET-MUST-NOT-APPEAR'), 'agentBotSecret value leaked');
  assert.ok(!r.output.includes('FIXTURE-TRIPWIRE-TOKEN-MUST-NOT-APPEAR'), 'agentBotAccessToken value leaked');
});

test('the credential key NAMES are still reported (names and presence are readable)', () => {
  const r = M.project(STORE, {});
  assert.ok(r.output.includes('agentBotSecret'), 'the NAME should be listed as omitted');
  assert.ok(r.output.includes('__omitted_keys'), 'omitted keys must be reported, not silently dropped');
});

test('THE INVARIANT: a key nobody has seen before is dropped, not matched by shape', () => {
  const future = JSON.stringify([{ name: 'x', somethingInventedTomorrow: 'zzz-live-value' }]);
  const r = M.project(future, {});
  assert.ok(!r.output.includes('zzz-live-value'), 'an unknown key was emitted');
  assert.ok(r.output.includes('somethingInventedTomorrow'), 'its name should still be reported');
});

test('--allow widens the projection for an ordinary field', () => {
  const doc = JSON.stringify([{ name: 'x', region: 'dm-rsu' }]);
  const before = M.project(doc, {});
  assert.ok(!before.output.includes('dm-rsu'), 'control: region is not projected by default');
  const after = M.project(doc, { allow: ['region'] });
  assert.ok(after.output.includes('dm-rsu'), '--allow region should project it');
});

test('--allow CANNOT be used to widen to a credential, and says so', () => {
  const r = M.project(STORE, { allow: ['agentBotSecret', 'agentBotAccessToken'] });
  assert.ok(!r.output.includes('FIXTURE-TRIPWIRE-SECRET-MUST-NOT-APPEAR'), '--allow defeated the control');
  assert.ok(r.output.includes('__refused_allow_flags'), 'a refused flag must be reported');
  assert.ok(r.output.includes('agentBotSecret'), 'the refused key should be named');
});

test('a nested object is not recursed into (that is where an unreviewed field would sit)', () => {
  const doc = JSON.stringify([{ name: 'x', status: { inner: 'nested-live-value' } }]);
  const r = M.project(doc, {});
  assert.ok(!r.output.includes('nested-live-value'), 'recursed into a nested value');
  assert.ok(r.output.includes('<object:1 keys>'), 'should report the shape instead');
});

test('non-JSON input emits NOTHING and does not echo what it failed to parse', () => {
  // A raw-token store: the whole file IS the secret, so there is no projection
  // of it. The marker is deliberately not credential-SHAPED — the assertion is
  // that nothing of the input comes back, which must hold whether or not the
  // content looks like a key.
  const r = M.project('not-json-just-one-opaque-store-body-marker', {});
  assert.strictEqual(r.ok, false, 'should refuse');
  assert.strictEqual(r.output, '', 'must emit no output');
  assert.ok(!r.error.includes('opaque-store-body-marker'), 'the error echoed the input');
});

test('a bare object (not wrapped in bindings) still projects', () => {
  const r = M.project(JSON.stringify({ name: 'solo', agentId: 'a-1' }), {});
  assert.ok(r.output.includes('solo') && r.output.includes('a-1'));
});

test('isForbiddenKey catches the families, case-insensitively', () => {
  for (const k of ['agentBotSecret', 'ACCESS_TOKEN', 'apiKey', 'Password', 'privateKey', 'authHeader']) {
    assert.strictEqual(M.isForbiddenKey(k), true, k + ' should be forbidden');
  }
  for (const k of ['agentId', 'tenantId', 'status', 'name']) {
    assert.strictEqual(M.isForbiddenKey(k), false, k + ' should be allowed');
  }
});

test('INTEGRATION: the real CLI, run as the guard tells you to run it', () => {
  const cli = path.join(__dirname, 'lib', 'secret-store-project.js');
  const out = execFileSync(process.execPath, [cli], { input: STORE, encoding: 'utf8' });
  assert.ok(out.includes('48f327a1-0000-4000-8000-000000000001'), 'CLI must print agentId');
  assert.ok(!out.includes('FIXTURE-TRIPWIRE-SECRET-MUST-NOT-APPEAR'), 'CLI leaked the secret');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
