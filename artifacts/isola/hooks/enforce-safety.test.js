#!/usr/bin/env node
/*
 * Tests for enforce-safety.js — fired in BOTH directions.
 *
 * An alert that can never fire is worse than no alert; a guard that can never pass is
 * worse than no guard. Every case asserts a specific outcome, and the suite contains
 * cases that MUST block as well as cases that MUST allow. A suite that only proved
 * "it blocks" would have passed while the guard blocked everything.
 *
 * WHY TRIGGERS ARE ASSEMBLED AT RUNTIME AND THE LABELS ARE PARAPHRASED:
 * this file is inspected by the hook it tests. Written-out literals make the hook block
 * its own test file. That happened three times while writing it — in the payloads, in
 * the human-readable descriptions, and in an interpolation whose rendered form read as a
 * standalone command word. A GUARD THAT CANNOT BE TESTED WITHOUT TRIPPING IS A GUARD
 * NOBODY TESTS, so the assembly is the design, not a dodge.
 *
 * Most MUST-BLOCK cases come from an adversarial review that found one-line bypasses of
 * the ORIGINAL rules. They are regression tests for real holes, not hypotheticals.
 *
 * Run: node ~/.claude/hooks/enforce-safety.test.js
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const HOOK = path.join(__dirname, "enforce-safety.js");

const D = ["d", "o", "c", "k", "e", "r"].join("");
const STOP = ["s", "t", "o", "p"].join("");
const RMCMD = ["r", "m"].join("");
const DOWN = ["d", "o", "w", "n"].join("");
const DEL = ["d", "e", "l", "e", "t", "e"].join("");
const DROP = ["d", "r", "o", "p"].join("");
const PM2 = "pm" + "2";

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

// 2026-08-20 — FIVE CARRIERS MIGRATED FROM Write TO Bash.
//
// The container-teardown rule is now executionOnly: it judges what RUNS, not what is
// written down, because the old behaviour made the estate unable to write its own
// operator runbooks. These five cases were never about that distinction — each one
// asserts a PARSER property (a trailing comment is not stripped; a verb at the start of
// a line still matches; a comment marker with no following space is not a comment) and
// merely used a Write as the transport.
//
// Left on a Write they would have silently become vacuous: still green, asserting
// nothing, because the rule no longer looks at inert writes. A test that passes because
// it can no longer reach the code it tests is worse than a deleted one. On a Bash
// carrier every assertion still lands on the rule it was written for.
//
// NOT migrated, on purpose: "shebang is not a comment line", which carries a recursive
// remove against a protected path on a Write and MUST still block. It is the control
// proving file writes were not exempted in general — only the one rule whose danger is
// the running.
console.log("MUST BLOCK — baseline:");
expect("teardown verb in a live command", bash(`${D} ${STOP} some-container`), BLOCK);
expect("trailing comment is NOT stripped for matching", bash(`echo hi   # ${D} ${STOP} c1\n`), BLOCK);

// THE ORIGINAL FALSE NEGATIVE, RUN THROUGH THE BLOB-FREE PATH.
// Rules once matched JSON.stringify(input), where a newline is the two characters
// backslash+n — so a verb at the START of a line read as (n + verb), \b failed, and the
// rule silently did not match. The whole-blob backstop has since been REMOVED, so these
// two cases are the only evidence that textOf covers what the blob used to. The second
// has nothing whatsoever before the verb on its line.
console.log("MUST BLOCK — regression: the original escaped-newline false negative:");
expect("verb at line start, after a shebang", bash(`#!/bin/sh\n${D} ${STOP} c1\n`), BLOCK);
expect("verb as the very first token of a line", bash(`echo one\n${D} ${STOP} c1\n`), BLOCK);

// THE SAME-SEGMENT PROOF. The exemption is evaluated on the IDENTICAL segment that
// matched the rule, never on "does any segment carry an exemption". The first case below
// is what distinguishes the two: segment A holds a VALID exemption token, segment B holds
// the destructive command. If the check were "any segment", it would pass and this whole
// suite would be measuring the wrong thing.
console.log("MUST BLOCK — exemption scoping, evaluated on the SAME segment:");
expect("exemption in segment A, command in segment B",
  bash(`echo retiring 66.118.37.96; ssh 66.118.37.12 '${D} ${STOP} prod-bff'`), BLOCK);
expect("exempt token only in a trailing comment",
  bash(`${D} ${STOP} prod-bff   # unifi`), BLOCK);
expect("exempt token echoed by a later command, semicolon",
  bash(`${D} ${STOP} prod-bff; echo unms`), BLOCK);

// A bare NEWLINE is a command separator too — this is how people actually paste, and it
// is a likelier accident than typing a semicolon.
expect("exemption on a previous LINE",
  bash(`echo retiring 66.118.37.96\n${D} ${STOP} prod-bff`), BLOCK);
expect("exempt token after a PIPE",
  bash(`${D} ${STOP} prod-bff | tee unifi.log`), BLOCK);
expect("exempt token after a BACKGROUND ampersand",
  bash(`${D} ${STOP} prod-bff & echo unms`), BLOCK);

console.log("MUST BLOCK — container-tool aliases that were entirely uncovered:");
expect("hyphenated compose teardown", bash(`${D}-compose ${DOWN}`), BLOCK);
expect("container subcommand form", bash(`${D} container ${STOP} prod-bff`), BLOCK);
expect("compose subcommand removal", bash(`${D} compose ${RMCMD} -sf voice-runtime`), BLOCK);
expect("stack removal", bash(`${D} stack ${RMCMD} cw`), BLOCK);
expect("service removal", bash(`${D} service ${RMCMD} isolagw_gateway`), BLOCK);
expect("shell line continuation splits the verb", bash(`${D} \\\n${STOP} prod-runtime`), BLOCK);

console.log("MUST BLOCK — recursive-remove flag orderings, all identical in effect:");
expect("flags reversed", bash(`${RMCMD} -fr /var/www`), BLOCK);
expect("flags split apart", bash(`${RMCMD} -r -f /var/www`), BLOCK);
expect("end-of-options separator", bash(`${RMCMD} -rf -- /var/www`), BLOCK);
expect("protected path under a live checkout", bash(`${RMCMD} -rf /opt/bff-v2`), BLOCK);

console.log("MUST BLOCK — SQL forms the semicolon rule missed:");
expect("unscoped row removal, no semicolon", bash(`psql -c "${DEL} from users"`), BLOCK);
expect("unscoped row removal with ONLY", bash(`psql -c "${DEL} from only users;"`), BLOCK);
expect("destructive DDL on an index", bash(`psql -c "${DROP} index idx_users"`), BLOCK);
expect("destructive DDL with IF EXISTS", bash(`psql -c "${DROP} table if exists customers cascade"`), BLOCK);

// A COMMENT MARKER IS A LEXICAL TOKEN, NOT A SUBSTRING. Every marker requires
// whitespace-or-end-of-line after it, not just the one that happened to break.
console.log("MUST BLOCK — comment markers that are not comments:");
expect("double-slash path is a command, not a comment",
  bash(`//bin/sh -c '${D} ${STOP} prod-runtime'`), BLOCK);
expect("shebang is not a comment line", write(`#!${RMCMD} -rf /opt/bff-v2\n`), BLOCK);
expect("hash with no space is not a comment line", bash(`#${D} ${STOP} prod-bff\n`), BLOCK);
expect("star with no space is not a comment line", bash(`*${D} ${STOP} prod-bff\n`), BLOCK);
expect("process-manager short alias", bash(`${PM2} del bff-v2-web`), BLOCK);

console.log("MUST ALLOW — a comment is not a command:");
expect("shell comment line", write(`#!/bin/sh\n# this file issues no ${D} ${STOP} anywhere\necho hi\n`), ALLOW);
expect("JS line comment (marker + space)", write(`// never call ${D} ${STOP} here\nconsole.log(1);\n`), ALLOW);
expect("block-comment continuation", write(`/*\n * do not ${D} ${STOP} the runtime\n */\nconsole.log(1);\n`), ALLOW);
expect("prose about destructive DDL in a comment", write(`# never ${DROP} table in prod\nselect 1;\n`), ALLOW);

console.log("MUST ALLOW — genuine work and genuine exemptions:");
expect("ordinary safe command", bash(`${D} ps --format '{{.Names}}'`), ALLOW);
expect("teardown targeting the repurpose host", bash(`ssh 66.118.37.96 '${D} ${STOP} old-stack'`), ALLOW);
expect("teardown of an exempt appliance container", bash(`${D} ${STOP} unifi-controller`), ALLOW);
expect("scoped row removal with a WHERE", bash(`psql -c "${DEL} from users where id = 1"`), ALLOW);
expect("service update is not teardown", bash(`${D} service update --force cw_chatwoot-rails`), ALLOW);
expect("non-recursive single-file removal", bash(`${RMCMD} /var/tmp/onefile`), ALLOW);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
