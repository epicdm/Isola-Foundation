#!/usr/bin/env node
/**
 * Deterministic self-test for the Isola hooks.
 *
 *   node .claude/hooks/selftest.js
 *
 * Every case spawns the real hook the way Claude Code does — JSON on stdin,
 * assert on exit code and output. No mocks, so a passing run is real evidence
 * that the guard is wired and behaving.
 *
 * Exit 0 = all pass. Exit 1 = at least one failure (usable as a CI gate).
 *
 * NOTE: fixture text that DESCRIBES a destructive command is assembled from
 * tokens via t(). A naive whole-payload substring scanner would otherwise block
 * this test file for containing the words of the operations it asserts are safe
 * to describe — which is precisely the false-positive class these cases exist to
 * prevent. The guard under test is tool-aware and needs no such trick.
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const GUARD = path.join(__dirname, 'isola-guard.js');
const STOP = path.join(__dirname, 'isola-stop-gate.js');

const t = (...parts) => parts.join('');

const BLOCK = 'block';
const ASK = 'ask';
const PASS = 'allow';

function run(script, payload) {
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 20000,
  });
  let verdict = PASS;
  if (r.status === 2) verdict = BLOCK;
  else if ((r.stdout || '').includes('"permissionDecision":"ask"')) verdict = ASK;
  else if ((r.stdout || '').includes('"decision":"block"')) verdict = BLOCK;
  return { verdict, stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

const SID = 'selftest-' + process.pid;

/** Graph asset ids under test (real EPIC assets; see lib/isola-topology.js). */
const WABA = '272252189309178';
const PNID_3742 = '975632242309171';
const PNID_6737 = '278390858690809';
const GRAPH = 'https://graph.facebook.com/v23.0/';

/**
 * A structurally valid, meaningless Meta token, assembled rather than written
 * literally so this file does not itself look like a committed credential.
 */
const FAKE_TOKEN = t('EA', 'A', 'b3xY7qLm2Nv9Kd4Rt6Wz8Ps1Hj5Gf0Cx', 'Qa7Ue2Ir');

