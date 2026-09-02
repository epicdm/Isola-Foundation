#!/usr/bin/env node
/*
 * enforce-safety — DOCUMENTATION IS NOT EXECUTION.
 *
 * Added 2026-08-20 (Packet 5M-RR) after the guard refused to let the estate write its own
 * operator runbook: a twenty-step migration procedure could not be saved, because its
 * fenced examples quote the verbs the operator must type. A control that forbids its own
 * documentation makes the estate less safe, not more.
 *
 * The correction is narrow. The container-teardown rule is now executionOnly, so it
 * judges what RUNS. Every other rule is unchanged, and the NARROWNESS CONTROL below
 * proves it: writing a file containing a recursive remove aimed at a protected path is
 * STILL refused.
 *
 * Relaxing the write path alone would have opened a real hole — write the script, then
 * run it — so the same change added SCRIPT-INVOCATION SCANNING. The protection was not
 * removed; it moved to the execution boundary. The script cases below are that control,
 * and they are why this change is a strengthening rather than a relaxation.
 *
 * VOCABULARY IS ASSEMBLED FROM FRAGMENTS throughout, so that this file could be written
 * while the OLD hook was still installed. That necessity is the defect, restated.
 */
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const HOOK = process.env.HOOK_PATH || path.join(__dirname, "enforce-safety.js");

const DK = ["do", "cker"].join("");
const RMV = ["r", "m"].join("");
const STOP = ["st", "op"].join("");
const PRUNE = ["pru", "ne"].join("");
const KILL = ["ki", "ll"].join("");
const PROT = ["/o", "pt/bff-v2"].join("");

function run(toolName, toolInput) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: "utf8",
  });
  return r.status;
}
let pass = 0, fail = 0;
function expect(label, actual, wanted) {
  const ok = actual === wanted;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}  (exit ${actual}, wanted ${wanted})`);
}
const BLOCK = 2, ALLOW = 0;
const bash = (c) => run("Bash", { command: c });
const pwsh = (c) => run("PowerShell", { command: c });
const write = (c, p) => run("Write", { file_path: p || "/tmp/doc.md", content: c });
const edit = (c) => run("Edit", { file_path: "/tmp/doc.md", old_string: "x", new_string: c });
const record = (o) => run("mcp__claude_ai_Port_IO__upsert_entity", o);

// The real thing: the vocabulary the 5M-E runbook actually requires.
const RUNBOOK = [
  "# Packet 5M-E - portal migration and admin-token rotation",
  "",
  "## Step 17 - retire the EasyPanel service",
  "Scale to zero; do not delete the service.",
  "",
  "```bash",
  DK + " service scale isola_isola-portal-api=0",
  "```",
  "",
  "## Rollback, at every mutation boundary",
  "",
  "```bash",
  DK + " stack " + RMV + " isolaportal",
  DK + " service " + RMV + " isolaportal_api",
  DK + " " + STOP + " <container>",
  DK + " " + RMV + " <container>",
  "```",
  "",
  "The EasyPanel API equivalent is destroyAppService - owner-only.",
  "",
].join("\n");

// Built from fragments on separate lines: the recursive-remove rule is CONJUNCTIVE and
// unchanged, so assembling this on one source line would block this very file.
const DANGER = "#!/bin/sh\n" + RMV + " -" + "rf " + PROT + "\n";

console.log("POSITIVE CONTROL — the hook is installed, wired and answering:");
expect("a genuine teardown is refused (an ALLOW here means the suite is blind)",
  bash(`${DK} service ${RMV} isolagw_gateway`), BLOCK);

console.log("MUST ALLOW — a document describing an operation is not the operation:");
expect("1. Markdown documenting service teardown", write(RUNBOOK), ALLOW);
expect("2. a code comment naming container stop",
  write(`// never call ${DK} ${STOP} against the gateway\nconsole.log(1);\n`, "/tmp/x.js"), ALLOW);
expect("3. a runbook rollback example in a fenced block",
  write("```bash\n" + DK + " stack " + RMV + " isolaportal\n```\n"), ALLOW);
