#!/usr/bin/env node
/**
 * isola-guard — PreToolUse enforcement for the Isola engineering environment.
 *
 * Protocol (Claude Code 2.1.x):
 *   stdin  : {session_id, cwd, hook_event_name, tool_name, tool_input, ...}
 *   exit 2 : BLOCK. stderr is shown to Claude as the reason.
 *   exit 0 + JSON stdout {hookSpecificOutput:{permissionDecision:"ask"|"allow"}} : soft gate.
 *   exit 0 : allow.
 *
 * FAIL-OPEN: any internal error allows the call. A bug in the guard must never
 * halt legitimate engineering work.
 *
 * DESIGN RULE — tool-aware, not payload-blind:
 *   Destructive-shape rules run ONLY against execution and write payloads.
 *   Tools that merely DESCRIBE work (TaskUpdate, ScheduleWakeup, Port upserts,
 *   Artifact, Agent prompts) are never scanned. The incumbent global hook scans
 *   every serialized payload and has produced real false positives: a task
 *   update was blocked for containing the words of a container teardown, and a
 *   documentation write was blocked for quoting a process-manager command.
 *   Describing an operation is not performing it.
 *
 * Read-only investigation (Read/Grep/Glob/ssh-read/ssh-search) is never blocked
 * except when the target is a secret-bearing file.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const T = require('./lib/isola-topology.js');
const S = require('./lib/isola-state.js');
const M = require('./lib/meta-graph-policy.js');

const STATE_DIR = path.join(__dirname, '..', 'state');
const LOG = path.join(STATE_DIR, 'guard.log');

let SESSION_ID = 'unknown';

function ensureState() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch (_) {
    /* ignore */
  }
}

function log(line) {
  try {
    ensureState();
    fs.appendFileSync(LOG, new Date().toISOString() + ' ' + line + '\n');
  } catch (_) {
    /* never fail on logging */
  }
}

/**
 * Session ledger writes are redacted too. The transcript is not the only place a
 * credential can land: `.claude/state/sessions/<id>/commands-run.log` persists to
 * disk and outlives the session. Adversarial review 2026-08-05 found a literal
 * token reaching that file via the unconditional command record below.
 */
function record(file, line) {
  S.append(SESSION_ID, file, M.redactSensitive(line));
}

/**
 * Everything written here lands in the transcript, so it is redacted first. A
 * deny reason often quotes the offending command, and the whole point of the
 * credential rules is that a credential must never be echoed — including by the
 * guard that just refused it.
 */
function deny(ruleId, reason, remedy) {
  log('DENY rule=' + ruleId);
  process.stderr.write(
    M.redactSensitive(
      'BLOCKED by isola-guard [' + ruleId + ']\n' +
        reason +
        '\n\nDo this instead: ' +
        remedy +
        '\n(policy: .claude/hooks/isola-guard.js — see /isola-production-safety)\n'
    )
  );
  process.exit(2);
}

function ask(ruleId, reason) {
  log('ASK rule=' + ruleId);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: '[' + ruleId + '] ' + reason,
      },
    })
  );
  process.exit(0);
}

function allow(note) {
  if (note) log('ALLOW ' + note);
  process.exit(0);
}

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let inp;
  try {
    inp = JSON.parse(raw || '{}');
  } catch (_) {
    log('PARSE-ERROR allow');
    process.exit(0);
  }

  try {
    evaluate(inp);
  } catch (e) {
    log('INTERNAL-ERROR allow: ' + (e && e.message));
    process.exit(0); // fail open
  }
});