const cases = [
  // --- THE R5A RULE -------------------------------------------------------
  {
    name: 'build inside /opt/bff-v2 (remote) is BLOCKED',
    expect: BLOCK,
    contains: 'build-in-live-checkout',
    payload: {
      session_id: SID,
      tool_name: 'mcp__ssh-deepseek__remote-ssh',
      tool_input: { host: '66.118.37.12', user: 'epicdm', command: 'cd /opt/bff-v2 && npm run build' },
    },
  },
  {
    name: 'build inside an isolated worktree is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'mcp__ssh-deepseek__remote-ssh',
      tool_input: { host: '66.118.37.12', user: 'epicdm', command: 'cd /home/epicdm/worktrees/feat-x && npm run build' },
    },
  },
  {
    name: 'install inside /home/epicdm/clawith-v1110 is BLOCKED',
    expect: BLOCK,
    contains: 'build-in-live-checkout',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'ssh deepseek "cd /home/epicdm/clawith-v1110 && pnpm install"' },
    },
  },

  // 2026-09-06 — real incident: a `gh pr create --body` narrating a fix for
  // THIS exact rule (quoting `npm run build` and `/opt/bff-v2` together to
  // EXPLAIN the two) was blocked as if it ran that build. extractNarrativeText
  // now covers gh pr/issue create/edit/comment's --body/-b/--title/-t the same
  // way it already covered git commit/tag messages, and rule 3 scans the
  // masked scanTarget, never raw cmd.
  {
    name: 'a PR body narrating a build-in-live-checkout fix is ALLOWED (describing, not performing)',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: {
        command:
          'gh pr create --repo epicdm/isolav2 --title "fix build" --body "Fixes cd /opt/bff-v2 && npm run build failing in worktrees"',
      },
    },
  },
  {
    name: 'a PR body narrating the SAME shape via -b/-t short flags is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: {
        command: 'gh issue create -t "cd /opt/bff-v2 && npm run build breaks" -b "same shape, short flags"',
      },
    },
  },
  {
    name: 'a REAL build chained around a gh pr create --body still BLOCKS (the mask does not swallow it)',
    expect: BLOCK,
    contains: 'build-in-live-checkout',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: {
        command: 'gh pr create --body "unrelated text" && ssh deepseek "cd /opt/bff-v2 && npm run build"',
      },
    },
  },
  {
    name: 'a LITERAL credential inside a gh pr --body is BLOCKED (narrative fields still respect credential rules)',
    expect: BLOCK,
    contains: 'credential-in-commit-message',
    notContains: FAKE_TOKEN,
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: `gh pr create --body "the token is ${FAKE_TOKEN}"` },
    },
  },
  {
    name: 'an ordinary gh pr create with no build/live-checkout text is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --repo epicdm/isolav2 --title "fix(wallet): x" --body "small copy fix"' },
    },
  },

  // --- SECRETS ------------------------------------------------------------
  {
    name: 'Read of a .env file is BLOCKED',
    expect: BLOCK,
    contains: 'secret-read',
    payload: { session_id: SID, tool_name: 'Read', tool_input: { file_path: 'artifacts/isola/.env' } },
  },
  {
    name: 'Read of .env.example is ALLOWED',
    expect: PASS,
    payload: { session_id: SID, tool_name: 'Read', tool_input: { file_path: 'artifacts/isola/.env.example' } },
  },
  {
    name: 'printing a secret file to stdout is BLOCKED',
    expect: BLOCK,
    contains: 'secret-dump',
    payload: { session_id: SID, tool_name: 'Bash', tool_input: { command: 'cat artifacts/isola/.env' } },
  },
  {
    name: 'env dump is BLOCKED',
    expect: BLOCK,
    contains: 'secret-dump',
    payload: { session_id: SID, tool_name: 'Bash', tool_input: { command: 'printenv | sort' } },
  },
  {
    // Regression: `process.env.X` is code, not a file, and an earlier `head`
    // in the same compound command must not be attributed to it.
    name: 'read-only inspection using process.env is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: {
        command:
          'git status --porcelain | head -5 && node -e "console.log(new URL(process.env.DATABASE_URL).hostname)"',
      },
    },
  },
  {
    name: 'listing variable NAMES only is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'grep -o "^[A-Z_][A-Z0-9_]*=" artifacts/isola/.env.example' },
    },
  },
  {
    name: 'writing to a .env file is BLOCKED',
    expect: BLOCK,
    contains: 'secret-write',
    payload: { session_id: SID, tool_name: 'Write', tool_input: { file_path: 'artifacts/isola/.env', content: 'X=1' } },
  },

  // --- PROTECTED PATHS ----------------------------------------------------
  {
    name: 'writing into a live checkout is BLOCKED',
    expect: BLOCK,
    contains: 'live-checkout-write',
    payload: {
      session_id: SID,
      tool_name: 'mcp__ssh-deepseek__ssh-write-chunk',
      tool_input: { host: '66.118.37.12', filePath: '/opt/bff-v2/app/lib/thing.ts', chunk: 'x' },
    },
  },
  {
    name: 'writing into build output is BLOCKED',
    expect: BLOCK,
    contains: 'build-output-write',
    payload: {
      session_id: SID,
      tool_name: 'Write',
      tool_input: { file_path: 'artifacts/isola/.next/server/app/page.js', content: 'x' },
    },
  },
  {
    name: 'ordinary repo write is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Write',
      tool_input: { file_path: 'artifacts/isola/lib/example.ts', content: 'export const a = 1;' },
    },
  },

  // --- AD HOC FIXTURE TEARDOWN (ONE GOVERNED DOMAIN) ----------------------
  {
    name: 'ad hoc litePlanSubscription write outside scripts/ops/ is BLOCKED',
    expect: BLOCK,
    contains: 'ad-hoc-fixture-teardown',
    payload: {
      session_id: SID,
      tool_name: 'Write',
      tool_input: {
        file_path: '_fixturepurchase4.ts',
        content: 'await prisma.litePlanSubscription.updateMany({ where: { liteAccountId: acct.id, state: "active" }, data: { state: "expired" } });',
      },
    },
  },
  {
    name: 'ad hoc sipPasswordHash assignment outside scripts/ops/ is BLOCKED',
    expect: BLOCK,
    contains: 'ad-hoc-fixture-teardown',
    payload: {
      session_id: SID,
      tool_name: 'Write',
      tool_input: {
        file_path: '_checkfixture.ts',
        content: 'await prisma.liteAccount.update({ where: { id: acct.id }, data: { sipPasswordHash: testHash } });',
      },
    },
  },
  {
    name: 'the SAME shape inside scripts/ops/ (the registered procedure itself) is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Write',
      tool_input: {
        file_path: 'scripts/ops/fixture-reset.ts',
        content: 'await prisma.litePlanSubscription.updateMany({ where: { liteAccountId: acct.id, state: "active" }, data: { state: "expired" } });',
      },
    },
  },
  {
    name: 'the SAME shape inside real application source (app/lib) is ALLOWED — this rule governs ops scripts, not product code',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Write',
      tool_input: {
        file_path: 'app/lib/lite-plan-lifecycle.ts',
        content: 'await prisma.litePlanSubscription.update({ where: { id }, data: { state: "expired" } });',
      },
    },
  },

  // --- SCHEMA / DB --------------------------------------------------------
  {
    name: 'prohibited schema push is BLOCKED',
    expect: BLOCK,
    contains: 'prisma-db-push',
    payload: { session_id: SID, tool_name: 'Bash', tool_input: { command: 'npx prisma db push' } },
  },
  {
    name: 'migration-ledger tampering is BLOCKED',
    expect: BLOCK,
    contains: 'prisma-ledger-tamper',
    payload: { session_id: SID, tool_name: 'Bash', tool_input: { command: 'npx prisma migrate resolve --applied 2026' } },
  },
  {
    name: 'unscoped row purge is BLOCKED',
    expect: BLOCK,
    contains: 'sql-unscoped-row-purge',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'psql -c "' + t('DEL', 'ETE FROM') + ' tenant_registry;"' },
    },
  },

  // --- META / PROTECTED ASSETS -------------------------------------------
  // Policy lives in lib/meta-graph-policy.js and has its own pure-predicate
  // suite (meta-graph-policy.test.js, `node --test`). These cases prove the
  // policy is actually WIRED INTO the hook — same JSON-on-stdin path Claude
  // Code uses — not merely correct in isolation.
  {
    name: 'Meta webhook mutation is BLOCKED',
    expect: BLOCK,
    contains: 'meta-asset-mutation',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'curl -X POST "' + GRAPH + PNID_3742 + '/subscribed_apps"' },
    },
  },
  {
    name: 'implicit Meta write (body flag, no -X) is BLOCKED',
    expect: BLOCK,
    contains: 'meta-asset-mutation',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: {
        command: 'curl "' + GRAPH + PNID_3742 + '/subscribed_apps" --data "subscribed_fields=messages"',
      },
    },
  },
  {
    // THE REGRESSION. Before 2026-08-05 this exact shape was denied as a
    // mutation because --data-urlencode was treated as a write indicator, which
    // pushed engineers toward hand-built query strings to prove webhook
    // ownership. -G means GET.
    name: 'curl -G --data-urlencode metadata read is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: {
        command:
          'curl -sG --data-urlencode "fields=webhook_configuration" ' +
          '--data-urlencode "access_token=$META_GRAPH_TOKEN" ' + GRAPH + PNID_6737,
      },
    },
  },
  {
    name: 'allowlisted subscribed_apps GET is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'curl -s "' + GRAPH + WABA + '/subscribed_apps?access_token=$META_GRAPH_TOKEN"' },
    },
  },
  {
    name: 'allowlisted WABA phone-number enumeration GET is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'curl -s "' + GRAPH + WABA + '/phone_numbers?access_token=$META_GRAPH_TOKEN"' },
    },
  },
  {
    name: 'metadata-only debug_token GET is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: {
        command:
          'curl -sG --data-urlencode "input_token=$SUBJECT_TOKEN" ' +
          '--data-urlencode "access_token=$APP_TOKEN" ' + GRAPH + 'debug_token',
      },
    },
  },
  {
    name: 'long-lived token exchange GET is BLOCKED',
    expect: BLOCK,
    contains: 'token-exchange',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: {
        command:
          'curl -sG -d "grant_type=fb_exchange_token" -d "client_id=$APP_ID" ' +
          '-d "client_secret=$APP_SECRET" -d "fb_exchange_token=$SHORT_TOKEN" ' + GRAPH + 'oauth/access_token',
      },
    },
  },
  {
    name: 'page-token minting edge (/me/accounts) is BLOCKED',
    expect: BLOCK,
    contains: 'token-minting',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'curl -s "' + GRAPH + 'me/accounts?access_token=$META_GRAPH_TOKEN"' },
    },
  },
  {
    // Two assertions in one: the literal is refused, AND the refusal message
    // does not reprint it. A guard that leaks the credential while blocking it
    // has not protected anything.
    name: 'literal Meta credential in argv is BLOCKED and not echoed back',
    expect: BLOCK,
    contains: 'credential-literal',
    notContains: FAKE_TOKEN,
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'curl -s "' + GRAPH + WABA + '/subscribed_apps?access_token=' + FAKE_TOKEN + '"' },
    },
  },
  {
    name: 'side-effecting GET (request_code) is BLOCKED',
    expect: BLOCK,
    contains: 'side-effecting-get',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'curl -s "' + GRAPH + PNID_3742 + '/request_code?code_method=SMS"' },
    },
  },
  {
    name: 'requesting credential fields on an approved object is BLOCKED',
    expect: BLOCK,
    contains: 'credential-field',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'curl -s "' + GRAPH + PNID_3742 + '?fields=access_token"' },
    },
  },
  {
    name: 'unapproved Graph edge is BLOCKED',
    expect: BLOCK,
    contains: 'unapproved-edge',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'curl -s "' + GRAPH + WABA + '/message_templates"' },
    },
  },
  {
    name: 'approved object with an unapproved field is BLOCKED',
    expect: BLOCK,
    contains: 'unapproved-field',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'curl -s "' + GRAPH + PNID_3742 + '?fields=messages"' },
    },
  },
  {
    name: 'non-Graph POST is unaffected by Meta policy',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'curl -X POST https://example.com/webhook -d "a=1"' },
    },
  },
  {
    // Adversarial review 2026-08-05, finding 1 (critical). A malformed percent
    // escape threw URIError inside the policy; the guard fails open on any
    // internal error, so the POST was allowed. This case is the end-to-end
    // proof that the fail-open path is no longer reachable this way.
    name: 'malformed percent escape does NOT fail the guard open',
    expect: BLOCK,
    contains: 'meta-asset-mutation',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: {
        command: 'curl -X POST "' + GRAPH + PNID_3742 + '/subscribed_apps?bad%ZZ=1&access_token=$META_GRAPH_TOKEN"',
      },
    },
  },
  {
    // Adversarial review 2026-08-05, finding 2 (high).
    name: 'curl --next second transfer cannot POST behind a leading -G',
    expect: BLOCK,
    contains: 'meta-asset-mutation',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: {
        command:
          'curl -G "' + GRAPH + WABA + '?fields=name" --next -d "subscribed_fields=messages" "' +
          GRAPH + PNID_3742 + '/subscribed_apps"',
      },
    },
  },
  {
    // Adversarial review 2026-08-05, finding 4 (high). A shell-assembled host
    // left every token-minting endpoint reachable.
    name: 'shell-assembled Graph host is refused, not waved through',
    expect: BLOCK,
    contains: 'unclassifiable-graph-request',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: {
        command:
          'HOST=graph.facebook.com; curl "https://$HOST/v23.0/oauth/access_token?grant_type=fb_exchange_token' +
          '&client_id=$APP_ID&client_secret=$APP_SECRET"',
      },
    },
  },
  {
    name: 'prose mentioning the Graph host is still not gated',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'grep -rn graph.facebook.com artifacts/isola/lib' },
    },
  },

  // --- SOFT GATES ---------------------------------------------------------
  {
    name: 'remote service restart ASKS',
    expect: ASK,
    payload: {
      session_id: SID,
      tool_name: 'mcp__ssh-deepseek__remote-ssh',
      tool_input: { host: '66.118.37.12', user: 'epicdm', command: 'pm2 restart bff-v2-web' },
    },
  },
  {
    name: 'legacy v1.8.3 reference in code ASKS',
    expect: ASK,
    payload: {
      session_id: SID,
      tool_name: 'Write',
      tool_input: { file_path: 'artifacts/isola/lib/new-thing.ts', content: 'const u = "http://localhost:8800/api";' },
    },
  },

  // --- NO FALSE POSITIVES (the incumbent-hook regression class) -----------
  {
    name: 'task text DESCRIBING a container teardown is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'TaskUpdate',
      tool_input: {
        taskId: '1',
        description:
          'Plan: ' + t('do', 'cker compose ', 'do', 'wn') + ' then ' + t('do', 'cker ', 'r', 'm') +
          ' the old container, and ' + t('trun', 'cate') + ' the staging table.',
      },
    },
  },
  {
    name: 'Port record documenting destructive SQL is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'mcp__claude_ai_Port_IO__upsert_entity',
      tool_input: {
        blueprintIdentifier: 'evidence',
        entity: {
          identifier: 'ev-x',
          properties: {
            description:
              'Ledger records a ' + t('DR', 'OP TABLE') + ' and a ' + t('pm', '2 ', 'del', 'ete') +
              ' performed under owner authorization.',
          },
        },
      },
    },
  },
  {
    name: 'documentation (.md) mentioning the frozen stack is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Write',
      tool_input: { file_path: 'docs/migration-ledger.md', content: 'The frozen source at runtime.epic.dm:8800 is the migration origin.' },
    },
  },
  {
    name: 'read-only investigation is never blocked',
    expect: PASS,
    payload: { session_id: SID, tool_name: 'Grep', tool_input: { pattern: 'tenant_id', path: 'artifacts/isola/lib' } },
  },

  // --- CREDENTIAL-SURFACE OUTPUT REDACTION --------------------------------
  // Regression cover for the two 2026-08-16 exposures. Both commands are
  // legitimate reads, so the correct verdict is ALLOW-WITH-REWRITE, never a
  // block: denying them pushes the same read into an unguarded shape.
  {
    name: 'git remote (PAT in remote URL) is BLOCKED with the redacted form as the remedy',
    expect: BLOCK,
    contains: 'credential-surface-redact',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'cd /opt/lk-voice-agent && git remote -v' },
    },
  },
  {
    name: 'a line-range read of a SIP peers config is BLOCKED with the redacted form as the remedy',
    expect: BLOCK,
    contains: 'secret-redact',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: "ssh voice00 \"sed -n '100,140p' /etc/asterisk/sip_peers.conf\"" },
    },
  },
  // --- PROSE IS NOT EXECUTION (commit messages) ----------------------------
  // LAW, adopted 2026-08-16: every relaxation of a security rule ships with a
  // test that the rule still catches what it was for. Otherwise the fix and the
  // hole look identical from the test suite. Hence the four controls below.
  {
    name: 'a commit message DESCRIBING a secret dump is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "docs: explain why ' + t('cat ', '.env') + ' is blocked by the guard"' },
    },
  },
  {
    name: 'a commit message DESCRIBING a destructive op is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "ledger: records a ' + t('DR', 'OP TABLE') + ' performed under owner authorization"' },
    },
  },
  // ── sql-wipe-table: vocabulary vs operation (fixed 2026-09-06) ──────────
  //
  // The rule made the TABLE keyword optional, so it matched the wipe verb
  // followed by any identifier character. It refused three legitimate documents
  // in one session, including the commit message documenting its own refusal.
  // Both directions are pinned here: the real operation must still be blocked,
  // and prose must not be. Neither half is evidence alone — a rule that blocks
  // everything passes the first, a deleted rule passes the second.
  {
    name: 'REAL whole-table wipe (canonical DDL form) is BLOCKED',
    expect: BLOCK,
    contains: 'sql-wipe-table',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'psql -c "' + t('TRUN', 'CATE TABLE') + ' lite_plan_subscriptions;"' },
    },
  },
  {
    name: 'REAL whole-table wipe WITHOUT the TABLE keyword, through a SQL client, is BLOCKED',
    expect: BLOCK,
    contains: 'sql-wipe-table-bare',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'psql -d isola -c "' + t('trun', 'cate') + ' lite_accounts;"' },
    },
  },
  {
    // The exact shell line refused on 2026-09-06. Its only offence was the
    // echo; the real file operation on the same line never matched the rule.
    name: 'an ECHO containing the wipe verb, with no SQL client, is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: {
        command: 'echo "=== A. ' + t('trun', 'cate') + ' a clean file with 3 em-dashes ===" && node tool.mjs keep-lines --file=x.ts --keep=3',
      },
    },
  },
  {
    // The second refusal: the commit message DOCUMENTING the first one, written
    // as a PowerShell here-string because that is this machine's primary shell.
    // Two defects fired together — the over-broad rule, and a narrative
    // exemption that understood only bash heredocs.
    name: 'a PowerShell here-string commit message describing the wipe verb is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'PowerShell',
      tool_input: {
        command: "git commit -m @'\nops(encoding): register a safe file-edit procedure\n\nThe command is keep-lines, not " +
          t('trun', 'cate') + ", because that word is a destructive-SQL verb\nin the guard and naming it so would trip the estate's own rule.\n'@",
      },
    },
  },
  {
    // CONTROL for the two ALLOWED cases above: the exemption is about CONTEXT,
    // not about the word being harmless. Put a real SQL client on the same line
    // and the identical verb is refused again.
    name: 'CONTROL: the same wipe verb WITH a SQL client on the line is BLOCKED again',
    expect: BLOCK,
    contains: 'sql-wipe-table-bare',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'echo "cleaning up" && psql -d isola -c "' + t('trun', 'cate') + ' lite_accounts;"' },
    },
  },
  {
    // CONTROL: the PowerShell here-string exemption covers the MESSAGE ONLY.
    name: 'CONTROL: a real wipe CHAINED after a here-string commit is still BLOCKED',
    expect: BLOCK,
    contains: 'sql-wipe-table',
    payload: {
      session_id: SID,
      tool_name: 'PowerShell',
      tool_input: {
        command: "git commit -m @'\nharmless note\n'@ ; psql -c \"" + t('TRUN', 'CATE TABLE') + ' lite_accounts;"',
      },
    },
  },
  {
    // Review found 2026-09-06: the PowerShell here-string exemption matched
    // ANY here-string in the command once `git commit` appeared, not just
    // the one bound to -m. The exact reported exploit -- a here-string
    // assigned to an unrelated variable, never the commit message, then
    // executed via that variable.
    name: 'a here-string NOT bound to -m is not exempted -- destructive payload in $q is still BLOCKED',
    expect: BLOCK,
    contains: 'sql-wipe-table',
    payload: {
      session_id: SID,
      tool_name: 'PowerShell',
      tool_input: {
        command: "git commit -m \"safe\"; $q=@'\n" + t('TRUN', 'CATE TABLE') + " lite_accounts;\n'@; psql -c $q",
      },
    },
  },
  {
    // Same defect class, bash side: a heredoc unrelated to `git commit -F -`
    // (e.g. feeding a variable that is later executed) must not be exempted
    // just because `git commit` appears somewhere on the line.
    name: 'a bash heredoc NOT bound to -F - is not exempted -- destructive payload is still BLOCKED',
    expect: BLOCK,
    contains: 'sql-wipe-table',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: {
        command: 'git commit -m "safe"; x=$(cat <<\'EOF\'\n' + t('TRUN', 'CATE TABLE') + ' lite_accounts;\nEOF\n); psql -c "$x"',
      },
    },
  },
  {
    // CONTROL 1: the exemption must cover the MESSAGE ONLY. A real operation
    // chained after it is still a real operation.
    name: 'a real secret dump CHAINED after a commit is still BLOCKED',
    expect: BLOCK,
    contains: 'secret-dump',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "harmless note" && ' + t('cat ', '/opt/bff-v2/.env') },
    },
  },
  {
    // CONTROL 2: relaxing shape rules must NOT relax credential rules. A commit
    // message is permanent and travels with the repo — worse than a transcript.
    name: 'a LITERAL credential inside a commit message is BLOCKED',
    expect: BLOCK,
    contains: 'credential-in-commit-message',
    notContains: FAKE_TOKEN,
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "chore: rotate to ' + FAKE_TOKEN + '"' },
    },
  },
  {
    // A bare environment dump must STILL be denied — the positive control for
    // the lookbehind added below it. Without this, relaxing that rule could
    // silently stop catching `env |` and every other case would still pass.
    name: 'a bare environment dump is still BLOCKED',
    expect: BLOCK,
    contains: 'secret-dump',
    payload: { session_id: SID, tool_name: 'Bash', tool_input: { command: 'ssh deepseek "env | sort"' } },
  },
  // REGRESSION COVER — found by adversarial review 2026-08-16, NOT by the tests
  // written alongside the change. The first lookbehind excluded `/` as well as
  // `.`, which let every path-qualified environment dump through. These are the
  // reviewer's exact bypass strings, kept verbatim so the regression cannot
  // return quietly.
  {
    name: 'path-qualified env dump /usr/bin/env is BLOCKED',
    expect: BLOCK,
    contains: 'secret-dump',
    payload: { session_id: SID, tool_name: 'Bash', tool_input: { command: 'ssh deepseek "/usr/bin/env | sort"' } },
  },
  {
    name: 'path-qualified /usr/bin/printenv is BLOCKED',
    expect: BLOCK,
    contains: 'secret-dump',
    payload: { session_id: SID, tool_name: 'Bash', tool_input: { command: 'ssh deepseek /usr/bin/printenv' } },
  },
  {
    name: 'relative ./env dump is BLOCKED',
    expect: BLOCK,
    contains: 'secret-dump',
    payload: { session_id: SID, tool_name: 'Bash', tool_input: { command: 'ssh deepseek "./env | sort"' } },
  },
  {
    // …but a .env FILE PATH followed by a pipe is not an environment dump. This
    // false positive fired ahead of the rewrite rule and blocked the safe,
    // redacted form of a read the guard's own remedy text recommends.
    name: 'a dotenv path piped to a filter is blocked as a CREDENTIAL SURFACE, not as an env dump',
    expect: BLOCK,
    contains: 'credential-surface-redact',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'ssh deepseek "grep -oE \'^MAGNUS[A-Z0-9_]*=\' /opt/bff-v2/.env | sort -u"' },
    },
  },
  {
    // C-04: a PROVISIONED .paperclip.yaml carries an injected `Bearer rtp_…`.
    // The committed template is clean, so nothing in the repo would ever reveal
    // this — only a raw read of the live file does, and a yaml is not
    // SECRET_FILE-shaped. This is the case where placement was already correct
    // and the read discipline was the only control.
    name: 'a raw read of a provisioned .paperclip.yaml is BLOCKED with the redacted form as the remedy',
    expect: BLOCK,
    contains: 'credential-surface-redact',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'ssh deepseek "cat /opt/paperclip/agents/front-desk/.paperclip.yaml"' },
    },
  },
  {
    // The negative control. Without it, a rule that rewrote EVERY command would
    // still pass both cases above while quietly wrapping the whole session.
    name: 'an ordinary command is untouched',
    expect: PASS,
    notContains: 'credential-surface-redact',
    payload: { session_id: SID, tool_name: 'Bash', tool_input: { command: 'ls -la /var/log' } },
  },
  {
    // Rewriting is Bash-only by design (the wrapper is bash syntax). PowerShell
    // must fall through untouched rather than receive a broken command.
    name: 'PowerShell reading a credential surface is BLOCKED too (no longer bash-only)',
    expect: BLOCK,
    contains: 'credential-surface-redact',
    payload: { session_id: SID, tool_name: 'PowerShell', tool_input: { command: 'git remote -v' } },
  },
  {
    name: 'remote read-only inspection is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'mcp__ssh-deepseek__remote-ssh',
      tool_input: { host: '66.118.37.12', user: 'epicdm', command: 'pm2 jlist' },
    },
  },

  // --- EASYPANEL SECRET-DUMP PROCEDURE (P0, 2026-08-10) -------------------
  {
    name: 'epic-portal execute_query listProjectsAndServices is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-secret-dump-procedure',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'listProjectsAndServices', input: {} },
    },
  },
  {
    name: 'epic-portal execute_mutation listProjectsAndServices is BLOCKED (defense in depth)',
    expect: BLOCK,
    contains: 'easypanel-secret-dump-procedure',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_mutation',
      tool_input: { procedure: 'listProjectsAndServices', input: {} },
    },
  },
  {
    name: 'raw JSON-RPC-over-HTTPS bypass calling listProjectsAndServices is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-secret-dump-procedure',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: {
        command: t(
          'curl -s https://portal.saas00.epic.dm/api/mcp -d \'{"method":"tools/call","params":',
          '{"name":"execute_query","arguments":{"procedure":"listProjectsAndServices","input":{}}}}\''
        ),
      },
    },
  },
  {
    name: 'epic-portal execute_query listProjects (names only) is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'listProjects', input: {} },
    },
  },
  {
    name: 'epic-portal execute_query listPorts is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'listPorts', input: { projectName: 'isola', serviceName: 'nocobase' } },
    },
  },
  {
    name: 'epic-portal execute_query listMounts is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'listMounts', input: { projectName: 'isola', serviceName: 'nocobase' } },
    },
  },
  {
    name: 'epic-portal execute_query getComposeDockerServices is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'getComposeDockerServices', input: {} },
    },
  },
  {
    name: 'epic-portal execute_query getMonitorTableData is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'getMonitorTableData', input: {} },
    },
  },

  // --- EASYPANEL BLOCK — adversarial shapes (owner-directed hardening pass) --
  {
    name: 'namespaced procedure "projects.listProjectsAndServices" is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-secret-dump-procedure',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'projects.listProjectsAndServices', input: {} },
    },
  },
  {
    name: 'procedure name nested under tool_input.arguments is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-secret-dump-procedure',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_mutation',
      tool_input: { arguments: { procedure: 'listProjectsAndServices', input: {} } },
    },
  },
  {
    name: 'whole tool_input arriving as a serialized JSON string is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-secret-dump-procedure',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: '{"procedure":"listProjectsAndServices","input":{}}',
    },
  },
  {
    name: 'raw REST-style /api/rpc/projects/listProjectsAndServices path is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-secret-dump-procedure',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'curl -s https://portal.saas00.epic.dm/api/rpc/projects/listProjectsAndServices' },
    },
  },
  {
    name: 'raw tRPC-style /api/trpc/projects.listProjectsAndServices path is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-secret-dump-procedure',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'curl -s "https://portal.saas00.epic.dm/api/trpc/projects.listProjectsAndServices?batch=1"' },
    },
  },
  {
    // Same design rule as "prose mentioning the Graph host is still not gated":
    // describing the blocked path/procedure (a commit message, a doc) is not
    // performing it. No curl/fetch/http-client invocation present here.
    name: 'a commit message DESCRIBING the blocked path/procedure is ALLOWED (not payload-blind)',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: {
        command: t(
          'git commit -m "fix(guard): block /api/rpc/projects/listProjectsAndServices ',
          'and /api/trpc/... requests"'
        ),
      },
    },
  },
  {
    // 8 levels deep (arguments/params/input/body/data/payload/arguments/params) —
    // exceeds EASYPANEL_MAX_INSPECT_DEPTH (6) BEFORE the buried procedure name is
    // ever reached, so this genuinely exercises the throw-on-depth path, not
    // ordinary candidate extraction succeeding by coincidence.
    name: 'deeply-nested unparseable epic-portal payload FAILS CLOSED (BLOCKED, not allowed or crashed)',
    expect: BLOCK,
    contains: 'easypanel-secret-dump-procedure',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: {
        arguments: { params: { input: { body: { data: { payload: { arguments: { params: { procedure: 'listProjectsAndServices' } } } } } } } },
      },
    },
  },
  {
    name: 'the SAME deeply-nested shape on an UNRELATED tool stays fail-OPEN (existing behavior preserved)',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'SomeUnrelatedTool',
      tool_input: {
        arguments: { params: { input: { body: { data: { payload: { arguments: { params: { procedure: 'listProjectsAndServices' } } } } } } } },
      },
    },
  },
];

