#!/usr/bin/env node
/**
 * isola-stop-gate — Stop hook enforcing the completion discipline.
 *
 * House rule (decision-isola-business-revenue-system-and-completion-semantics-2026-07-23,
 * dec-port-autonomous-execution-packets-2026-07-19): a task is not finished
 * because the code compiles. It is finished when it has been VERIFIED and the
 * result is RECONCILED IN PORT.
 *
 * This gate fires only when code files INSIDE THE REPOSITORY were actually edited
 * in this session. Investigation, planning, review and documentation sessions are
 * never gated.
 *
 * SCOPE — repository files only (added 2026-08-13, estate lane).
 * Edits under the session scratchpad (%TEMP%/claude/...) and anywhere else outside
 * CLAUDE_PROJECT_DIR are ignored. Previously they were counted as "code edited",
 * so a session that only wrote throwaway probe scripts was told to run
 * `pnpm --filter ./artifacts/isola test` against a workspace it had never touched.
 * That fired seven times in one session and trained the operator to dismiss the
 * gate, which is worse than not having it.
 *
 * !! THE DISCIPLINE THIS DOES **NOT** COVER — read before relying on the gate. !!
 * A script DEPLOYED TO host03 (/usr/local/sbin/..., systemd units, iptables
 * guards) is authored in the scratchpad and installed over ssh. It therefore
 * trips NO gate at all — neither this one nor any test suite, because it lives
 * outside the repo and pnpm knows nothing about it. The gate cannot see your
 * most operationally dangerous changes.
 * For every host03-deployed script the rule is MANUAL and MANDATORY:
 *   1. Record a rollback copy + baseline sha256 BEFORE the change.
 *   2. Verify by the means appropriate to the artefact — syntax check, a unit
 *      check of the changed function against the INSTALLED file (not a retyped
 *      copy), a regression run proving unrelated behaviour is unchanged, and an
 *      idempotency run if anything re-applies on a timer.
 *   3. Record all of that in Port as evidence, naming the rollback path and hash.
 * Worked examples: `meta-topology-verify.sh` and `console-port-guard.sh`, both
 * evidenced under ev-estate-* entities on 2026-08-12/13.
 *
 * Escape hatches (all legitimate, all explicit):
 *   - /isola-port-closeout writes `closeout.ack` when the evidence trail is complete.
 *   - `.claude/state/sessions/<id>/gate.off` disables the gate for one session.
 *   - The gate never fires twice in a row (stop_hook_active), so it can always
 *     be satisfied by explaining what was done.
 */

'use strict';

const path = require('path');
const S = require('./lib/isola-state.js');

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Windows paths are case-insensitive and arrive with mixed separators, so compare
// on a normalised, resolved, lowercased form rather than by string prefix.
function insideProject(file) {
  if (!file) return false;
  try {
    const norm = (p) => {
      const r = path.resolve(p);
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    const rel = path.relative(norm(PROJECT_DIR), norm(file));
    // Outside when relative escapes upward or resolves to another root/drive.
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch (_) {
    return false; // unparseable path -> treat as outside, never as a false gate
  }
}

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let inp;
  try {
    inp = JSON.parse(raw || '{}');
  } catch (_) {
    process.exit(0);
  }

  try {
    // Never loop: if this gate already blocked once for this turn, let it through.
    if (inp.stop_hook_active) process.exit(0);

    const sid = inp.session_id;
    if (S.exists(sid, 'gate.off') || S.exists(sid, 'closeout.ack')) process.exit(0);

    // Repository files only. Scratchpad and host03-bound scripts are out of scope
    // here by design — see the header note on the manual discipline they require.
    const editedCode = S.uniqueLines(sid, 'edited-code.txt').filter(insideProject);
    if (editedCode.length === 0) process.exit(0); // nothing in-repo to verify

    const commands = S.lines(sid, 'commands-run.log').join('\n');
    const verified = S.VERIFY_RE.test(commands);
    const portReconciled = S.lines(sid, 'port-updates.log').length > 0;

    const missing = [];
    if (!verified) {
      missing.push(
        'TESTS/TYPECHECK — no test, vitest or typecheck run was observed this session. ' +
          'Run `pnpm --filter ./artifacts/isola run test` and/or `run typecheck`, or state explicitly why the change is untestable.'
      );
    }
    if (!portReconciled) {
      missing.push(
        'PORT RECONCILIATION — no Port entity was updated this session. Record evidence against the owning ' +
          'build_task / execution_packet, or state explicitly that this change is not packet-bearing.'
      );
    }

    if (missing.length === 0) process.exit(0);

    const files = editedCode.slice(0, 8);
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason:
          'isola-stop-gate: ' +
          editedCode.length +
          ' code file(s) were edited this session but the completion discipline is incomplete:\n\n' +
          missing.map((m, i) => i + 1 + '. ' + m).join('\n') +
          '\n\nEdited: ' +
          files.join(', ') +
          (editedCode.length > files.length ? ' (+' + (editedCode.length - files.length) + ' more)' : '') +
          '\n\nEither complete the missing step(s), or — if this genuinely does not apply (spike, scratch script, ' +
          'reverted work) — say so plainly in your reply and continue; this gate will not fire again this turn. ' +
          'Run /isola-port-closeout to record evidence properly.',
      })
    );
    process.exit(0);
  } catch (_) {
    process.exit(0); // fail open
  }
});
