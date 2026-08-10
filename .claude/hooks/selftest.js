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
const os = require('os');
const crypto = require('crypto');

const GUARD = path.join(__dirname, 'isola-guard.js');
const STOP = path.join(__dirname, 'isola-stop-gate.js');

// Every guard/stop-gate child process spawned below inherits process.env by
// default (spawnSync's documented behavior when no env option is passed).
// Pointing ISOLA_GUARD_STATE_DIR at a disposable mkdtemp directory before any
// case runs means every write this run makes - guard.log, session ledgers -
// lands there instead of the real workspace .claude/state. The real
// directory is snapshotted before this is set and re-checked identical after
// the full suite completes, so isolation is proven, not just assumed.
const REAL_STATE_DIR = path.join(__dirname, '..', 'state');

/**
 * Recursively walks a directory and returns a Map<relativePath, entry>
 * covering every file, subdirectory, and other entry type found - not just
 * guard.log, not just top-level names. Each file entry carries its size and
 * a SHA-256 of its actual bytes, so "unchanged" means byte-for-byte, not
 * merely same-size or same-filename. File CONTENT is read only to hash it
 * and is never retained, printed, or parsed - the buffer goes out of scope
 * once the digest is computed.
 */
function snapshotDirectoryTree(rootDir) {
  const entries = new Map();
  function walk(dir, rel) {
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return; // directory does not exist yet - trivially empty
    }
    for (const dirent of dirents) {
      const abs = path.join(dir, dirent.name);
      const relPath = rel ? rel + '/' + dirent.name : dirent.name;
      if (dirent.isDirectory()) {
        entries.set(relPath, { type: 'dir' });
        walk(abs, relPath);
      } else if (dirent.isFile()) {
        try {
          const buf = fs.readFileSync(abs);
          entries.set(relPath, { type: 'file', size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
        } catch (_) {
          entries.set(relPath, { type: 'file', size: null, sha256: null }); // unreadable still counts as a tracked entry
        }
      } else {
        entries.set(relPath, { type: 'other' });
      }
    }
  }
  walk(rootDir, '');
  return entries;
}

/** Exact equality over two snapshots: same set of relative paths, and for
 * every file entry, the same type/size/sha256. Comparison happens entirely
 * over hash strings already held in memory - never re-reads either
 * directory, never prints a hash or a path. */
function directoryTreesIdentical(before, after) {
  if (before.size !== after.size) return false;
  for (const [relPath, beforeEntry] of before) {
    const afterEntry = after.get(relPath);
    if (!afterEntry) return false;
    if (beforeEntry.type !== afterEntry.type) return false;
    if (beforeEntry.type === 'file' && (beforeEntry.size !== afterEntry.size || beforeEntry.sha256 !== afterEntry.sha256)) return false;
  }
  return true;
}

/** Recursively scans every file under rootDir for a literal substring,
 * without ever printing a path or file content - returns only a boolean. */
function anyFileContains(rootDir, needle) {
  const tree = snapshotDirectoryTree(rootDir); // re-walked fresh; only used to enumerate file paths here
  for (const [relPath, entry] of tree) {
    if (entry.type !== 'file') continue;
    try {
      if (fs.readFileSync(path.join(rootDir, relPath), 'utf8').includes(needle)) return true;
    } catch (_) {
      /* unreadable/binary - not a text leak by definition */
    }
  }
  return false;
}

const realStateBefore = snapshotDirectoryTree(REAL_STATE_DIR);
const DISPOSABLE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'isola-guard-selftest-'));
process.env.ISOLA_GUARD_STATE_DIR = DISPOSABLE_STATE_DIR;

// Node's 'exit' event fires synchronously immediately before the process
// actually terminates - including after an uncaught exception - so this is
// the finally-equivalent for a top-level script with no single enclosing
// try block. rmSync must stay synchronous here; 'exit' handlers cannot await.
process.on('exit', () => {
  try {
    fs.rmSync(DISPOSABLE_STATE_DIR, { recursive: true, force: true });
  } catch (_) {
    /* best-effort cleanup only */
  }
});

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

