#!/usr/bin/env node
/**
 * isola-post-edit — PostToolUse checks after a file edit.
 *
 * Cheap, deterministic checks run on every edit; the expensive typecheck is
 * debounced so it cannot stall a working session.
 *
 * Never blocks. Findings are returned as additionalContext so Claude sees them
 * immediately and can fix them in the same turn.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const T = require('./lib/isola-topology.js');
const S = require('./lib/isola-state.js');

const PROJECT = path.join(__dirname, '..', '..');
const DEBOUNCE_MS = 120000; // at most one typecheck every 2 minutes
const TYPECHECK_TIMEOUT_MS = 120000;

/** High-entropy / well-known credential shapes that must never be committed. */
const SECRET_LITERAL_RES = [
  { id: 'private-key-block', re: /-----BEGIN\s+((RSA|EC|OPENSSH|PGP)\s+)?PRIVATE KEY-----/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/ },
  { id: 'github-pat', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9]{32,}/ },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: 'meta-long-token', re: /\bEAA[A-Za-z0-9]{40,}/ },
  {
    id: 'inline-password-assignment',
    re: /(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'{}$\s]{12,}["']/i,
  },
];

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.on('data', (d) => (raw += d));
    process.stdin.on('end', () => resolve(raw));
  });
}

function emit(context) {
  if (!context.length) process.exit(0);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          'isola-post-edit findings (fix before declaring this task done):\n' + context.map((c) => ' - ' + c).join('\n'),
      },
    })
  );
  process.exit(0);
}

function shouldTypecheck(stateDir) {
  try {
    const stamp = path.join(stateDir, 'last-typecheck');
    if (fs.existsSync(stamp)) {
      const age = Date.now() - fs.statSync(stamp).mtimeMs;
      if (age < DEBOUNCE_MS) return false;
    }
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stamp, new Date().toISOString());
    return true;
  } catch (_) {
    return false;
  }
}

/** Find the nearest workspace package that owns this file. */
function packageFor(absPath) {
  const rel = T.normalizePath(path.relative(PROJECT, absPath));
  if (rel.startsWith('artifacts/isola/')) return '@workspace/isola';
  if (rel.startsWith('artifacts/api-server/')) return '@workspace/api-server';
  if (rel.startsWith('artifacts/mockup-sandbox/')) return '@workspace/mockup-sandbox';
  if (rel.startsWith('scripts/')) return '@workspace/scripts';
  return null;
}

/**
 * Files where a frozen-stack reference is a DOCUMENTED, gated rollback
 * affordance rather than a new dependency. brain-provider.ts:633 holds
 * CLAWITH_DISPATCH_URL behind ISOLA_LEGACY_CLAWITH_FALLBACK (unset in .replit,
 * so off) and is explicitly commented as rollback-only.
 */
const LEGACY_REFERENCE_ALLOWED = [
  /artifacts\/isola\/lib\/brain-provider\.ts$/i,
  // The guard's own policy files must be able to NAME what they forbid.
  /\.claude\/hooks\//i,
];

(async () => {
  let inp;
  try {
    inp = JSON.parse((await readStdin()) || '{}');
  } catch (_) {
    process.exit(0);
  }

  try {
    const ti = inp.tool_input || {};
    const target = ti.file_path || ti.filePath || ti.path || '';
    if (!target) process.exit(0);

    const sessionId = inp.session_id;
    const findings = [];

    if (S.isCodeFile(target)) S.append(sessionId, 'edited-code.txt', target);
    S.append(sessionId, 'edited-files.txt', target);

    let content = '';
    try {
      content = fs.readFileSync(target, 'utf8');
    } catch (_) {
      content = String(ti.content || ti.new_string || '');
    }

    // 1. Credential literals — cheap, always.
    for (const s of SECRET_LITERAL_RES) {
      if (s.re.test(content)) {
        findings.push(
          'POSSIBLE SECRET LITERAL [' + s.id + '] in ' + target +
            ' — replace with an env var reference and rotate the value if it was ever real.'
        );
        break;
      }
    }

    // 2. Frozen-stack references in application code.
    const legacyAllowed = LEGACY_REFERENCE_ALLOWED.some((re) => re.test(T.normalizePath(target)));
    if (!T.isProseFile(target) && !legacyAllowed && T.LEGACY_REFERENCE_RE.test(content)) {
      findings.push(
        'FROZEN v1.8.3 REFERENCE in ' + target +
          ' (port 8800 / runtime.epic.dm / /opt/isola-runtime). Canonical runtime is Clawith v1.11.0 — ' +
          'confirm this is a ledger/migration note, not a live dependency.'
      );
    }

    // 3. Focused typecheck, debounced.
    const pkg = packageFor(target);
    const ext = T.extname(target);
    if (pkg && (ext === '.ts' || ext === '.tsx')) {
      const stateDir = S.dirFor(sessionId);
      if (shouldTypecheck(stateDir)) {
        try {
          execSync('pnpm --filter ' + pkg + ' --if-present run typecheck', {
            cwd: PROJECT,
            timeout: TYPECHECK_TIMEOUT_MS,
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf8',
          });
          S.append(sessionId, 'commands-run.log', 'typecheck ' + pkg + ' PASS');
        } catch (err) {
          const out = String((err && (err.stdout || '')) + (err && (err.stderr || '')));
          const relTarget = T.normalizePath(path.relative(PROJECT, target));
          const base = path.basename(target);
          // Report only errors in files touched this session — the repo carries
          // pre-existing unrelated debt that must not block current work.
          const touched = new Set(S.uniqueLines(sessionId, 'edited-files.txt').map((p) => path.basename(p)));
          touched.add(base);
          const relevant = out
            .split('\n')
            .filter((l) => /error TS\d+/.test(l))
            .filter((l) => Array.from(touched).some((b) => l.includes(b)) || l.includes(relTarget))
            .slice(0, 12);
          if (relevant.length) {
            findings.push('TYPECHECK ERRORS in files edited this session:\n   ' + relevant.join('\n   '));
          }
          S.append(sessionId, 'commands-run.log', 'typecheck ' + pkg + ' FAIL');
        }
      }
    }

    emit(findings);
  } catch (_) {
    process.exit(0); // never block on an internal error
  }
})();