let failed = 0;
console.log('isola hooks - selftest\n');
for (const c of cases) {
  const r = run(GUARD, c.payload);
  const okVerdict = r.verdict === c.expect;
  const okContains = !c.contains || r.stderr.includes(c.contains) || r.stdout.includes(c.contains);
  // notContains proves the guard did not echo something it must never print —
  // a credential leaked inside a deny message is still a leaked credential.
  const okNotContains = !c.notContains || (!r.stderr.includes(c.notContains) && !r.stdout.includes(c.notContains));
  const ok = okVerdict && okContains && okNotContains;
  if (!ok) failed++;
  console.log(
    (ok ? '  PASS  ' : '  FAIL  ') +
      c.name +
      (ok
        ? ''
        : '\n          expected=' + c.expect + ' got=' + r.verdict +
          (c.contains ? ' wanted-rule=' + c.contains : '') +
          (!okNotContains ? ' LEAKED-FORBIDDEN-STRING' : '') +
          (r.stderr ? '\n          stderr: ' + r.stderr.split('\n').slice(0, 2).join(' | ') : ''))
  );
}

// --- Stop gate ------------------------------------------------------------
console.log('\nstop gate');
const stopCases = [
  {
    name: 'no code edited -> does not fire',
    expect: PASS,
    payload: { session_id: 'selftest-clean-' + process.pid, hook_event_name: 'Stop' },
  },
  {
    name: 'already fired this turn -> does not loop',
    expect: PASS,
    payload: { session_id: SID, hook_event_name: 'Stop', stop_hook_active: true },
  },
];
for (const c of stopCases) {
  const r = run(STOP, c.payload);
  const ok = r.verdict === c.expect;
  if (!ok) failed++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + c.name + (ok ? '' : ' (expected ' + c.expect + ', got ' + r.verdict + ')'));
}

