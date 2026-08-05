/**
 * Regression coverage for the plugin packager.
 *
 *   node --test tools/claude-plugins/package-plugin.test.js
 *
 * `.claude/` is the source of truth and `isola-engineering/` is a build artifact
 * of it. That only holds if `--check` genuinely fails when the two diverge. A
 * drift detector that always exits 0 is worse than none: it reports "in sync"
 * over a stale plugin, so an engineer who installed the plugin keeps running the
 * OLD guard while believing they run the corrected one.
 *
 * These tests therefore assert both directions — clean tree passes, and induced
 * drift is actually caught. No network access; the packager only touches files.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const PACKAGER = path.join(HERE, 'package-plugin.js');
const HOOKS_SRC = path.join(ROOT, '.claude', 'hooks');
const HOOKS_DEST = path.join(HERE, 'isola-engineering', 'hooks');

function runCheck() {
  return spawnSync(process.execPath, [PACKAGER, '--check'], { encoding: 'utf8', timeout: 30000 });
}

test('--check reports the tree in sync', () => {
  const r = runCheck();
  assert.strictEqual(r.status, 0, 'expected in-sync exit 0, got ' + r.status + '\n' + r.stderr);
  assert.match(r.stdout, /in sync/i);
});

test('--check detects a file present in .claude/hooks but missing from the plugin', () => {
  const probe = path.join(HOOKS_SRC, '__drift-probe.js');
  try {
    fs.writeFileSync(probe, '// transient drift probe\n');
    const r = runCheck();
    assert.strictEqual(r.status, 1, 'drift must fail the check');
    assert.match(r.stderr, /OUT OF SYNC/i);
    assert.match(r.stderr, /__drift-probe\.js/);
  } finally {
    fs.rmSync(probe, { force: true });
    fs.rmSync(path.join(HOOKS_DEST, '__drift-probe.js'), { force: true });
  }
  // The tree must be clean again, or this test has damaged the repository.
  assert.strictEqual(runCheck().status, 0, 'drift probe was not fully cleaned up');
});

test('--check detects a plugin copy that has fallen behind its source', () => {
  const target = path.join(HOOKS_DEST, 'lib', 'meta-graph-policy.js');
  const original = fs.readFileSync(target);
  try {
    fs.writeFileSync(target, original + Buffer.from('\n// stale divergence\n'));
    const r = runCheck();
    assert.strictEqual(r.status, 1, 'a stale plugin copy must fail the check');
    assert.match(r.stderr, /meta-graph-policy\.js/);
  } finally {
    fs.writeFileSync(target, original);
  }
  assert.strictEqual(runCheck().status, 0, 'original content was not restored');
});

test('the packaged guard is byte-identical to the source guard', () => {
  for (const rel of [
    'isola-guard.js',
    'selftest.js',
    'meta-graph-policy.test.js',
    path.join('lib', 'meta-graph-policy.js'),
    path.join('lib', 'isola-topology.js'),
  ]) {
    assert.deepStrictEqual(
      fs.readFileSync(path.join(HOOKS_DEST, rel)),
      fs.readFileSync(path.join(HOOKS_SRC, rel)),
      rel + ' differs between .claude/hooks and the packaged plugin'
    );
  }
});

test('runtime state is never packaged', () => {
  assert.ok(!fs.existsSync(path.join(HERE, 'isola-engineering', 'state')), 'state/ must not be packaged');
  assert.ok(
    !fs.existsSync(path.join(HOOKS_DEST, 'guard.log')),
    'guard.log must not be packaged'
  );
});
