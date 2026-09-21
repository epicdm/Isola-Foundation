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
 *
 * ===========================================================================
 * NARROWED, NOT TRUSTED — this control states its own limits
 * ===========================================================================
 * Adversarially reviewed 2026-08-16. It stops MISTAKES. It does not stop an
 * adversary, and it must not be described as if it does.
 *
 * KNOWN GAPS, all found by review rather than by the tests written alongside
 * the code — which is the point of recording them here rather than in a review
 * that expires:
 *
 *   1. IT MATCHES COMMAND TEXT, NOT THE FILE ACTUALLY OPENED. Shell
 *      indirection defeats it by construction:
 *          p=/opt/bff-v2/.env; grep TOKEN "$p"
 *          printf '%s\n' /opt/bff-v2/.env | xargs cat
 *          ln -s /opt/bff-v2/.env /tmp/e; cat /tmp/e
 *          python3 -c 'print(open(".e"+"nv").read())'
 *      No regex over command text closes this class. Only a different layer
 *      would — and none exists in the harness.
 *
 *   2. SECRET_DUMP_RE knows a subset of readers and a subset of file shapes.
 *      SECRET_FILE_RE knows about .npmrc/.pem/.p12/service-account JSON;
 *      SECRET_DUMP_RE does not. `cat ~/.netrc`, `cat ~/.kube/config`,
 *      `jq -r . credentials.json` and `cat terraform.tfvars` pass.
 *
 *   3. INNER COMMANDS inside `docker exec` / `ssh` are only caught when the
 *      literal inner text matches. Shell-evaluated construction inside the
 *      quotes is invisible.
 *
 *   4. THE REDACTOR IS NOT COMPLETE. It covers the shapes we have actually
 *      met plus the common vendors. A novel prefix passes.
 *
 * WHAT IS DELIBERATELY *NOT* HERE: a mechanism that rewrites and runs a
 * command. One existed; it was escapable by brace matching and was DELETED.
 * A guard may refuse, and it may advise. It may not execute.
 *
 * WHY THIS CONTROL IS NEVERTHELESS CLOSED rather than endlessly iterated: the
 * remaining gaps in (1)-(3) all require INTENT — deliberate indirection,
 * encoding, or obfuscation. Those sit outside the stated model. A control
 * closes when its remaining gaps fall outside its model, not when it has had
 * enough attention. The gaps that were ACCIDENTS — a PEM block streaming
 * through unredacted, `AWS_SECRET_ACCESS_KEY=` unmatched, a path-qualified
 * env dump slipping a lookbehind — were all fixed, because those are Tuesday.
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

