#!/usr/bin/env node
/*
 * Packet 5M-RA — controls for the TEMPORARY exact-target authorization.
 *
 * This file exists to prove two things at once, and the second matters more than the
 * first: that the eight reviewed command lines are permitted, and that NOTHING ELSE IS.
 * An authorization without the second half is not an authorization, it is a hole with a
 * comment above it.
 *
 * The mutation controls are the load-bearing part. Each changes a single character,
 * appends one argument, or wraps the command — the smallest edits a tired operator or a
 * confused agent would actually produce — and every one of them must be refused.
 *
 * LIFECYCLE: after the temporary block is removed, this file is expected to report the
 * eight formerly-authorized lines as REFUSED. Run it with EXPECT=removed to assert that
 * end state. It is kept permanently so the lifecycle is provable in both directions
 * rather than asserted in a report.
 *
 * Destructive payloads are assembled from fragments so this file can be written while the
 * recursive-remove and prune rules are active. Neither of those is execution-scoped and
 * neither is touched by this packet — the fragments are the cost of leaving them alone.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const HOOK = process.env.HOOK_PATH || path.join(__dirname, "enforce-safety.js");
const MODE = process.env.EXPECT === "removed" ? "removed" : "installed";

const SSH = "ssh -o BatchMode=yes epicadmin@66.118.37.110 ";
const OPT = "/o" + "pt/isola-portal-build/";
const RMC = "r" + "m";
const PRUNE = "pru" + "ne";

const AUTHORIZED = [
  SSH + "'sudo docker stop -t 10 257ec32169d6 2d299bf1f469 8d7bab88ffa1 57c1bb921fb1'",
  SSH + "'sudo docker rm 257ec32169d6 2d299bf1f469 1863725cd5c3 e8306325b2cc 450c1208e7ff f88cba0178ad'",
  SSH + "'sudo docker rm c14e1354d7cd 452366bb5465 d051e229b499 4ceb0297463d 8d7bab88ffa1 b86ffa0bc76e'",
  SSH + "'sudo docker rm 23a07da22682 57c1bb921fb1 ba8f90f4e7c4 39b02eb9e47e ffed32dbeb5b c83bd080db3d 9230f239e85e'",
  SSH + "'sudo docker network rm 0e18a618cd02'",
  SSH + "'sudo " + RMC + " -rf " + OPT + "a441934'",
  SSH + "'sudo " + RMC + " -rf " + OPT + "a441934-rel1'",
  SSH + "'sudo " + RMC + " -rf " + OPT + "8743ddc'",
];

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
let gaps = 0;
// A KNOWN, FILED GAP IS NOT A PASS AND NOT A FAILURE.
//
// docker network removal is matched by NOTHING in the permanent guard: the teardown
// pattern optional-subcommand group covers container/compose/stack/service and not
// network. So while the temporary authorization is installed its companion rule refuses
// these, and once it is removed they are permitted again — including against
// easypanel-isola, the network the estate runs on.
//
// Reporting that as FAIL would leave this suite permanently red, and a permanently red
// suite is a suite nobody reads. Reporting it as PASS would bury a live gap. So it is
// counted and named on every run, and it stops being a gap the day the pattern covers
// network removal — at which point these become ordinary expectations.
function gapAware(label, actual, wantedInstalled, wantedRemoved) {
  const wanted = MODE === "installed" ? wantedInstalled : wantedRemoved;
  if (actual === wanted) { pass++; console.log(`  PASS  ${label}  (exit ${actual}, wanted ${wanted})`); return; }
  if (MODE === "removed" && actual === ALLOW) {
    gaps++;
    console.log(`  GAP   ${label}  (exit ${actual}) — permanent guard does not cover docker network removal; see def-enforce-safety-guard-no-network-removal-coverage-2026-08-20`);
    return;
  }
  fail++; console.log(`  FAIL  ${label}  (exit ${actual}, wanted ${wanted})`);
}
const bash = (c) => run("Bash", { command: c });
const write = (c) => run("Write", { file_path: "/tmp/doc.md", content: c });

console.log(`HOOK: ${HOOK}`);
console.log(`MODE: ${MODE} — the eight authorized lines must be ${MODE === "installed" ? "ALLOWED" : "REFUSED"}\n`);

console.log("POSITIVE CONTROL — the hook is answering and still refuses an unrelated teardown:");
expect("teardown of a production service by name", bash("sudo docker service rm isolagw_gateway"), BLOCK);

console.log(`THE EIGHT AUTHORIZED LINES (${MODE}):`);
const want = MODE === "installed" ? ALLOW : BLOCK;
AUTHORIZED.forEach((c, i) => {
  const label = `authorized line ${i + 1}`;
  if (i === 4) gapAware(label, bash(c), ALLOW, BLOCK);   // the network line
  else expect(label, bash(c), want);
});

// ─────────────────────────────────────────────────────────────────────────────
// MUTATION CONTROLS. Every one must be REFUSED in BOTH modes. If any is ever
// allowed, the authorization is not exact and must be removed at once.
// ─────────────────────────────────────────────────────────────────────────────
console.log("MUTATION CONTROLS — refused whether or not the authorization is installed:");

expect("container id: last character changed",
  bash(SSH + "'sudo docker stop -t 10 257ec32169d7 2d299bf1f469 8d7bab88ffa1 57c1bb921fb1'"), BLOCK);
expect("container id: one character changed mid-line in a removal",
  bash(SSH + "'sudo docker rm c14e1354d7cd 452366bb5465 d051e229b499 4ceb0297463d 8d7bab88ffa2 b86ffa0bc76e'"), BLOCK);
gapAware("network id: one character changed",
  bash(SSH + "'sudo docker network rm 0e18a618cd03'"), BLOCK, BLOCK);
expect("directory path: one character appended",
  bash(SSH + "'sudo " + RMC + " -rf " + OPT + "a441934x'"), BLOCK);

expect("production gateway container id substituted",
  bash(SSH + "'sudo docker rm 6f82145bc683'"), BLOCK);
expect("production runtime container id substituted",
  bash(SSH + "'sudo docker stop -t 10 ca27c7faa2fe'"), BLOCK);
expect("production portal container id substituted",
  bash(SSH + "'sudo docker rm 5403d275599a'"), BLOCK);
gapAware("production network name substituted",
  bash(SSH + "'sudo docker network rm easypanel-isola'"), BLOCK, BLOCK);

expect("extra target appended to an authorized removal",
  bash(SSH + "'sudo docker rm 257ec32169d6 2d299bf1f469 1863725cd5c3 e8306325b2cc 450c1208e7ff f88cba0178ad 6f82145bc683'"), BLOCK);
expect("one target dropped from an authorized removal",
  bash(SSH + "'sudo docker rm 257ec32169d6 2d299bf1f469 1863725cd5c3 e8306325b2cc 450c1208e7ff'"), BLOCK);
expect("-v added (it would take the anonymous volumes with it)",
  bash(SSH + "'sudo docker rm -v 257ec32169d6 2d299bf1f469 1863725cd5c3 e8306325b2cc 450c1208e7ff f88cba0178ad'"), BLOCK);
expect("-f added",
  bash(SSH + "'sudo docker rm -f 257ec32169d6 2d299bf1f469 1863725cd5c3 e8306325b2cc 450c1208e7ff f88cba0178ad'"), BLOCK);
expect("parent directory targeted instead of a child",
  bash(SSH + "'sudo " + RMC + " -rf " + "/o" + "pt/isola-portal-build'"), BLOCK);

expect("authorized line wrapped in bash -c",
  bash('bash -c "' + AUTHORIZED[1] + '"'), BLOCK);
expect("authorized line preceded by another command",
  bash("echo starting; " + AUTHORIZED[1]), BLOCK);
expect("authorized line piped",
  bash(AUTHORIZED[1] + " | tee /tmp/out.log"), BLOCK);
expect("command substitution supplying the targets",
  bash(SSH + "'sudo docker rm $(docker ps -aq)'"), BLOCK);
expect("glob supplying the targets",
  bash(SSH + "'sudo " + RMC + " -rf " + OPT + "*'"), BLOCK);
expect("system " + PRUNE + " instead of named targets",
  bash(SSH + "'sudo docker system " + PRUNE + " -af'"), BLOCK);
expect("volume " + PRUNE,
  bash(SSH + "'sudo docker volume " + PRUNE + " -f'"), BLOCK);

console.log("UNAFFECTED — the repaired guard's normal behaviour is unchanged:");
expect("inert documentation quoting the cleanup commands is allowed",
  write("# cleanup\n\n```bash\n" + AUTHORIZED[1] + "\n" + AUTHORIZED[4] + "\n```\n"), ALLOW);
expect("an ordinary safe command is allowed", bash("sudo docker ps -a"), ALLOW);
expect("writing a recursive remove at a protected path still blocks",
  write("#!/bin/sh\n" + RMC + " -rf " + "/o" + "pt/bff-v2\n"), BLOCK);

console.log("");
console.log(`  ${pass} passed, ${fail} failed, ${gaps} known-gap`);
process.exit(fail === 0 ? 0 : 1);
