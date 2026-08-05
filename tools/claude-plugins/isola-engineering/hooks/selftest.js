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
  {
    name: 'remote read-only inspection is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'mcp__ssh-deepseek__remote-ssh',
      tool_input: { host: '66.118.37.12', user: 'epicdm', command: 'pm2 jlist' },
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

console.log('\n' + (failed ? failed + ' FAILURE(S)' : 'all ' + (cases.length + stopCases.length) + ' checks passed'));
process.exit(failed ? 1 : 0);