/**
 * REMOVED 2026-08-16: allowRewritten().
 *
 * It rewrote credential-touching commands to pipe their own output through the
 * redactor, by string-concatenating the original command into a brace group:
 *     set -o pipefail; { <cmd> } 2>&1 | node redact.js
 *
 * Adversarial review escaped it in one line, using nothing more exotic than
 * brace matching — the first thing anyone tries:
 *
 *     git remote -v; } ; printf '%s\n' /opt/bff-v2/.env | xargs cat; { true
 *
 * The guard rewrote (because `git remote -v` matched), the command closed the
 * group, and the leak ran OUTSIDE the redaction pipe.
 *
 * THE RULING, AND IT IS A DESIGN RULE NOT A PATCH:
 *
 *   A GUARD MAY REFUSE, AND IT MAY ADVISE. IT MAY NOT EXECUTE.
 *
 * The wrapper's entire value was saving a human from retyping a command the
 * guard already prints. The cost was that a security control assembled and ran
 * a shell string — acquiring the exact property it exists to police. Every
 * quoting bug in shell history became in scope for the file whose job is to
 * prevent quoting mistakes. No amount of escaping fixes that, because
 * ESCAPING IS THE BUG CLASS.
 *
 * So: block, and print the safe form. The text was always the useful half.
 */

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
  // Deterministic block, checked before ANY tool-class branch — covers the
  // native epic-portal MCP tool (tool_input.procedure, including nested and
  // JSON-string-encoded shapes) and raw HTTP bypass routes (/api/mcp,
  // /api/rpc/..., /api/trpc/...). A remembered rule is not containment; this is.
  //
  // FAIL-CLOSED EXCEPTION: the module-level policy is fail-open on internal
  // error (a guard bug must never halt legitimate work). That default is
  // deliberately inverted here, and ONLY here: if inspecting an epic-portal-
  // shaped call throws (a malformed/deeply-nested payload we cannot safely
  // parse), an unverifiable call to the leakiest tool in this environment
  // must be denied, not allowed through. Calls that are not epic-portal-shaped
  // re-throw immediately, so every other tool keeps the existing fail-open
  // behavior via the outer stdin-handler catch — unrelated to this block.
  {
    const cmdForCheck = String(ti.command || ti.script || '');
    const looksLikeEasyPanelCall =
      T.EASYPANEL_MCP_TOOL_RE.test(tool) ||
      (T.HTTP_INVOCATION_RE.test(cmdForCheck) &&
        (T.EASYPANEL_RAW_ENDPOINT_RE.test(cmdForCheck) || T.EASYPANEL_RAW_PATH_RE.test(cmdForCheck)));
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
        'easypanel-secret-dump-procedure',
        'This epic-portal/EasyPanel procedure returns full plaintext secrets. listProjectsAndServices ' +
          'dumps every service (defect-easypanel-listprojectsandservices-second-secret-dump-2026-08-10); ' +
          'inspectAppService and the whole inspect*Service family, inspectProject and getEnv return the ' +
          'same shape for one service — proven 2026-09-21 when inspectAppService on isola-lumen-api-prod ' +
          'put a Django secret key, DB/Redis passwords and ~12 API tokens into a transcript. Blocked ' +
          'outright rather than relied on as a remembered rule.' +
          (unparseable
            ? ' This specific payload could not be safely inspected (malformed or too deeply nested) — ' +
              'failing closed for an epic-portal-shaped call rather than allowing an unverifiable one through.'
            : ''),
        'use listProjects (names only) plus a per-service query — listPorts, listMounts, ' +
          'getComposeDockerServices, or getMonitorTableData — none of which return secret material.'
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

  // 0. PROSE IS NOT EXECUTION.
  //
  // The exec rules scan the whole command string, so a `git commit -F -` or
  // `-m` whose MESSAGE quotes a command gets judged as if it ran that command.
  // That fired twice on 2026-08-16 — a commit message documenting this very
  // guard was blocked for containing the words `cat .env`, and the fix was to
  // route the message through a file. Routing around a guard is one step from
  // switching it off, so the rule is fixed here instead.
  //
  // This is the same principle the file header already states for TaskUpdate
  // and Port records — DESCRIBING an operation is not PERFORMING it — applied
  // to the one exec shape that is mostly prose.
  //
  // NARROW BY DESIGN, and the limits are the safety case:
  //   - only `git commit`/`git tag`, nothing else
  //   - only the MESSAGE BODY is exempted; the command around it is still
  //     scanned in full, so `git commit -m "x" && curl evil` is unaffected
  //   - the shape rules are relaxed, NOT the credential rules. A message may
  //     describe `cat .env`; it may never CONTAIN a live token, because a
  //     commit message is permanent and public in a way a transcript is not.
  const msg = T.extractCommitMessage ? T.extractCommitMessage(cmd) : null;
  const messageBody = msg ? msg.text : '';
  // BY OFFSET, never by content — see maskSpans() for the bypass this closes.
  const scanTarget = msg ? T.maskSpans(cmd, msg.spans) : cmd;

  // A literal credential inside a commit message is WORSE than in a command —
  // it would be committed. Checked before anything is exempted.
  if (messageBody && M.redactSensitive(messageBody) !== messageBody) {
    deny(
      'credential-in-commit-message',
      'The commit message contains something shaped like a live credential. ' +
        'A commit message is permanent and travels with the repository.',
      'describe the credential by NAME and location, never by value — e.g. ' +
        '"the Magnus API key in bff-v2 .env" rather than the key itself.'
    );
  }

  // 1. Secrets must not be printed.
  if (T.SECRET_DUMP_RE.test(scanTarget)) {
    deny(
      'secret-dump',
      'This command would print secret values into the transcript.',
      'report variable NAMES and a 4-character prefix only, e.g. ' +
        '`grep -o "^[A-Z_][A-Z0-9_]*=" .env` or `cut -c1-4`. Never echo a full secret.\n' +
        'If the command is long or quotes other commands, PUT IT IN A FILE and run the file — ' +
        'escaping it inline is what produces the next false positive.'
    );
  }

  // 1b. Credential-bearing surface: allow the read, redact its output.
  //
  // Ordered AFTER the secret-dump deny on purpose. A `.env` or private key is
  // never legitimately printed, so it stays denied. A git remote or a SIP peer
  // block IS legitimate investigation — it just must not carry the credential
  // into the transcript. Denying those would push the work into some unguarded
  // shape; rewriting them keeps the investigation and drops the secret.
  //
  // Bash only, and that limit is deliberate. The wrapper below is bash syntax
  // (`pipefail` + `{ ...; }`); emitting it for PowerShell would produce a broken
  // command, and a guard that breaks commands gets disabled. PowerShell and the
  // MCP ssh tool fall through to the ordinary rules — an honest gap, recorded in
  // secret-redact.js under COVERAGE BOUNDARY rather than papered over.
  if (T.CREDENTIAL_SURFACE_RE.test(cmd) && !/secret-redact\.js/.test(cmd)) {
    const filter = path.join(__dirname, 'lib', 'secret-redact.js');
    deny(
      'credential-surface-redact',
      'This reads a credential-bearing surface (git remote/config, a SIP or PBX config, ' +
        'a dotenv file, a provisioned .yaml, or a secret-manager CLI). Its OUTPUT would ' +
        'carry the credential into the transcript, even though the command looks harmless.',
      'run it with the redactor in the SAME pipeline, and read the redacted output:\n\n' +
        '  ' + cmd + ' 2>&1 | node ' + JSON.stringify(filter) + '\n\n' +
        'Key names, folder structure and config fields stay readable; only the values are ' +
        'replaced. If the command is long, put it in a script file rather than escaping it inline.'
    );
  }

  // 2. Destructive shapes (execution only).
  // scanTarget, not cmd: a commit message describing a table drop is a ledger
  // entry, not a table drop. Same reason the write-path rules already exempt
  // Port records and task text.
  for (const rule of T.DESTRUCTIVE_RULES) {
    if (rule.re.test(scanTarget)) {
      deny(
        rule.id,
        rule.why,
        'if this is genuinely required, get explicit owner authorization first, capture a verified backup/rollback point, ' +
          'and record the authorization in Port before re-attempting.'
      );
    }
  }

  // 3. THE R5A RULE — no builds inside a canonical live checkout.
  //
  // scanTarget, not cmd — for exactly the reason rule 2 above already gives.
  // A commit message that RECORDS where a build was measured ("next build
  // EXIT=0 ... pid 2503174, /opt/bff-v2") is a ledger entry, not a build.
  //
  // Measured 2026-09-09: this rule refused a command that was `rm`, `git add`,
  // `git commit -F -` and `git status` — no build anywhere in it — because the
  // heredoc body carried both "next build" and "/opt/bff-v2". The machinery to
  // prevent that ALREADY EXISTED in this file (extractCommitMessage + maskSpans,
  // consumed as scanTarget) and was wired into rules 1 and 2 and not into this
  // one. CLAUDE.md §2.21: a remediation applied to one copy while an identical
  // omission sits in the next rule is a moved problem, not a fix.
  //
  // THIS DOES NOT RELAX THE RULE. maskSpans() blanks the message BY OFFSET, so
  // a real build command sitting outside the message on the same line is still
  // present in scanTarget and still refused — proven by the selftest case
  // "a real build chained AFTER a commit message is still BLOCKED".
  //
  // The specific harm of the old shape: it penalised exactly the commit
  // messages this estate most wants — the ones naming the substrate, the pid
  // and the path. A lane that learns to avoid that vocabulary writes worse
  // evidence, which is the failure CLAUDE.md §7 forbids rewording around.
  if (T.BUILD_COMMAND_RE.test(scanTarget)) {
    const live = T.matchLiveCheckout(scanTarget);
    if (live && !T.isSafeBuildLocation(scanTarget)) {
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