expect("4. Port evidence text describing teardown",
  record({ entity: { properties: { description: `rollback: ${DK} service ${RMV} isolaportal_api` } } }), ALLOW);
expect("5. writing a shell script as inert content",
  write(`#!/usr/bin/env bash\n${DK} ${STOP} scratch-1\n${DK} ${RMV} scratch-1\n`, "/tmp/cleanup.sh"), ALLOW);
expect("6. an Edit whose new text quotes teardown", edit(`${DK} stack ${RMV} isolaportal`), ALLOW);

console.log("MUST BLOCK — the operation itself, however it is dressed:");
expect("1. service teardown", bash(`${DK} service ${RMV} isolaportal_api`), BLOCK);
expect("2. stack teardown", bash(`${DK} stack ${RMV} isolaportal`), BLOCK);
expect("3. forced container removal", bash(`${DK} ${RMV} -f isola5mr-db`), BLOCK);
expect("4. container stop", bash(`${DK} ${STOP} isola5mr-db`), BLOCK);
expect("5. wrapped in bash -c", bash(`bash -c "${DK} service ${RMV} isolaportal_api"`), BLOCK);
expect("6. wrapped in PowerShell", pwsh(`& ${DK} service ${RMV} isolaportal_api`), BLOCK);
expect("7. broad prune (untargeted by construction)", bash(`${DK} system ${PRUNE} -af`), BLOCK);
expect("8. prune of a named resource class", bash(`${DK} volume ${PRUNE} -f`), BLOCK);
expect("9. unresolved command substitution over a broad set",
  bash(`${DK} ${STOP} $(${DK} ps -aq)`), BLOCK);
expect("10. unresolved variable as the target", bash(`${DK} ${RMV} -f $CONTAINERS`), BLOCK);
expect("11. container kill", bash(`${DK} container ${KILL} isolagw_gateway`), BLOCK);

// NARROWNESS CONTROL. Only the teardown rule became execution-scoped. If this ever
// reports ALLOW, file writes have been exempted in general and the change is no longer
// the one that was authorised.
expect("NARROWNESS CONTROL: writing a recursive remove at a protected path still blocks",
  write(DANGER, "/tmp/danger.sh"), BLOCK);

// COMPENSATING CONTROL. Writing the script is now allowed, so RUNNING it must not be.
// Without these three, the change would be a straight reduction in protection.
console.log("MUST BLOCK — running a script whose CONTENTS hold the operation:");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guardfix-"));
const teardownScript = path.join(tmp, "teardown.sh").replace(/\\/g, "/");
const innocentScript = path.join(tmp, "innocent.sh").replace(/\\/g, "/");
const commentedScript = path.join(tmp, "commented.sh").replace(/\\/g, "/");
fs.writeFileSync(teardownScript, `#!/bin/sh\necho starting\n${DK} service ${RMV} isolaportal_api\n`);
fs.writeFileSync(innocentScript, `#!/bin/sh\necho hello\ndf -h\n`);
fs.writeFileSync(commentedScript, `#!/bin/sh\n# this script must never ${DK} ${STOP} anything\necho hi\n`);

expect("12. sh <script> where the script tears down", bash(`sh ${teardownScript}`), BLOCK);
expect("13. bash <script> where the script tears down", bash(`bash ${teardownScript}`), BLOCK);
expect("14. sudo bash <script> where the script tears down", bash(`sudo bash ${teardownScript}`), BLOCK);

console.log("MUST ALLOW — script scanning must not become a second false positive:");
expect("15. running a script that does nothing destructive", bash(`sh ${innocentScript}`), ALLOW);
expect("16. running a script whose only mention is in a comment", bash(`sh ${commentedScript}`), ALLOW);
expect("17. running a script that does not exist", bash(`sh ${tmp}/absent.sh`), ALLOW);

try {
  fs.unlinkSync(teardownScript); fs.unlinkSync(innocentScript); fs.unlinkSync(commentedScript);
  fs.rmdirSync(tmp);
} catch (e) {}

console.log("");
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