function evaluate(inp) {
  const tool = inp.tool_name || '?';
  const ti = inp.tool_input || {};
  const cls = T.classifyTool(tool);
  SESSION_ID = inp.session_id || 'unknown';

  // -------------------------------------------------------- easypanel-block
  // Allowlist policy, checked before ANY tool-class branch, and strict at
  // the TOOL NAME itself — not just the procedure argument. epic-portal
  // (EasyPanel MCP) remains Isola's normal AI-to-system control plane for
  // this connector; this is a temporary narrowing while individual
  // procedures get reviewed, not a move away from MCP. Exactly two exact
  // tool names are ever considered: search_procedures (schema/metadata
  // discovery only, always allowed — it never executes a procedure) and
  // execute_query (gated by a five-procedure allowlist). Every other
  // mcp__epic-portal__* tool name — execute_mutation, execute_destructive,
  // or anything unexpected/suffixed this policy has never seen — is blocked
  // outright with no procedure-name parsing attempted, until it receives
  // its own input/output/secret-handling review and is added here by exact
  // name. Raw HTTP/RPC/tRPC bypass of this MCP tool is blocked outright,
  // host-agnostic — it is not an alternative route, it is prohibited (tested
  // defense-in-depth against known clients, not a claim every bypass is
  // impossible). See lib/isola-topology.js for the full policy and
  // defect-easypanel-listprojectsandservices-second-secret-dump-2026-08-10.
  //
  // FAIL-CLOSED EXCEPTION: the module-level policy is fail-open on internal
  // error (a guard bug must never halt legitimate work). That is deliberately
  // inverted only here: an epic-portal-shaped call whose payload cannot be
  // safely inspected must be denied, not allowed through. Calls that are not
  // epic-portal-shaped re-throw immediately, preserving fail-open for every
  // other tool via the outer stdin-handler catch.
  {
    const cmdForCheck = String(ti.command || ti.script || '');
    const looksLikeEasyPanelCall =
      T.EASYPANEL_ANY_TOOL_RE.test(tool) ||
      (T.HTTP_INVOCATION_RE.test(cmdForCheck) && T.EASYPANEL_RAW_PATH_RE.test(cmdForCheck));
    let blocked = false;
    let unparseable = false;
    try {
      blocked = T.isBlockedEasyPanelCall(tool, ti, cmdForCheck);
    } catch (e) {
      if (!looksLikeEasyPanelCall) throw e; // preserve fail-open for unrelated tools
      log('EASYPANEL-INSPECT-ERROR fail-closed: ' + (e && e.message));
      unparseable = true;
    }
    if (blocked || unparseable) {
      deny(
        'easypanel-not-allowlisted',
        'epic-portal (EasyPanel MCP) remains the normal AI-to-system control plane, but is currently ' +
          'allowlist-gated: execute_query is permitted only for ' +
          Array.from(T.EASYPANEL_ALLOWED_QUERY_PROCEDURES).join(', ') + '. ' +
          'Mutation/destructive procedures are blocked TEMPORARILY, not outlawed — each one is added here ' +
          'individually once it has its own input/output/secret-handling review. Raw HTTP/RPC/tRPC calls that ' +
          'bypass this MCP tool remain prohibited regardless of host. ' +
          'listProjectsAndServices in particular returns full plaintext secrets for every service ' +
          'on the instance with no redaction — reclassified P0 twice this session (see ' +
          'defect-easypanel-listprojectsandservices-second-secret-dump-2026-08-10).' +
          (unparseable
            ? ' This specific payload could not be safely inspected (malformed or too deeply nested) — ' +
              'failing closed for an epic-portal-shaped call rather than allowing an unverifiable one through.'
            : ''),
        'use one of the five allowlisted read-only procedures through this MCP tool. If a write is genuinely ' +
          'needed, get the specific procedure reviewed and added to the allowlist first — do not bypass MCP.'
      );
    }
  }

  // ---------------------------------------------------------------- other
  // Text-only / orchestration tools are never inspected for command shapes.
  if (cls === 'other') {
    // Port reconciliation is part of the completion discipline — note it so the
    // Stop gate can tell a reconciled session from an unreconciled one.
    if (/^mcp__.*Port_IO__(upsert_entity|run_action|trigger_run)$/.test(tool)) {
      const bp = ti.blueprintIdentifier || '?';
      const id = (ti.entity && ti.entity.identifier) || '?';
      record('port-updates.log', tool + ' ' + bp + ' ' + id);
    }
    allow('other tool=' + tool);
  }

  // ---------------------------------------------------------------- read
  if (cls === 'read') {
    const target = ti.file_path || ti.filePath || ti.path || ti.pattern || '';
    if (T.isSecretFile(target)) {
      deny(
        'secret-read',
        'Reading secret-bearing file: ' + target + '\nSecret VALUES must never enter the transcript.',
        'list the variable NAMES only (e.g. `grep -o "^[A-Z_]*=" <file>`), read the matching *.example file, ' +
          'or ask the owner for the value out-of-band.'
      );
    }
    allow('read tool=' + tool);
  }

  // ---------------------------------------------------------------- write
  if (cls === 'write') {
    const target = ti.file_path || ti.filePath || ti.path || '';
    const host = ti.host ? String(ti.host) : '';
    const content = String(ti.content || ti.new_string || ti.chunk || '');
    const remote = !!host;

    if (T.isSecretFile(target)) {
      deny(
        'secret-write',
        'Writing to a secret-bearing file: ' + target,
        'change secrets through the owner-operated secret store (Replit Secrets panel / host .env edited by the owner), ' +
          'never from an agent session. Update the *.example file instead to document a new variable NAME.'
      );
    }

    const live = T.matchLiveCheckout(target);
    if (live && !T.isSafeBuildLocation(target)) {
      deny(
        'live-checkout-write',
        'Writing into canonical LIVE checkout ' + live + (remote ? ' on host ' + host : '') + ':\n  ' + target +
          '\nThis directory is what a running production process serves.',
        'work in an isolated `git worktree` (or /home/epicdm/scratch/), commit there, and land the change through ' +
          'a reviewed PR + the deploy gate (/isola-deploy-readiness). Emergency containment requires explicit owner authorization.'
      );
    }

    if (/\/(\.next|node_modules|dist|build)\//i.test(T.normalizePath(target))) {
      deny(
        'build-output-write',
        'Writing into generated build output: ' + target,
        'edit the source file and rebuild in an isolated location. Hand-editing build output desynchronizes it from source ' +
          '(this is the R5A contamination class).'
      );
    }

    if (content && !T.isProseFile(target) && T.LEGACY_REFERENCE_RE.test(content)) {
      ask(
        'legacy-v183-reference',
        'This change introduces a reference to the FROZEN v1.8.3 stack (port 8800 / runtime.epic.dm / /opt/isola-runtime) ' +
          'into non-prose file ' + target + '. Per decision-clawith-v183-migrate-or-retire-2026-07-24 the canonical runtime is ' +
          'Clawith v1.11.0. Confirm this is a documented migration/ledger reference, not a new code dependency.'
      );
    }

    record('edited-files.txt', target);
    allow('write tool=' + tool);
  }

  // ---------------------------------------------------------------- exec
  const cmd = String(ti.command || ti.script || '');
  const host = ti.host ? String(ti.host) : '';
  const remote = !!host || tool === 'mcp__ssh-deepseek__remote-ssh';
  if (!cmd) allow('exec tool=' + tool + ' (no command)');

  // 1. Secrets must not be printed.
  if (T.SECRET_DUMP_RE.test(cmd)) {
    deny(
      'secret-dump',
      'This command would print secret values into the transcript.',
      'report variable NAMES and a 4-character prefix only, e.g. ' +
        '`grep -o "^[A-Z_][A-Z0-9_]*=" .env` or `cut -c1-4`. Never echo a full secret.'
    );
  }

  // 2. Destructive shapes (execution only).
  for (const rule of T.DESTRUCTIVE_RULES) {
    if (rule.re.test(cmd)) {
      deny(
        rule.id,
        rule.why,
        'if this is genuinely required, get explicit owner authorization first, capture a verified backup/rollback point, ' +
          'and record the authorization in Port before re-attempting.'
      );
    }
  }

  // 3. THE R5A RULE — no builds inside a canonical live checkout.
  if (T.BUILD_COMMAND_RE.test(cmd)) {
    const live = T.matchLiveCheckout(cmd);
    if (live && !T.isSafeBuildLocation(cmd)) {
      deny(
        'build-in-live-checkout',
        'Build/install command targeting canonical LIVE checkout ' + live + '.\n' +
          'Precedent: xp-clawith-r5a-provisioning-and-tenant-disposition — a production build run in /opt/bff-v2 overwrote the ' +
          'live .next output in place, changed BUILD_ID and traced candidate files into live route manifests.',
        'create an isolated copy first:\n' +
          '  git -C ' + live + ' worktree add /home/epicdm/worktrees/<branch> <branch>\n' +
          'build there, or build in CI. Never build in the directory a live process serves.'
      );
    }
    if (remote && !live) {
      record('commands-run.log', 'BUILD(remote) ' + cmd.slice(0, 200));
    }
  }

  // 4. Service lifecycle on a live host — deploy gate.
  if (remote && T.RESTART_COMMAND_RE.test(cmd)) {
    ask(
      'service-lifecycle',
      'This restarts/reloads a live service on ' + (host || 'the remote host') + '. Confirm the deploy-gate preconditions ' +
        '(build succeeded in an isolated location, rollback identified, owner authorized). See /isola-deploy-readiness.'
    );
  }

  // 5. Meta Graph — default-deny, with a named metadata-read allowlist.
  //
  //    The previous rule treated any curl data flag as proof of mutation. That
  //    blocked `-G --data-urlencode` (a GET, and the SAFER way to pass
  //    parameters) while permitting credential-minting GETs such as
  //    /oauth/access_token, which return a live token into the transcript.
  //    Method classification, endpoint allowlisting and credential-source
  //    validation are now separate, tested concerns in lib/meta-graph-policy.js.
  if (M.isMetaGraphCommand(cmd)) {
    const verdict = M.evaluateMetaGraph(cmd);
    if (verdict.decision === 'deny') {
      deny(verdict.ruleId, verdict.reason, verdict.remedy);
    }
    record('commands-run.log', 'META-GRAPH-READ ' + verdict.method + ' ' + M.redactSensitive(cmd).slice(0, 200));
  }

  // 6. Protected production numbers + a mutating verb.
  const mutating = /\b(POST|PUT|DELETE|PATCH|update|insert|set|assign|unassign|register|deregister)\b/i.test(cmd);
  if (mutating) {
    for (const n of T.PROTECTED_NUMBERS) {
      if (cmd.includes(n.number)) {
        ask(
          'protected-number-mutation',
          'This command mutates configuration referencing ' + n.label + '. Confirm owner authorization and that exactly one ' +
            'authoritative processor remains for this number.'
        );
      }
    }
  }

  // 7. Direct production DB mutation.
  if (/\bpsql\b|\bprisma\s+db\s+execute\b/i.test(cmd) && /\b(insert|update|delete|alter|create)\b/i.test(cmd)) {
    ask(
      'direct-db-mutation',
      'Direct SQL mutation detected. House rule: change through the validated application/API layer. Raw SQL is reserved for ' +
        'explicitly authorized, reviewed, one-time remediation with a backup in place.'
    );
  }

  record('commands-run.log', (remote ? 'REMOTE ' : 'LOCAL ') + cmd.slice(0, 300));
  allow('exec tool=' + tool);
}