// Clean up the ledgers this run created, so a self-test never pollutes the
// working session's state.
try {
  const fs = require('fs');
  const sessions = path.join(__dirname, '..', 'state', 'sessions');
  for (const d of fs.readdirSync(sessions)) {
    if (/^selftest-/.test(d)) fs.rmSync(path.join(sessions, d), { recursive: true, force: true });
  }
} catch (_) {
  /* nothing to clean */
}

// 2026-08-19 — CHAIN THE USER-HOME HOOK'S OWN SUITE.
//
// This selftest exercises isola-guard.js and isola-stop-gate.js, both of which live in
// this repository. It does NOT reach ~/.claude/hooks/enforce-safety.js, which is a third
// enforcing hook living outside the repo — and CLAUDE.md used to point here as though
// running this verified everything. Somebody following the documented procedure would
// have verified two of three hooks and believed they had checked all of them.
//
// It cannot be bundled here (it is per-machine and not version-controlled), so this
// chains its own suite when present and says so plainly when it is absent. An absent
// hook is reported, never silently treated as a pass: "no result" is not "passed".
// 2026-08-21 (Packet 5M-ER4S) — DISCOVER THE SUITES, DO NOT NAME ONE.
//
// This block used to run exactly one hardcoded file, `enforce-safety.test.js`.
// By 2026-08-21 there were SIX suites beside it — doc-vs-exec, gate-control,
// network-destroy, temp-5mra, resource-destroy — and this chained one of them.
// A lane following CLAUDE.md's documented procedure ("run selftest.js to verify")
// was verifying 39 of 188 user-home checks and being told "all checks passed".
//
// That is the SAME defect as the one described in the comment directly above:
// running part of the enforcement and believing you had run all of it. It was
// written here as a lesson and then re-committed one level down. So the list is
// now DERIVED from the directory rather than remembered, and the count of suites
// found is printed — a number nobody can mistake for coverage they did not get.
const os = require('os');
const fsm = require('fs');
const homeHookDir = path.join(os.homedir(), '.claude', 'hooks');
let homeHookFailed = 0;
try {
  const suites = fsm.existsSync(homeHookDir)
    ? fsm.readdirSync(homeHookDir)
        .filter((f) => /^enforce-safety.*\.test\.js$/.test(f))
        .sort()
    : [];
  if (suites.length) {
    console.log('\n--- user-home hook suites in ' + homeHookDir + ' (' + suites.length + ' found)');
    for (const f of suites) {
      const r = spawnSync(process.execPath, [path.join(homeHookDir, f)], { encoding: 'utf8' });
      const out = (r.stdout || '') + (r.stderr || '');
      const summary = out.split('\n').filter((l) => /passed,|FAILURE/.test(l)).pop() || '(no summary line)';
      const bad = /[1-9]\d* failed/.test(summary) || r.status !== 0;
      if (bad) homeHookFailed = 1;
      console.log((bad ? '  FAIL  ' : '  PASS  ') + f.padEnd(44) + summary.trim());
    }
  } else if (fsm.existsSync(path.join(homeHookDir, 'enforce-safety.js'))) {
    homeHookFailed = 1;
    console.log('\n--- user-home hook: INSTALLED BUT HAS NO SUITE (' + homeHookDir + ')');
    console.log('  FAIL  enforce-safety.js is enforcing here with nothing verifying it.');
  } else {
    console.log('\n--- user-home hook: NOT INSTALLED on this machine (' + homeHookDir + ')');
    console.log('  NOT RUN  enforce-safety.js is unverified here. This is a per-machine hook;');
    console.log('           its absence means this machine does not have that enforcement.');
  }
} catch (e) {
  homeHookFailed = 1;
  console.log('  FAIL  could not run the user-home hook suites: ' + (e && e.message));
}
failed += homeHookFailed;

console.log('\n' + (failed ? failed + ' FAILURE(S)' : 'all ' + (cases.length + stopCases.length) + ' checks passed'));
process.exit(failed ? 1 : 0);
