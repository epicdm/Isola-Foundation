#!/usr/bin/env node
/**
 * isola-stop-gate — Stop hook enforcing the completion discipline.
 *
 * House rule (decision-isola-business-revenue-system-and-completion-semantics-2026-07-23,
 * dec-port-autonomous-execution-packets-2026-07-19): a task is not finished
 * because the code compiles. It is finished when it has been VERIFIED and the
 * result is RECONCILED IN PORT.
 *
 * This gate fires only when code files were actually edited in this session.
 * Investigation, planning, review and documentation sessions are never gated.
 *
 * Escape hatches (all legitimate, all explicit):
 *   - /isola-port-closeout writes `closeout.ack` when the evidence trail is complete.
 *   - `.claude/state/sessions/<id>/gate.off` disables the gate for one session.
 *   - The gate never fires twice in a row (stop_hook_active), so it can always
 *     be satisfied by explaining what was done.
 */

'use strict';

const S = require('./lib/isola-state.js');

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

    const editedCode = S.uniqueLines(sid, 'edited-code.txt');
    if (editedCode.length === 0) process.exit(0); // nothing to verify

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
