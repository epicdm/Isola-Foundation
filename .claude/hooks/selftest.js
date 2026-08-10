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
const fs = require('fs');

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

/** The real EasyPanel procedure this whole guard exists to block, assembled
 * rather than written literally so a naive whole-payload scanner does not
 * flag this test file itself for containing the string it asserts is unsafe. */
const LEAKY_PROCEDURE_NAME = ['listProjects', 'And', 'Services'].join('');

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


  // --- EASYPANEL - STRICT ALLOWLIST + EXACT INPUT PREDICATES (v3, 2026-08-10) ---
  // Two layers: (1) tool-name allowlist - only search_procedures and
  // execute_query are ever considered; (2) for execute_query, the wrapper
  // shape itself must be exactly {procedure, input} with nothing else, and
  // the named procedure must have BOTH an allowlist entry AND a passing
  // exact input predicate (scoped project/service, no extra fields).
  // getMonitorTableData has no scopable fields in its real schema and is
  // therefore NOT in this allowlist at all right now.

  // -- tool-name layer --
  {
    name: 'search_procedures (schema discovery only, never executes a procedure) is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__search_procedures',
      tool_input: { query: 'list projects' },
    },
  },
  {
    name: 'execute_mutation is BLOCKED outright regardless of procedure name',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_mutation',
      tool_input: { procedure: 'listProjects', input: {} },
    },
  },
  {
    name: 'execute_destructive is BLOCKED outright regardless of procedure name',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_destructive',
      tool_input: { procedure: 'getMonitorTableData', input: {} },
    },
  },
  {
    name: 'unknown tool mcp__epic-portal__execute_admin is BLOCKED outright',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_admin',
      tool_input: { procedure: 'listProjects', input: {} },
    },
  },
  {
    name: 'suffixed tool mcp__epic-portal__execute_query_extra is BLOCKED outright (not fuzzy-matched)',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query_extra',
      tool_input: { procedure: 'listProjects', input: {} },
    },
  },
  {
    name: 'suffixed tool mcp__epic-portal__search_procedures_extra is BLOCKED outright (not fuzzy-matched)',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__search_procedures_extra',
      tool_input: { query: 'list projects' },
    },
  },

  // -- wrapper-shape layer --
  {
    name: 'tool_input with an extra top-level key beyond {procedure, input} is BLOCKED (unexpected wrapper shape)',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'listProjects', input: {}, arguments: { procedure: 'listProjects' } },
    },
  },
  {
    name: 'tool_input arriving as a bare string (not an object) is BLOCKED (unexpected wrapper shape)',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: '{"procedure":"listProjects","input":{}}',
    },
  },
  {
    name: 'tool_input arriving as an array is BLOCKED (unexpected wrapper shape)',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: [{ procedure: 'listProjects', input: {} }],
    },
  },
  {
    name: 'missing procedure field is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { input: {} },
    },
  },
  {
    name: 'malformed JSON-string tool_input FAILS CLOSED at the wrapper-shape layer',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: '{"procedure": "listProjects", "input": {}',
    },
  },

  // -- the previously-leaky procedure itself, via the new architecture --
  {
    name: 'the previously-leaky procedure is BLOCKED (not in the predicate map at all)',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: LEAKY_PROCEDURE_NAME, input: {} },
    },
  },
  {
    name: 'getMonitorTableData is now BLOCKED - removed from the allowlist (unscopable real schema)',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'getMonitorTableData', input: {} },
    },
  },

  // -- listProjects: exact positive/negative predicate --
  {
    name: 'listProjects with empty input is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'listProjects', input: {} },
    },
  },
  {
    name: 'listProjects with absent input is ALLOWED (absent treated as empty)',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'listProjects' },
    },
  },
  {
    name: 'listProjects with ANY non-empty input is BLOCKED (requires strictly empty)',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'listProjects', input: { unexpected: true } },
    },
  },

  // -- listPorts: exact positive/negative predicate --
  {
    name: 'listPorts with isola + a reviewed service is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'listPorts', input: { projectName: 'isola', serviceName: 'nocobase-db' } },
    },
  },
  {
    name: 'listPorts as a serialized-JSON-string input (the known encoding quirk) is still ALLOWED when it resolves to a valid scoped target',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'listPorts', input: '{"projectName":"isola","serviceName":"nocobase-db"}' },
    },
  },
  {
    name: 'listPorts with an out-of-scope project is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'listPorts', input: { projectName: 'some-other-project', serviceName: 'nocobase-db' } },
    },
  },
  {
    name: 'listPorts with an out-of-scope (unreviewed) service is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'listPorts', input: { projectName: 'isola', serviceName: 'some-service-never-reviewed' } },
    },
  },
  {
    name: 'listPorts with a missing required serviceName is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'listPorts', input: { projectName: 'isola' } },
    },
  },
  {
    name: 'listPorts with an unexpected extra target field is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'listPorts', input: { projectName: 'isola', serviceName: 'nocobase-db', debug: true } },
    },
  },
  {
    name: 'listPorts with a conflicting nested "procedure" field inside input is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: {
        procedure: 'listPorts',
        input: { procedure: LEAKY_PROCEDURE_NAME, projectName: 'isola', serviceName: 'nocobase-db' },
      },
    },
  },

  // -- listMounts: exact positive/negative predicate --
  {
    name: 'listMounts with isola + a reviewed service is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'listMounts', input: { projectName: 'isola', serviceName: 'nocobase' } },
    },
  },
  {
    name: 'listMounts with an out-of-scope project is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'listMounts', input: { projectName: 'wrong-project', serviceName: 'nocobase' } },
    },
  },
  {
    name: 'listMounts with a missing required serviceName is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'listMounts', input: { projectName: 'isola' } },
    },
  },

  // -- getComposeDockerServices: exact positive/negative predicate --
  {
    name: 'getComposeDockerServices with isola + a reviewed service is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'getComposeDockerServices', input: { projectName: 'isola', serviceName: 'nocobase' } },
    },
  },
  {
    name: 'getComposeDockerServices with NO target fields is BLOCKED (policy stricter than the vendor schema)',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'getComposeDockerServices', input: {} },
    },
  },
  {
    name: 'getComposeDockerServices with an out-of-scope service is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'getComposeDockerServices', input: { projectName: 'isola', serviceName: 'unreviewed-service' } },
    },
  },
  {
    name: 'listPorts scoped to nocobase does NOT implicitly allow an Activepieces/Chatwoot/Paymenter/AI service name',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'listPorts', input: { projectName: 'isola', serviceName: 'activepieces' } },
    },
  },

  // -- PROTOTYPE-CHAIN ADVERSARIAL PROCEDURE NAMES (owner-directed, critical) --
  // A plain-object registry accessed as REGISTRY[userControlledString] is a
  // real bypass: REGISTRY['constructor'] resolves to Object.prototype.constructor
  // (callable, non-throwing) even though 'constructor' was never an own key.
  // Confirmed by direct reproduction before this fix (Map.get() has no such
  // lookup semantics at all). Every one of these MUST be blocked.
  ...['constructor', '__proto__', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__', '__defineSetter__'].map((evilProcedure) => ({
    name: `adversarial procedure name "${evilProcedure}" is BLOCKED, never reaches a real predicate or returns unblocked`,
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: evilProcedure, input: {} },
    },
  })),

  // -- raw HTTP/RPC/tRPC bypass - path/host/client coverage --
  {
    name: 'raw curl call to direct-IP exact /api/mcp (no trailing slash) is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'curl -s https://66.118.37.110/api/mcp -d \'{"method":"tools/call"}\'' },
    },
  },
  {
    name: 'raw curl call to an alternate host exact /api/mcp is BLOCKED (host-agnostic)',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'curl -s https://some-other-proxy.example.com/api/mcp -d \'{}\'' },
    },
  },
  {
    name: 'raw call with a query-string variant of /api/mcp is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'curl -s "https://portal.saas00.epic.dm/api/mcp?debug=1"' },
    },
  },
  {
    name: 'raw call with a trailing-slash variant of /api/mcp/ is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: "curl -s 'https://portal.saas00.epic.dm/api/mcp/'" },
    },
  },
  {
    name: 'exact /api/rpc with no trailing slash is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'curl -s https://portal.saas00.epic.dm/api/rpc' },
    },
  },
  {
    name: 'trailing-slash /api/rpc/ (REST-style sub-path) is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'curl -s https://portal.saas00.epic.dm/api/rpc/projects/listProjects' },
    },
  },
  {
    name: 'query-string variant of /api/rpc is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'curl -s "https://portal.saas00.epic.dm/api/rpc?input=%7B%7D"' },
    },
  },
  {
    name: 'exact /api/trpc with no trailing slash is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: 'curl -s https://portal.saas00.epic.dm/api/trpc' },
    },
  },
  {
    name: 'trailing-slash /api/trpc/ (dotted namespace sub-path) is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: "curl -s 'https://portal.saas00.epic.dm/api/trpc/projects.listProjects'" },
    },
  },
  {
    name: 'query-string batch variant of /api/trpc is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: "curl -s 'https://portal.saas00.epic.dm/api/trpc/projects.listProjects?batch=1'" },
    },
  },
  {
    name: 'Python requests.post to the raw endpoint is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: {
        command: t(
          'python3 -c "import requests; requests.post(',
          "'https://portal.saas00.epic.dm/api/mcp', json={})\""
        ),
      },
    },
  },
  {
    name: 'Python httpx.Client to the raw endpoint is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: {
        command: t(
          'python3 -c "import httpx; httpx.Client().post(',
          "'https://portal.saas00.epic.dm/api/rpc/projects/listProjects')\""
        ),
      },
    },
  },
  {
    name: 'Node fetch(...) to the raw endpoint is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: {
        command: t(
          'node -e "fetch(',
          "'https://portal.saas00.epic.dm/api/trpc/projects.listProjects')\""
        ),
      },
    },
  },
  {
    name: 'Node https.request(...) to the raw endpoint is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: {
        command: t(
          "node -e \"require('https').request(",
          "'https://portal.saas00.epic.dm/api/mcp', () => {})\""
        ),
      },
    },
  },
  {
    name: 'a commit message DESCRIBING these blocked paths is ALLOWED (not payload-blind)',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: {
        command: t(
          'git commit -m "fix(guard): block /api/rpc/... /api/trpc/... and direct-IP /api/mcp ',
          'requests to EasyPanel"'
        ),
      },
    },
  },
  {
    name: 'a grep search mentioning /api/mcp and requests. is ALLOWED (not payload-blind)',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { command: t("grep -rn 'requests.post.*api/mcp' docs/") },
    },
  },
  {
    name: 'an UNRELATED tool with an epic-portal-adjacent-looking payload stays fail-OPEN (existing behavior preserved)',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'SomeUnrelatedTool',
      tool_input: { procedure: LEAKY_PROCEDURE_NAME, arguments: { procedure: LEAKY_PROCEDURE_NAME } },
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

// --- EasyPanel output-projection hook (PostToolUse) ------------------------
console.log('\neasypanel output-projection hook');

const OUTPUT_GUARD = path.join(__dirname, 'isola-easypanel-output-guard.js');

/** Assembled rather than written literally, same reasoning as FAKE_TOKEN
 * above — these are synthetic placeholders standing in for secret-shaped
 * fields, not real credential material, but this file should not itself
 * read as containing plausible-looking secrets. */
const FAKE = {
  password: t('fake_pw_', '9f8a2c1e'),
  token: t('fake_tok_', 'b7e4d901'),
  secret: t('fake_sec_', '3c8f5a20'),
  authorization: t('Bearer fake_', 'auth_11223344'),
  cookie: t('session=fake_', 'cookie_55667788'),
  env: { SOME_KEY: t('fake_env_', 'value_1') },
  environment: { OTHER_KEY: t('fake_env_', 'value_2') },
  connectionString: t('postgres://fake:', 'pw@host/db'),
  databaseUrl: t('postgres://fake2:', 'pw2@host/db'),
  privateKey: t('-----BEGIN FAKE KEY-----\n', 'not-a-real-key\n-----END FAKE KEY-----'),
  arbitraryUnknownField: 'should never survive projection either',
};

function runOutputGuard(payload) {
  const r = spawnSync(process.execPath, [OUTPUT_GUARD], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 20000,
  });
  let updatedToolOutput;
  try {
    const parsed = JSON.parse(r.stdout || '{}');
    updatedToolOutput = parsed.hookSpecificOutput && parsed.hookSpecificOutput.updatedToolOutput;
  } catch (_) {
    updatedToolOutput = undefined;
  }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', updatedToolOutput };
}