/** Fake canary for the PreToolUse logging test below - synthetic, never a
 * real secret. */
const PRETOOLUSE_CANARY = t('PRETOOLUSE_CANARY_', 'FAKE_9d3e7a1c');
/** Fake canary for the PostToolUse malformed-input logging test below -
 * hoisted to module scope so the final recursive disposable-directory scan
 * (which runs after both hook loops complete) can check for it too, not
 * just PRETOOLUSE_CANARY. */
const POSTTOOLUSE_MALFORMED_CANARY = t('CANARY_', 'FAKE_SECRET_', '7e2f9b1a');

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

  // -- listPorts / listMounts / getComposeDockerServices: REMOVED from the
  // executable set (owner review, 2026-08-10) - not a matter of input shape
  // anymore, the procedure itself is no longer in the allowlist at all. Each
  // proven BLOCKED even with a perfectly well-formed, previously-valid input,
  // to show this isn't an input-predicate rejection but a procedure-level one.
  {
    name: 'listPorts is BLOCKED outright even with a well-formed, previously-valid input (removed from the executable set)',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'listPorts', input: { projectName: 'isola', serviceName: 'nocobase-db' } },
    },
  },
  {
    name: 'listMounts is BLOCKED outright even with a well-formed, previously-valid input (removed from the executable set)',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'listMounts', input: { projectName: 'isola', serviceName: 'nocobase' } },
    },
  },
  {
    name: 'getComposeDockerServices is BLOCKED outright even with a well-formed, previously-valid input (removed from the executable set)',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: { procedure: 'getComposeDockerServices', input: { projectName: 'isola', serviceName: 'nocobase' } },
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
  // -- raw bypass shape 2: URL-bearing tool inputs (WebFetch and anything
  //    like it). These tools ARE the network client, so they name no client
  //    in their payload and structurally cannot match HTTP_INVOCATION_RE.
  //    Confirmed live before this fix: WebFetch with tool_input.url set to the
  //    EasyPanel /api/mcp endpoint returned exit 0 (allowed) while the
  //    equivalent Bash curl was correctly blocked. The `cmd` argument only
  //    ever receives tool_input.command || tool_input.script, so .url was
  //    never read at all.
  {
    name: 'WebFetch tool_input.url to the exact /api/mcp endpoint is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'WebFetch',
      tool_input: { url: 'https://portal.saas00.epic.dm/api/mcp', prompt: 'summarize' },
    },
  },
  {
    name: 'WebFetch url with a query-string variant of /api/mcp is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'WebFetch',
      tool_input: { url: 'https://portal.saas00.epic.dm/api/mcp?debug=1', prompt: 'x' },
    },
  },
  {
    name: 'WebFetch url with a trailing-slash variant of /api/mcp/ is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'WebFetch',
      tool_input: { url: 'https://portal.saas00.epic.dm/api/mcp/', prompt: 'x' },
    },
  },
  {
    name: 'WebFetch url to a direct-IP /api/mcp is BLOCKED (host-agnostic, same as the command rule)',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'WebFetch',
      tool_input: { url: 'https://66.118.37.110/api/mcp', prompt: 'x' },
    },
  },
  {
    name: 'WebFetch url to an alternate host / proxy fronting /api/mcp is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'WebFetch',
      tool_input: { url: 'https://some-other-proxy.example.com/api/mcp', prompt: 'x' },
    },
  },
  {
    name: 'WebFetch url to /api/rpc is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'WebFetch',
      tool_input: { url: 'https://portal.saas00.epic.dm/api/rpc', prompt: 'x' },
    },
  },
  {
    name: 'WebFetch url to a /api/trpc/... procedure path is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'WebFetch',
      tool_input: { url: t('https://portal.saas00.epic.dm/api/trpc/projects.', 'listProjects'), prompt: 'x' },
    },
  },
  {
    name: 'plain http:// (not https) to /api/mcp in a url field is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'WebFetch',
      tool_input: { url: 'http://portal.saas00.epic.dm/api/mcp', prompt: 'x' },
    },
  },
  {
    name: 'the `uri` key variant carrying the endpoint is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'SomeFetchingTool',
      tool_input: { uri: 'https://portal.saas00.epic.dm/api/mcp' },
    },
  },
  {
    name: 'the `endpoint` key variant carrying the endpoint is BLOCKED',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'SomeFetchingTool',
      tool_input: { endpoint: 'https://portal.saas00.epic.dm/api/mcp' },
    },
  },
  {
    // The check is on the FIELD SHAPE, not on a tool-name list — a name list
    // goes stale the moment a new fetch-capable tool appears.
    name: 'an UNKNOWN, never-seen tool name carrying the endpoint in `url` is BLOCKED (field-shape, not tool-name, based)',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'mcp__some__future_fetch_tool',
      tool_input: { url: 'https://portal.saas00.epic.dm/api/mcp' },
    },
  },
  {
    name: 'Bash tool_input.script (not .command) reaching /api/mcp is BLOCKED (both command-text fields covered)',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    payload: {
      session_id: SID,
      tool_name: 'Bash',
      tool_input: { script: 'curl -s https://portal.saas00.epic.dm/api/mcp -d \'{}\'' },
    },
  },

  // -- negative controls for shape 2: the fix must not become a blanket ban
  //    on the host, on URLs generally, or on records that merely cite the
  //    endpoint.
  {
    name: 'WebFetch to an unrelated public URL is ALLOWED',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'WebFetch',
      tool_input: { url: 'https://github.com/epicdm/Isola-Foundation/pull/96', prompt: 'x' },
    },
  },
  {
    name: 'WebFetch to a NON-MCP path on the same EasyPanel host is ALLOWED (path-scoped, not host-scoped)',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'WebFetch',
      tool_input: { url: 'https://portal.saas00.epic.dm/api/health', prompt: 'x' },
    },
  },
  {
    name: 'a path that merely BEGINS with /api/mcp but continues (/api/mcpx) is ALLOWED (delimiter-bounded)',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'WebFetch',
      tool_input: { url: 'https://portal.saas00.epic.dm/api/mcpx', prompt: 'x' },
    },
  },
  {
    // Exact keys, not a suffix match: source_url on a data-record tool is
    // metadata being STORED, not an endpoint being CALLED. Gating it would
    // false-positive on the very Port records that document this policy.
    name: 'a `source_url` METADATA field citing the endpoint on a record tool is ALLOWED (exact-key bound)',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'mcp__claude_ai_Port_IO__upsert_entity',
      tool_input: {
        blueprintIdentifier: 'evidence',
        entity: { properties: { source_url: 'https://portal.saas00.epic.dm/api/mcp' } },
      },
    },
  },
  {
    name: 'a url field WITHOUT an http(s) scheme containing the path is ALLOWED (scheme required)',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'WebFetch',
      tool_input: { url: 'docs/isola/notes-about-api-mcp/api/mcp' },
    },
  },
  {
    name: 'a non-string url field is ALLOWED and does not throw (no fail-closed on an unrelated tool)',
    expect: PASS,
    payload: {
      session_id: SID,
      tool_name: 'SomeUnrelatedTool',
      tool_input: { url: { nested: 'https://portal.saas00.epic.dm/api/mcp' } },
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
  {
    // PreToolUse canary: a fake secret positioned immediately before a
    // malformed-JSON parse failure inside resolveInputObject(). Confirms
    // the fixed-event-code logging fix - no e.message derived from this
    // payload should ever reach stdout or stderr.
    name: 'PreToolUse: a fake canary immediately before a malformed-serialized-input parse failure never reaches stdout or stderr',
    expect: BLOCK,
    contains: 'easypanel-not-allowlisted',
    notContains: PRETOOLUSE_CANARY,
    payload: {
      session_id: SID,
      tool_name: 'mcp__epic-portal__execute_query',
      tool_input: {
        procedure: 'listProjects',
        input: '{"canary":"' + PRETOOLUSE_CANARY + '","unterminated":',
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

// The comprehensive recursive canary scan and the real-state-unchanged
// comparison both run once, at the very end of the file, after every hook
// (PreToolUse cases, stop-gate cases, and the PostToolUse output-guard
// cases) has had a chance to write - see "disposable-directory integrity"
// below. A single check there covers all of it, rather than partial
// mid-run checks that would miss writes from later loops.
{
  const ok = fs.readdirSync(DISPOSABLE_STATE_DIR).length > 0;
  if (!ok) failed++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'the disposable state directory actually received writes this run (proves the override is live, not merely unused)');
}

// --- Permission-system backstop (settings.json) -----------------------------
console.log('\npermission-system backstop (settings.json)');
{
  const settingsPath = path.join(__dirname, '..', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const deny = (settings.permissions && settings.permissions.deny) || [];
  const ask = (settings.permissions && settings.permissions.ask) || [];
  const allow = (settings.permissions && settings.permissions.allow) || [];

  const settingsChecks = [
    { name: 'deny contains mcp__epic-portal__execute_mutation', ok: deny.includes('mcp__epic-portal__execute_mutation') },
    { name: 'deny contains mcp__epic-portal__execute_destructive', ok: deny.includes('mcp__epic-portal__execute_destructive') },
    { name: 'ask contains mcp__epic-portal__* (forces approval for every epic-portal call)', ok: ask.includes('mcp__epic-portal__*') },
    {
      name: 'allow contains NO mcp__epic-portal__* rule (no MCP allow rule added, as instructed)',
      ok: !allow.some((r) => r.startsWith('mcp__epic-portal')),
    },
  ];
  for (const c of settingsChecks) {
    if (!c.ok) failed++;
    console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.name);
  }
  console.log(
    '  NOTE  parameterized per-procedure deny rules (e.g. execute_query(procedure:listPorts)) are rejected by the ' +
      'installed Claude Code 2.1.225 binary specifically for MCP tool rules - reproduced live via `claude doctor` ' +
      'against a disposable settings.json, exact error: "MCP rules do not support patterns in parentheses. Use ' +
      '\\"mcp__epic-portal__execute_query\\" without parentheses, or use \\"mcp__epic-portal__*\\" for all tools." ' +
      'This is unsupported by the installed version, not a general/universal impossibility - a future Claude Code ' +
      'release could lift this MCP-specific restriction and should be re-probed the same way before relying on it. ' +
      'Per-procedure enforcement remains the hook\'s (isola-guard.js) responsibility; the permission system backstops ' +
      'only at the whole-tool level (execute_mutation/execute_destructive denied outright, every epic-portal call ' +
      'requires approval).'
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

/**
 * Wire contract (found live via the owner fixture, not unit tests): for an
 * MCP tool, updatedToolOutput must be an array of content blocks
 * ([{type:'text', text}]) — a bare object is applied by Claude Code and then
 * crashes its content-block accounting (`e.reduce is not a function`),
 * leaving the model an infrastructure error instead of the projection.
 * This helper asserts that exact wire shape on every successful emit, then
 * unwraps the single block's text back to the projection object so the
 * individual cases below compare against the logical value. A wrong wire
 * shape leaves updatedToolOutput undefined, failing every dependent case
 * loudly rather than silently unwrapping something unexpected.
 */
function runOutputGuard(payload) {
  const r = spawnSync(process.execPath, [OUTPUT_GUARD], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 20000,
  });
  let updatedToolOutput;
  let wireShapeOk = false;
  try {
    const parsed = JSON.parse(r.stdout || '{}');
    const raw = parsed.hookSpecificOutput && parsed.hookSpecificOutput.updatedToolOutput;
    if (
      Array.isArray(raw) &&
      raw.length === 1 &&
      raw[0] &&
      raw[0].type === 'text' &&
      typeof raw[0].text === 'string'
    ) {
      wireShapeOk = true;
      updatedToolOutput = JSON.parse(raw[0].text);
    }
  } catch (_) {
    updatedToolOutput = undefined;
  }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', updatedToolOutput, wireShapeOk };
}

const SAFE_PLACEHOLDER_JSON = JSON.stringify({ status: 'output_withheld_pending_review' });

function containsAnyFakeSecret(obj) {
  const json = JSON.stringify(obj);
  return Object.values(FAKE).some((v) => json.includes(typeof v === 'string' ? v : JSON.stringify(v)));
}

const outputCases = [
  // -- wire shape (the contract the owner fixture caught being violated) --
  {
    name: 'updatedToolOutput is emitted as a SINGLE TEXT CONTENT BLOCK (the MCP wire shape), never a bare object',
    check: () => {
      const r = runOutputGuard({
        tool_name: 'mcp__epic-portal__execute_query',
        tool_input: { procedure: 'listProjects', input: {} },
        tool_response: { procedure: 'listProjects', result: [{ name: 'isola', createdAt: '2026-08-09T20:47:10.605Z' }] },
      });
      return r.wireShapeOk ? null : 'wire shape was not a single {type:"text", text:string} content block: ' + r.stdout.slice(0, 200);
    },
  },
  // -- delivery reliability (bounds, and repeated-execution parseability) --
  {
    // Precisely calibrated against the real 8192-char/byte bound: 50 rows of
    // max-length (100-char) names serializes to exactly 8097 chars/bytes -
    // genuinely near the 8192 limit (within 95 bytes), not merely "some
    // substantial size". Computed directly (not guessed) before writing
    // this test, using the exact content-block envelope emit() produces.
    name: 'a NEAR-LIMIT valid listProjects projection (8097 of 8192 bytes/chars) is emitted in full, not placeholdered',
    check: () => {
      const longName = 'a'.repeat(100);
      const rows = Array.from({ length: 50 }, () => ({ name: longName, createdAt: '2026-01-01T00:00:00.000Z' }));
      const r = runOutputGuard({
        tool_name: 'mcp__epic-portal__execute_query',
        tool_input: { procedure: 'listProjects', input: {} },
        tool_response: { procedure: 'listProjects', result: rows },
      });
      if (JSON.stringify(r.updatedToolOutput) === SAFE_PLACEHOLDER_JSON) {
        return 'a near-limit (8097-byte) valid projection was incorrectly placeholdered';
      }
      const actualBytes = Buffer.byteLength(r.stdout, 'utf8');
      if (actualBytes > 8192) return `near-limit case actually exceeded the bound: ${actualBytes} bytes of stdout`;
      return Array.isArray(r.updatedToolOutput && r.updatedToolOutput.result) && r.updatedToolOutput.result.length === 50
        ? null
        : 'near-limit projection did not come through with the expected row count';
    },
  },
  {
    // One row more than the near-limit case - 51 rows serializes to 8256
    // chars/bytes, definitively over 8192. This MUST produce the exact safe
    // placeholder - a full/partial projection is not an acceptable outcome
    // here, unlike the earlier, looser version of this test.
    name: 'an OVER-LIMIT projection (8256 of 8192 bytes/chars) REQUIRES the exact safe placeholder, not a truncated or full response',
    check: () => {
      const longName = 'a'.repeat(100);
      const rows = Array.from({ length: 51 }, () => ({ name: longName, createdAt: '2026-01-01T00:00:00.000Z' }));
      const r = runOutputGuard({
        tool_name: 'mcp__epic-portal__execute_query',
        tool_input: { procedure: 'listProjects', input: {} },
        tool_response: { procedure: 'listProjects', result: rows },
      });
      return JSON.stringify(r.updatedToolOutput) === SAFE_PLACEHOLDER_JSON
        ? null
        : 'over-limit case did not produce the exact safe placeholder - got: ' + JSON.stringify(r.updatedToolOutput).slice(0, 100);
    },
  },
  {
    name: 'SAFE_PLACEHOLDER itself serializes well under both the 8192-char and 8192-byte bounds',
    check: () => {
      const r = runOutputGuard({
        tool_name: 'mcp__epic-portal__execute_query',
        tool_input: { procedure: 'listProjects', input: {} },
        tool_response: { procedure: 'listProjects', result: 'not-an-array-forces-placeholder' },
      });
      const chars = r.stdout.length;
      const bytes = Buffer.byteLength(r.stdout, 'utf8');
      return chars <= 8192 && bytes <= 8192 ? null : `placeholder stdout exceeded bounds: chars=${chars} bytes=${bytes}`;
    },
  },
  {
    name: 'OVERSIZED STDIN (beyond the 2 MiB input bound) FAILS CLOSED to the safe placeholder',
    check: () => {
      const hugePadding = 'x'.repeat(3 * 1024 * 1024); // 3 MiB, over the 2 MiB bound
      const r = spawnSync(process.execPath, [OUTPUT_GUARD], {
        input: JSON.stringify({
          tool_name: 'mcp__epic-portal__execute_query',
          tool_input: { procedure: 'listProjects', input: {} },
          tool_response: { procedure: 'listProjects', result: [], padding: hugePadding },
        }),
        encoding: 'utf8',
        timeout: 20000,
        maxBuffer: 10 * 1024 * 1024,
      });
      let inner;
      try {
        const raw = JSON.parse(r.stdout || '{}').hookSpecificOutput.updatedToolOutput;
        inner = raw[0].text; // single-text-content-block wire shape
      } catch (_) {
        return 'hook crashed or produced no parseable output on oversized stdin: exit=' + r.status;
      }
      return inner === SAFE_PLACEHOLDER_JSON ? null : 'oversized stdin did not fail to the safe placeholder';
    },
  },
  {
    name: 'stdout is complete JSON, under Claude Code\'s 10,000-char cap AND the configured 8192 bound, across 20 repeated child-process executions',
    check: () => {
      const CLAUDE_CODE_DOCUMENTED_CAP = 10000;
      for (let i = 0; i < 20; i++) {
        const r = runOutputGuard({
          tool_name: 'mcp__epic-portal__execute_query',
          tool_input: { procedure: 'listProjects', input: {} },
          tool_response: { procedure: 'listProjects', result: [{ name: 'isola', createdAt: '2026-08-09T20:47:10.605Z' }] },
        });
        let parsed;
        try {
          parsed = JSON.parse(r.stdout);
        } catch (e) {
          return `run ${i}: stdout was not complete/parseable JSON (${e.message.length} char parse error) - raw length ${r.stdout.length}`;
        }
        if (!parsed.hookSpecificOutput || parsed.hookSpecificOutput.updatedToolOutput === undefined) {
          return `run ${i}: parsed JSON was missing the expected hookSpecificOutput.updatedToolOutput shape`;
        }
        const chars = r.stdout.length;
        const bytes = Buffer.byteLength(r.stdout, 'utf8');
        if (chars >= CLAUDE_CODE_DOCUMENTED_CAP) return `run ${i}: stdout (${chars} chars) reached Claude Code's documented 10,000-char hook-output cap`;
        if (chars > 8192 || bytes > 8192) return `run ${i}: stdout exceeded the configured 8192 bound: chars=${chars} bytes=${bytes}`;
      }
      return null;
    },
  },
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
      let inner;
      try {
        const raw = JSON.parse(r.stdout || '{}').hookSpecificOutput.updatedToolOutput;
        inner = raw[0].text; // single-text-content-block wire shape
      } catch (_) {
        return 'hook crashed or produced no parseable output on malformed stdin: exit=' + r.status;
      }
      return inner === SAFE_PLACEHOLDER_JSON ? null : 'malformed stdin did not fail to the safe placeholder';
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
  // -- SEMANTIC CALENDAR VALIDATION of createdAt (owner-directed) --
  // Regex shape alone accepts impossible dates ("2026-02-30", "2026-13-01")
  // since \d{2} matches any two digits - these must be rejected by explicit
  // range/leap-year arithmetic, not merely structural pattern matching.
  ...[
    { label: 'invalid month (13)', createdAt: '2026-13-01T00:00:00Z' },
    { label: 'February 30 (no such day in any year)', createdAt: '2026-02-30T00:00:00Z' },
    { label: 'February 29 in a non-leap year (2026)', createdAt: '2026-02-29T00:00:00Z' },
    { label: 'invalid hour (24)', createdAt: '2026-01-01T24:00:00Z' },
    { label: 'invalid minute (60)', createdAt: '2026-01-01T00:60:00Z' },
    { label: 'invalid second (60)', createdAt: '2026-01-01T00:00:60Z' },
    { label: 'seven fractional-second digits (exceeds the 1-6 bound)', createdAt: '2026-01-01T00:00:00.1234567Z' },
  ].map(({ label, createdAt }) => ({
    name: `createdAt with ${label} is REJECTED to the safe placeholder, not silently normalized`,
    check: () => {
      const r = runOutputGuard({
        tool_name: 'mcp__epic-portal__execute_query',
        tool_input: { procedure: 'listProjects', input: {} },
        tool_response: { procedure: 'listProjects', result: [{ name: 'isola', createdAt }] },
      });
      return JSON.stringify(r.updatedToolOutput) === SAFE_PLACEHOLDER_JSON ? null : `"${createdAt}" was not rejected: ` + JSON.stringify(r.updatedToolOutput);
    },
  })),
  ...[
    { label: 'the reviewed real millisecond format (3 fractional digits)', createdAt: '2026-08-09T20:47:10.605Z' },
    { label: 'a valid leap day (2024-02-29, 2024 is a leap year)', createdAt: '2024-02-29T12:00:00Z' },
    { label: 'six fractional-second digits (the maximum allowed)', createdAt: '2026-01-01T00:00:00.123456Z' },
  ].map(({ label, createdAt }) => ({
    name: `createdAt with ${label} is ACCEPTED and passes through unchanged`,
    check: () => {
      const r = runOutputGuard({
        tool_name: 'mcp__epic-portal__execute_query',
        tool_input: { procedure: 'listProjects', input: {} },
        tool_response: { procedure: 'listProjects', result: [{ name: 'isola', createdAt }] },
      });
      const row = r.updatedToolOutput && r.updatedToolOutput.result && r.updatedToolOutput.result[0];
      return row && row.createdAt === createdAt ? null : `"${createdAt}" was not accepted as expected: ` + JSON.stringify(r.updatedToolOutput);
    },
  })),
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

  // -- CANARY: nothing leaks into stdout/stderr on a malformed-JSON failure
  // path. File-level leakage (this hook has no file-writing code path at
  // all - see its header) is covered by the single comprehensive recursive
  // scan of the whole disposable directory run after every case completes,
  // not duplicated here.
  {
    name: 'a fake canary positioned before a JSON parse failure never reaches stdout or stderr (no persistent logging exists in this hook at all)',
    check: () => {
      const malformedText = '{"procedure":"listProjects","canary":"' + POSTTOOLUSE_MALFORMED_CANARY + '","result":[{"name":';
      const r = runOutputGuard({
        tool_name: 'mcp__epic-portal__execute_query',
        tool_input: { procedure: 'listProjects', input: {} },
        tool_response: [{ type: 'text', text: malformedText }],
      });

      if (r.stdout.includes(POSTTOOLUSE_MALFORMED_CANARY)) return 'canary leaked into stdout';
      if (r.stderr.includes(POSTTOOLUSE_MALFORMED_CANARY)) return 'canary leaked into stderr';
      if (JSON.stringify(r.updatedToolOutput).includes(POSTTOOLUSE_MALFORMED_CANARY)) return 'canary leaked into the sanitized output';
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

// --- Disposable-directory integrity (runs once, after every hook above has
// had its chance to write - PreToolUse cases, stop-gate cases, and the
// PostToolUse output-guard cases) -------------------------------------------
console.log('\ndisposable-directory integrity');
{
  // Recursive - every file at every depth under DISPOSABLE_STATE_DIR, not
  // just guard.log, not just top-level entries. Content is read only to
  // test for substring containment; never printed, never retained past this
  // check, never written back anywhere.
  const preToolUseLeak = anyFileContains(DISPOSABLE_STATE_DIR, PRETOOLUSE_CANARY);
  const ok = !preToolUseLeak;
  if (!ok) failed++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'PRETOOLUSE_CANARY is absent from every file under the disposable state directory (recursive scan)');
}
{
  const postToolUseLeak = anyFileContains(DISPOSABLE_STATE_DIR, POSTTOOLUSE_MALFORMED_CANARY);
  const ok = !postToolUseLeak;
  if (!ok) failed++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'the PostToolUse malformed-input canary is absent from every file under the disposable state directory (recursive scan; expected trivially - this hook has no file-writing code path at all)');
}
{
  // Exact equality: same relative paths, same file sizes, same SHA-256 of
  // actual bytes, for the ENTIRE real state directory tree (guard.log and
  // the full sessions/ tree, at every depth) - compared only in memory,
  // hashes never printed. If this ever needs to fall back to a weaker
  // check, the claim below must be narrowed accordingly - "byte-for-byte"
  // is only asserted because this comparison is genuinely content-hash-based.
  const realStateAfter = snapshotDirectoryTree(REAL_STATE_DIR);
  const ok = directoryTreesIdentical(realStateBefore, realStateAfter);
  if (!ok) failed++;
  console.log(
    (ok ? '  PASS  ' : '  FAIL  ') +
      'the real .claude/state directory tree (guard.log and the full sessions/ tree, recursively) is byte-for-byte unchanged by this entire self-test run' +
      (ok ? '' : ` (entry count before=${realStateBefore.size} after=${realStateAfter.size} - see in-memory snapshots for detail; contents/hashes deliberately not printed here)`)
  );
}
{
  // Cleanup itself is registered via process.on('exit') so it always runs;
  // this proves the directory this run actually used is still present RIGHT
  // NOW (the exit handler hasn't fired yet) - a canary that the override
  // was pointed at a real, existing path throughout, not a dangling one.
  const ok = fs.existsSync(DISPOSABLE_STATE_DIR);
  if (!ok) failed++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'the disposable state directory used by this run still exists at this point (its removal happens in the process-exit handler, after this line)');
}

// No manual ledger cleanup needed: every write this run made landed under
// DISPOSABLE_STATE_DIR (never the real .claude/state/sessions), and that
// whole directory is removed by the process.on('exit') handler registered
// above regardless of how this script terminates.

const EXTRA_STANDALONE_CHECKS =
  4 /* disposable-dir-received-writes + 2x recursive canary scan + real-state-unchanged */ +
  1 /* disposable dir still exists pre-cleanup */ +
  4 /* settings.json backstop */;
console.log(
  '\n' +
    (failed
      ? failed + ' FAILURE(S)'
      : 'all ' + (cases.length + stopCases.length + outputCases.length + EXTRA_STANDALONE_CHECKS) + ' checks passed')
);
process.exit(failed ? 1 : 0);
