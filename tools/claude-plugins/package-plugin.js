#!/usr/bin/env node
/**
 * Package the project-level Isola pack into the internal `isola-engineering` plugin.
 *
 *   node tools/claude-plugins/package-plugin.js          # sync
 *   node tools/claude-plugins/package-plugin.js --check   # verify in sync (exit 1 if not)
 *
 * `.claude/` is the single source of truth. The plugin is a build artifact of it, so the
 * two can never drift silently: --check is safe to wire into CI when CI exists.
 *
 * The plugin ships skills, agents and hooks. It deliberately does NOT ship
 * .claude/settings.json (permissions are a per-repo decision) or CLAUDE.md (project laws
 * belong to the project, not the plugin).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, '.claude');
const DEST = path.join(__dirname, 'isola-engineering');
const CHECK = process.argv.includes('--check');

/** Directories copied verbatim from .claude/ into the plugin. */
const TREES = ['skills', 'agents', 'hooks'];

/** Never package runtime state or logs. */
const SKIP = new Set(['state', 'worktrees', 'settings.local.json', 'guard.log']);

function walk(dir, base = dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
}

let changed = 0;
let checked = 0;
const drift = [];

for (const tree of TREES) {
  const srcDir = path.join(SRC, tree);
  if (!fs.existsSync(srcDir)) continue;
  for (const rel of walk(srcDir)) {
    const from = path.join(srcDir, rel);
    const to = path.join(DEST, tree, rel);
    checked++;
    const same = fs.existsSync(to) && sha(from) === sha(to);
    if (same) continue;
    if (CHECK) {
      drift.push(path.join(tree, rel));
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    changed++;
  }
}

if (CHECK) {
  if (drift.length) {
    console.error('Plugin is OUT OF SYNC with .claude/ (' + drift.length + ' file(s)):');
    for (const d of drift) console.error('  ' + d);
    console.error('\nRun: node tools/claude-plugins/package-plugin.js');
    process.exit(1);
  }
  console.log('Plugin in sync with .claude/ (' + checked + ' files checked).');
  process.exit(0);
}

console.log('Packaged isola-engineering: ' + changed + ' file(s) updated, ' + checked + ' checked.');
console.log('\nInstall locally (never publish this marketplace):');
console.log('  /plugin marketplace add ' + path.join(__dirname).replace(/\\/g, '/'));
console.log('  /plugin install isola-engineering@epic-internal');
