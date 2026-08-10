/**
 * Per-session ledger shared by the Isola hooks.
 *
 * The Stop gate needs to know what actually happened this session:
 * which code files were edited, whether verification was run, and whether Port
 * was reconciled. Hooks are stateless processes, so that record lives on disk.
 *
 * Everything here is best-effort: a failure to record must never block work.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Same override as isola-guard.js's STATE_DIR — the self-test suite points
// this at a disposable mkdtemp directory; default (unset) is unchanged.
const ROOT = process.env.ISOLA_GUARD_STATE_DIR
  ? path.join(process.env.ISOLA_GUARD_STATE_DIR, 'sessions')
  : path.join(__dirname, '..', '..', 'state', 'sessions');

function dirFor(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-z0-9_-]/gi, '');
  return path.join(ROOT, safe || 'unknown');
}

function append(sessionId, file, line) {
  try {
    const d = dirFor(sessionId);
    fs.mkdirSync(d, { recursive: true });
    fs.appendFileSync(path.join(d, file), line + '\n');
  } catch (_) {
    /* best effort */
  }
}

function read(sessionId, file) {
  try {
    return fs.readFileSync(path.join(dirFor(sessionId), file), 'utf8');
  } catch (_) {
    return '';
  }
}

function lines(sessionId, file) {
  return read(sessionId, file)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function uniqueLines(sessionId, file) {
  return Array.from(new Set(lines(sessionId, file)));
}

function touch(sessionId, file) {
  append(sessionId, file, new Date().toISOString());
}

function exists(sessionId, file) {
  try {
    return fs.existsSync(path.join(dirFor(sessionId), file));
  } catch (_) {
    return false;
  }
}

/** Files whose edits require verification before a session may be declared done. */
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.sql', '.prisma', '.sh']);

function isCodeFile(p) {
  const m = /\.[a-z0-9]+$/i.exec(String(p).replace(/\\/g, '/'));
  return m ? CODE_EXT.has(m[0].toLowerCase()) : false;
}

/**
 * Commands that count as real verification. Deliberately covers the filtered
 * pnpm forms this repo actually uses (`pnpm --filter @workspace/isola test`),
 * the node test runner (`--test`), and the hook self-test — a narrower pattern
 * would fail to recognize verification that genuinely happened.
 */
const VERIFY_RE =
  /(vitest|jest|playwright|\btsc\b|typecheck|selftest\.js|\s--test\b|\b(pnpm|npm|yarn)\b[^\n]*\btest\b|next\s+lint|eslint)/i;

module.exports = { dirFor, append, read, lines, uniqueLines, touch, exists, isCodeFile, VERIFY_RE, CODE_EXT };