const SAFE_PLACEHOLDER_JSON = JSON.stringify({ status: 'output_withheld_pending_review' });

function containsAnyFakeSecret(obj) {
  const json = JSON.stringify(obj);
  return Object.values(FAKE).some((v) => json.includes(typeof v === 'string' ? v : JSON.stringify(v)));
}

const outputCases = [
  {
    name: 'not our tool -> no stdout, harness leaves original response untouched',
    check: () => {
      const r = runOutputGuard({ tool_name: 'SomeOtherTool', tool_input: {}, tool_response: { anything: 'here' } });
      return r.stdout.trim() === '' ? null : 'expected empty stdout, got: ' + r.stdout.slice(0, 100);
    },
  },
  {
    name: 'listProjects with an ORDINARY OBJECT tool_response containing nested fake secrets: only name/createdAt survive, all FAKE.* values stripped',
    check: () => {
      const r = runOutputGuard({
        tool_name: 'mcp__epic-portal__execute_query',
        tool_input: { procedure: 'listProjects', input: {} },
        tool_response: {
          procedure: 'listProjects',
          result: [{ name: 'isola', createdAt: '2026-08-09T20:47:10.605Z', ...FAKE }],
        },
      });
      if (containsAnyFakeSecret(r.updatedToolOutput)) return 'a fake secret survived projection: ' + JSON.stringify(r.updatedToolOutput);
      const row = r.updatedToolOutput && r.updatedToolOutput.result && r.updatedToolOutput.result[0];
      if (!row || row.name !== 'isola' || Object.keys(row).length !== 2) return 'unexpected projected shape: ' + JSON.stringify(row);
      return null;
    },
  },
  {
    name: 'listProjects response as an MCP CONTENT-BLOCK ARRAY (JSON encoded inside text) is unwrapped and projected the same way',
    check: () => {
      const inner = JSON.stringify({ procedure: 'listProjects', result: [{ name: 'isola', createdAt: '2026-01-01T00:00:00Z', ...FAKE }] });
      const r = runOutputGuard({
        tool_name: 'mcp__epic-portal__execute_query',
        tool_input: { procedure: 'listProjects', input: {} },
        tool_response: [{ type: 'text', text: inner }],
      });
      if (containsAnyFakeSecret(r.updatedToolOutput)) return 'a fake secret survived content-block projection';
      const row = r.updatedToolOutput && r.updatedToolOutput.result && r.updatedToolOutput.result[0];
      if (!row || row.name !== 'isola') return 'content-block shape was not correctly unwrapped/projected';
      return null;
    },
  },
  {
    name: 'listProjects response as tool_response.content (nested content-block array) is unwrapped correctly',
    check: () => {
      const inner = JSON.stringify({ procedure: 'listProjects', result: [{ name: 'isola', createdAt: '2026-01-01T00:00:00Z' }] });
      const r = runOutputGuard({
        tool_name: 'mcp__epic-portal__execute_query',
        tool_input: { procedure: 'listProjects', input: {} },
        tool_response: { content: [{ type: 'text', text: inner }] },
      });
      const row = r.updatedToolOutput && r.updatedToolOutput.result && r.updatedToolOutput.result[0];
      return row && row.name === 'isola' ? null : 'nested .content array was not correctly unwrapped';
    },
  },
  {
    name: 'MALFORMED JSON inside a text content block FAILS CLOSED to the safe placeholder',
    check: () => {
      const r = runOutputGuard({
        tool_name: 'mcp__epic-portal__execute_query',
        tool_input: { procedure: 'listProjects', input: {} },
        tool_response: [{ type: 'text', text: '{"procedure":"listProjects","result":[{"name":' }],
      });
      return JSON.stringify(r.updatedToolOutput) === SAFE_PLACEHOLDER_JSON ? null : 'did not fail to the exact safe placeholder';
    },
  },
  {
    name: 'UNEXPECTED FIELDS on an otherwise-valid listProjects row are silently dropped, not passed through',
    check: () => {
      const r = runOutputGuard({
        tool_name: 'mcp__epic-portal__execute_query',
        tool_input: { procedure: 'listProjects', input: {} },
        tool_response: { procedure: 'listProjects', result: [{ name: 'isola', createdAt: '2026-01-01T00:00:00Z', someUnexpectedField: 'x' }] },
      });
      const row = r.updatedToolOutput && r.updatedToolOutput.result && r.updatedToolOutput.result[0];
      return row && !('someUnexpectedField' in row) ? null : 'unexpected field survived projection';
    },
  },
  {
    name: 'UNKNOWN/unreviewed procedure (e.g. listPorts) always returns the safe placeholder, even with a plausible-looking response',
    check: () => {
      const r = runOutputGuard({
        tool_name: 'mcp__epic-portal__execute_query',
        tool_input: { procedure: 'listPorts', input: { projectName: 'isola', serviceName: 'nocobase-db' } },
        tool_response: { procedure: 'listPorts', result: [{ port: 5432, ...FAKE }] },
      });
      return JSON.stringify(r.updatedToolOutput) === SAFE_PLACEHOLDER_JSON ? null : 'unreviewed procedure did not fall back to the safe placeholder';
    },
  },
  {
    name: 'a plain ARRAY tool_response (not the {procedure,result} shape, not content-blocks) FAILS CLOSED',
    check: () => {
      const r = runOutputGuard({
        tool_name: 'mcp__epic-portal__execute_query',
        tool_input: { procedure: 'listProjects', input: {} },
        tool_response: ['not', 'a', 'recognized', 'shape'],
      });
      return JSON.stringify(r.updatedToolOutput) === SAFE_PLACEHOLDER_JSON ? null : 'unrecognized array shape did not fail closed';
    },
  },
  {
    name: 'MALFORMED HOOK STDIN (not valid JSON at all) FAILS CLOSED without crashing',
    check: () => {
      const r = spawnSync(process.execPath, [OUTPUT_GUARD], { input: '{not valid json at all', encoding: 'utf8', timeout: 20000 });
      let updatedToolOutput;
      try {
        updatedToolOutput = JSON.parse(r.stdout || '{}').hookSpecificOutput.updatedToolOutput;
      } catch (_) {
        return 'hook crashed or produced no parseable output on malformed stdin: exit=' + r.status;
      }
      return JSON.stringify(updatedToolOutput) === SAFE_PLACEHOLDER_JSON ? null : 'malformed stdin did not fail to the safe placeholder';
    },
  },
  {
    name: 'a PROJECTOR EXCEPTION (result is not an array where one is required) FAILS CLOSED, does not crash the hook',
    check: () => {
      const r = runOutputGuard({
        tool_name: 'mcp__epic-portal__execute_query',
        tool_input: { procedure: 'listProjects', input: {} },
        tool_response: { procedure: 'listProjects', result: { not: 'an array' } },
      });
      if (r.status !== 0) return 'hook exited non-zero instead of failing closed cleanly: ' + r.status;
      return JSON.stringify(r.updatedToolOutput) === SAFE_PLACEHOLDER_JSON ? null : 'projector exception did not fail to the safe placeholder';
    },
  },
  {
    name: 'RESPONSE PROCEDURE MISMATCH (response claims a different procedure than requested) FAILS CLOSED',
    check: () => {
      const r = runOutputGuard({
        tool_name: 'mcp__epic-portal__execute_query',
        tool_input: { procedure: 'listProjects', input: {} },
        tool_response: { procedure: 'listPorts', result: [{ name: 'isola', createdAt: '2026-01-01T00:00:00Z' }] },
      });
      return JSON.stringify(r.updatedToolOutput) === SAFE_PLACEHOLDER_JSON ? null : 'mismatched response procedure did not fail closed';
    },
  },
  {
    name: 'listProjects row with a value FAILING the name/timestamp pattern is BLOCKED, not passed through merely for occupying an allowed field',
    check: () => {
      const r = runOutputGuard({
        tool_name: 'mcp__epic-portal__execute_query',
        tool_input: { procedure: 'listProjects', input: {} },
        tool_response: { procedure: 'listProjects', result: [{ name: 'not a valid $$$ name', createdAt: '2026-01-01T00:00:00Z' }] },
      });
      return JSON.stringify(r.updatedToolOutput) === SAFE_PLACEHOLDER_JSON ? null : 'an out-of-pattern value was not rejected';
    },
  },
  {
    name: 'listProjects row count exceeding the bound is BLOCKED',
    check: () => {
      const r = runOutputGuard({
        tool_name: 'mcp__epic-portal__execute_query',
        tool_input: { procedure: 'listProjects', input: {} },
        tool_response: {
          procedure: 'listProjects',
          result: Array.from({ length: 101 }, (_, i) => ({ name: 'proj-' + i, createdAt: '2026-01-01T00:00:00Z' })),
        },
      });
      return JSON.stringify(r.updatedToolOutput) === SAFE_PLACEHOLDER_JSON ? null : 'an unbounded row count was not rejected';
    },
  },

  // -- PROTOTYPE-CHAIN ADVERSARIAL PROCEDURE NAMES (owner-directed, critical) --
  // Every one of these must return ONLY the safe placeholder - never a raw
  // result, never a passthrough - even with a superficially plausible
  // response attached.
  ...['constructor', '__proto__', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__', '__defineSetter__'].map((evilProcedure) => ({
    name: `adversarial procedure "${evilProcedure}" on the output side always returns the safe placeholder, never a raw result`,
    check: () => {
      const r = runOutputGuard({
        tool_name: 'mcp__epic-portal__execute_query',
        tool_input: { procedure: evilProcedure, input: {} },
        tool_response: { procedure: evilProcedure, result: [{ name: 'isola', createdAt: '2026-01-01T00:00:00Z', ...FAKE }] },
      });
      if (containsAnyFakeSecret(r.updatedToolOutput)) return 'a fake secret survived via an adversarial procedure name';
      return JSON.stringify(r.updatedToolOutput) === SAFE_PLACEHOLDER_JSON ? null : `procedure="${evilProcedure}" did not fail to the exact safe placeholder`;
    },
  })),

  // -- CANARY: nothing leaks anywhere on a malformed-JSON failure path --
  {
    name: 'a fake canary positioned before a JSON parse failure never reaches stdout, stderr, or any log/state file (no persistent logging exists in this hook at all)',
    check: () => {
      const stateDir = path.join(__dirname, '..', 'state');
      let before = new Set();
      try { before = new Set(fs.readdirSync(stateDir)); } catch (_) {}

      const canary = t('CANARY_', 'FAKE_SECRET_', '7e2f9b1a');
      const malformedText = '{"procedure":"listProjects","canary":"' + canary + '","result":[{"name":';
      const r = runOutputGuard({
        tool_name: 'mcp__epic-portal__execute_query',
        tool_input: { procedure: 'listProjects', input: {} },
        tool_response: [{ type: 'text', text: malformedText }],
      });

      if (r.stdout.includes(canary)) return 'canary leaked into stdout';
      if (r.stderr.includes(canary)) return 'canary leaked into stderr';

      let after = [];
      try { after = fs.readdirSync(stateDir); } catch (_) {}
      for (const name of after) {
        const full = path.join(stateDir, name);
        try {
          const stat = fs.statSync(full);
          if (stat.isFile()) {
            const content = fs.readFileSync(full, 'utf8');
            if (content.includes(canary)) return 'canary leaked into state file: ' + name;
          }
        } catch (_) { /* directories, permission edge cases - not the target of this check */ }
      }

      if (JSON.stringify(r.updatedToolOutput).includes(canary)) return 'canary leaked into the sanitized output';
      return JSON.stringify(r.updatedToolOutput) === SAFE_PLACEHOLDER_JSON ? null : 'malformed-with-canary case did not fail to the exact safe placeholder';
    },
  },
];

for (const c of outputCases) {
  let failure;
  try {
    failure = c.check();
  } catch (e) {
    failure = 'test threw: ' + e.message;
  }
  const ok = !failure;
  if (!ok) failed++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + c.name + (ok ? '' : '\n          ' + failure));
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

console.log('\n' + (failed ? failed + ' FAILURE(S)' : 'all ' + (cases.length + stopCases.length + outputCases.length) + ' checks passed'));
process.exit(failed ? 1 : 0);
