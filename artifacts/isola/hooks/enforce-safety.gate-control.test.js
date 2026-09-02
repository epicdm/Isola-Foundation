/**
 * POSITIVE CONTROL for the 2026-08-19 tool gate in enforce-safety.js.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The gate stops the hook applying command rules to payloads that are not operations.
 * A relaxation without a control cannot distinguish "stopped over-blocking" from
 * "stopped blocking", and a guard that has silently stopped blocking is worse than no
 * guard, because it is trusted. So this asserts BOTH directions in one run:
 *
 *   STILL BLOCKS  — genuinely destructive shell commands, and destructive file writes.
 *   NO LONGER OVER-BLOCKS — a register payload carrying the exact same text passes.
 *
 * NOTHING HERE EXECUTES A COMMAND. Every case is a JSON payload piped to the hook, and
 * the only thing measured is the hook's exit code. The destructive strings never reach
 * a shell.
 *
 * Destructive tokens are composed from character arrays, which is the convention the
 * existing enforce-safety.test.js already uses — a test for a guard has to contain the
 * strings the guard matches, or it cannot test anything.
 *
 * Run: node artifacts/isola/hooks/enforce-safety.gate-control.test.js
 *      HOOK=/path/to/enforce-safety.js node ...   (to test a different copy)
 */
const { spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const HOOK = process.env.HOOK || path.join(os.homedir(), ".claude", "hooks", "enforce-safety.js");

// Composed, never literal — see the header.
const D = ["d", "o", "c", "k", "e", "r"].join("");
const STOP = ["s", "t", "o", "p"].join("");
const RMCMD = ["r", "m"].join("");
const DROP = ["d", "r", "o", "p"].join("");
const DEL = ["d", "e", "l", "e", "t", "e"].join("");
const LIB = ["l", "i", "b", "e", "r", "a", "r"].join("");
const DEST = ["d", "e", "s", "t", "r", "o", "y"].join("");
const SENT = ["r", "u", "n", "r", "a", "w", "p", "s", "q", "l"].join("");

function run(toolName, toolInput) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: "utf8",
  }).status;
}

let pass = 0, fail = 0;
function expect(label, actual, wanted) {
  const ok = actual === wanted;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}  (exit ${actual}, wanted ${wanted})`);
}
const BLOCK = 2, ALLOW = 0;

const bash = (c) => run("Bash", { command: c });
const write = (c) => run("Write", { file_path: "/tmp/x", content: c });
// The shape that was blocked twice on 2026-08-19: a register write whose PROSE described
// operations it never performed.
const port = (text) =>
  run("mcp__claude_ai_Port_IO__upsert_entity", {
    blueprintIdentifier: "decision",
    entity: { identifier: "control-case", properties: { description: text } },
  });

const TEARDOWN = `${D} ${STOP} prod-bff`;
const RECURSIVE = `${RMCMD} -rf /opt/bff-v2`;
const DDL = `${DROP} table customers`;
const UNSCOPED = `${DEL} from users`;
const DOCTRINE = `${LIB}, not ${DEST}`;

console.log(`HOOK UNDER TEST: ${HOOK}\n`);

console.log("STILL BLOCKS — a shell invocation is an operation:");
expect("container teardown", bash(TEARDOWN), BLOCK);
expect("recursive remove on a protected path", bash(RECURSIVE), BLOCK);
expect("destructive DDL", bash(DDL), BLOCK);
expect("unscoped row removal", bash(UNSCOPED), BLOCK);

// 2026-08-20 — SUPERSEDED IN ONE DIRECTION, BY OWNER DECISION (Packet 5M-RR).
//
// This section used to assert that writing teardown into a file BLOCKS. That decision
// cost the estate its ability to write an operator runbook: a twenty-step migration
// procedure could not be saved, because its fenced examples quote the verbs the operator
// must type. A control that forbids its own documentation makes the estate less safe.
//
// The teardown rule is now executionOnly. The line below is INVERTED rather than deleted,
// so the change is visible to whoever reads this file next instead of looking like
// coverage that quietly evaporated.
//
// NOTHING WAS GIVEN UP. The protection moved to the execution boundary and is re-asserted
// immediately below: writing the script is allowed, RUNNING it is not. And the recursive
// remove case is deliberately unchanged — it still blocks on a file write, which is the
// control proving only ONE rule changed scope rather than file writes being exempted.
console.log("A WRITTEN FILE IS NOT AN EXECUTION — but only for the rule whose danger is the running:");
expect("teardown written into a file is now ALLOWED (executionOnly)", write(TEARDOWN), ALLOW);
expect("NARROWNESS CONTROL: recursive remove written into a file still BLOCKS", write(RECURSIVE), BLOCK);

console.log("THE PROTECTION MOVED, IT DID NOT VANISH — running the written script is refused:");
{
  const fs2 = require("fs");
  const os2 = require("os");
  const path2 = require("path");
  const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), "gatectl-"));
  const script = path2.join(dir, "cleanup.sh").replace(/\\/g, "/");
  fs2.writeFileSync(script, "#!/bin/sh\n" + TEARDOWN + "\n");
  expect("running the script whose contents hold the teardown", bash("sh " + script), BLOCK);
  try { fs2.unlinkSync(script); fs2.rmdirSync(dir); } catch (e) {}
}

console.log("NO LONGER OVER-BLOCKS — a register entry is a record, not an operation:");
expect("register prose naming a teardown", port(`We decided NOT to run ${TEARDOWN}.`), ALLOW);
expect("register prose naming a recursive remove", port(`Never ${RECURSIVE} on this host.`), ALLOW);
expect("register prose naming destructive DDL", port(`A ${DDL} would be catastrophic here.`), ALLOW);
expect("register prose naming unscoped removal", port(`${UNSCOPED} with no WHERE is forbidden.`), ALLOW);

console.log("NO LONGER OVER-BLOCKS — the two payloads that were blocked on 2026-08-19:");
// Instance 2: a decision entity that PROPOSED PRESERVATION, quoting the doctrine phrase.
expect("decision entity quoting the doctrine phrase", port(`D4 stands. ${DOCTRINE}.`), ALLOW);
// Instance 1 shape: an entity documenting the hook, quoting the removed sentinel token.
expect("entity quoting the removed sentinel token", port(`The rule matched /${SENT}/.`), ALLOW);

console.log("SENTINEL RULE REMOVED — its token no longer blocks anything, anywhere:");
expect("sentinel token in a shell command", bash(`echo ${SENT}`), ALLOW);
expect("sentinel token in a file", write(`# ${SENT}\n`), ALLOW);

console.log("UNCHANGED — the doctrine rule still applies to real shell invocations:");
// Deliberately NOT relaxed. The rule remains vocabulary-bound, which is its own open
// question, but it is out of scope here: this change moved WHERE rules apply, never
// WHAT they say.
expect("doctrine phrase in a shell command", bash(`echo ${DOCTRINE}`), BLOCK);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
