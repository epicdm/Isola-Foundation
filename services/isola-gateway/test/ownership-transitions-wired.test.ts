/**
 * STRUCTURAL GUARD: every exported ownership transition must have a caller.
 *
 * THREE TIMES in this one service a transition was written, reviewed, found
 * correct, and never called:
 *
 *   - the handback edge          (`beginHandback`/`completeHandback`/`settleResumed`)
 *   - the manual-handback signal (Chatwoot's own status-changed event)
 *   - the human-reply edge       (`recordHumanReply`, `confirmHumanOwnership`)
 *
 * None of them failed. Nothing threw, no test went red, no log line appeared.
 * The code simply never ran, and the ledger silently could not reach the state
 * the product depended on. A behavioural test cannot catch that — it can only
 * prove the paths it exercises, and the whole defect is a path nobody wrote.
 *
 * So this is a SOURCE SCAN, in the same style and with the same comment-
 * stripping as `no-direct-network.test.ts`: it proves the property for the
 * whole tree, including transitions added later.
 *
 * WHAT DOES NOT COUNT AS A CALLER, and why each exclusion is load-bearing:
 *   - the export declaration itself  — `export function recordHumanReply(` is
 *     the very thing being questioned; counting it makes the test vacuous
 *   - anything inside a comment      — every one of the three defects had a
 *     doc comment describing the call that did not exist
 *   - test files                     — `recordHumanReply` HAD a test and still
 *     had no production caller. Tests are exactly what this cannot rely on
 *   - `ownership-store.ts` itself    — internal helpers calling each other says
 *     nothing about whether the gateway ever reaches them
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
const STORE = "ownership-store.ts";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

/** Same stripper as `no-direct-network.test.ts` — one mechanism, not two. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/**
 * The transitions this guard governs: exported functions in the store that
 * MOVE ownership. Read from the source rather than hard-coded, so a transition
 * added tomorrow is covered without anyone remembering to list it here.
 */
function exportedTransitions(storeSource: string): string[] {
  const names: string[] = [];
  const re = /^export\s+(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(storeSource)) !== null) names.push(m[1]!);
  // Infrastructure, not transitions: these do not move ownership and are
  // wired (or not) on their own terms.
  const NOT_TRANSITIONS = new Set([
    "applyOwnershipTransition", // the primitive every transition is built from
    "migrateOwnershipStore",
    "createPostgresOwnershipGate",
    "readConversationOwnership",
    "claimHandoverAck",
  ]);
  return names.filter((n) => !NOT_TRANSITIONS.has(n));
}

/**
 * Production call sites of `name`, excluding the store itself and test files.
 *
 * A call is `name(` or `name<`(generic) NOT preceded by `function `/`export `.
 * Deliberately simple: this is a smoke alarm, not a type checker.
 */
function productionCallersOf(
  name: string,
  files: Array<{ path: string; code: string }>,
): string[] {
  const call = new RegExp(String.raw`(?<!function\s)(?<!\.)\b${name}\s*\(`);
  return files.filter((f) => !f.path.endsWith(STORE)).filter((f) => call.test(f.code)).map((f) => f.path);
}

/**
 * ONE HOP THROUGH THE STORE'S OWN FAÇADE.
 *
 * A first version of this guard excluded `ownership-store.ts` wholesale and
 * promptly produced a FALSE POSITIVE: it reported `requestHumanOwnership` as
 * unwired while the live staging chain was demonstrably reaching
 * HUMAN_REQUESTED through it. The reason is that the production entry point is
 * the gate façade — `createPostgresOwnershipGate` returns
 * `{ requestHuman: (input) => requestHumanOwnership(exec, input) }` — and
 * `server.ts` calls the factory, not the transition.
 *
 * So a transition also counts as wired when it is called INSIDE the store by an
 * exported function that itself has a production caller. One hop only: that is
 * enough for a façade and still refuses to accept "a dead function calls it".
 *
 * The false positive is recorded rather than quietly fixed, because the
 * instrument being wrong in the same direction as the defect it hunts is
 * exactly the failure this codebase keeps paying for (CLAUDE.md §2.11).
 */
function storeExportsCalling(name: string, storeSource: string): string[] {
  const code = stripComments(storeSource);
  const call = new RegExp(String.raw`(?<!function\s)(?<!\.)\b${name}\s*\(`);
  const out: string[] = [];
  // Split at each exported function; the header names the enclosing scope.
  const parts = code.split(/^export\s+(?:async\s+)?function\s+/m);
  for (const part of parts.slice(1)) {
    const enclosing = /^([a-zA-Z0-9_]+)/.exec(part)?.[1];
    if (enclosing === undefined || enclosing === name) continue;
    if (call.test(part)) out.push(enclosing);
  }
  return out;
}

function isReachable(
  name: string,
  files: Array<{ path: string; code: string }>,
  storeSource: string,
): boolean {
  if (productionCallersOf(name, files).length > 0) return true;
  return storeExportsCalling(name, storeSource).some(
    (enclosing) => productionCallersOf(enclosing, files).length > 0,
  );
}

/**
 * Transitions known to have NO caller, each owed a fix.
 *
 * This is debt made VISIBLE, not debt excused. The exact contents are asserted
 * below, so adding a name here is a deliberate, reviewable act rather than a
 * quiet way to make a red test green — which is the only way an allowlist like
 * this stays honest.
 */
const KNOWN_UNWIRED = new Set([
  // HUMAN_REQUESTED -> HUMAN_OWNED once assignment and context publication
  // complete. The human-reply edge now reaches HUMAN_OWNED, so this is a
  // second, earlier route to the same state rather than an open hole.
  "confirmHumanOwnership",
  // Conversation resolved. No caller; resolution is not recorded in the ledger.
  "recordResolution",
]);

const FILES = sourceFiles(SRC_DIR).map((full) => ({
  path: full,
  code: stripComments(readFileSync(full, "utf8")),
}));

const STORE_SOURCE = readFileSync(join(SRC_DIR, STORE), "utf8");
const TRANSITIONS = exportedTransitions(STORE_SOURCE);

describe("every exported ownership transition has a production caller", () => {
  /**
   * The list must not be empty. Without this, a regex that stopped matching
   * would make the whole suite pass by governing nothing at all — the exact
   * vacuous-pass shape this file exists to prevent.
   */
  it("CONTROL — the guard actually found transitions to govern", () => {
    expect(TRANSITIONS.length).toBeGreaterThanOrEqual(5);
    expect(TRANSITIONS).toContain("recordHumanReply");
    expect(TRANSITIONS).toContain("requestHumanOwnership");
    expect(TRANSITIONS).toContain("beginHandback");
  });

  /**
   * The allowlist is pinned. If a transition is fixed, this fails until the
   * name is removed; if a NEW one is added, this fails until somebody says so
   * out loud. Either way the list cannot drift silently.
   */
  it("CONTROL — the known-unwired allowlist is exactly what we think it is", () => {
    expect([...KNOWN_UNWIRED].sort()).toEqual(["confirmHumanOwnership", "recordResolution"]);
  });

  it.each(TRANSITIONS)("%s is reachable from production src/", (name) => {
    if (KNOWN_UNWIRED.has(name)) {
      // Assert the debt is REAL, so a name cannot sit here after being fixed.
      expect(
        isReachable(name, FILES, STORE_SOURCE),
        `${name} is on the known-unwired list but now HAS a caller — remove it from KNOWN_UNWIRED.`,
      ).toBe(false);
      return;
    }
    expect(
      isReachable(name, FILES, STORE_SOURCE),
      `${name} is exported by ${STORE} and is reachable from NO production code. ` +
        `A transition nothing calls cannot move the ledger, and nothing will fail ` +
        `to tell you — that is how this defect class has survived three times. ` +
        `Wire it, or add it to KNOWN_UNWIRED with a defect id.`,
    ).toBe(true);
  });
});

describe("the detector itself", () => {
  /**
   * THE FIRING NEGATIVE CONTROL. Without it, a detector that returned "found"
   * for everything would pass every assertion above while proving nothing.
   */
  it("NEGATIVE CONTROL — reports zero callers for a name that appears nowhere", () => {
    expect(productionCallersOf("aTransitionThatDoesNotExistAnywhere", FILES)).toHaveLength(0);
  });

  it("NEGATIVE CONTROL — a call that exists only inside a comment does not count", () => {
    const commented = [
      { path: "fake.ts", code: stripComments("// recordHumanReply(exec, input);\n") },
      { path: "fake2.ts", code: stripComments("/* recordHumanReply(exec, input); */\n") },
    ];
    expect(productionCallersOf("recordHumanReply", commented)).toHaveLength(0);
  });

  it("NEGATIVE CONTROL — the export declaration itself does not count as a caller", () => {
    const declOnly = [
      { path: "decl.ts", code: "export async function recordHumanReply(exec, input) { return 1; }" },
    ];
    expect(productionCallersOf("recordHumanReply", declOnly)).toHaveLength(0);
  });

  it("POSITIVE CONTROL — a real call IS detected", () => {
    const real = [{ path: "real.ts", code: "await recordHumanReply(deps.ownershipExec, { conversation });" }];
    expect(productionCallersOf("recordHumanReply", real)).toHaveLength(1);
  });

  it("the store itself is excluded — internal use is not evidence of wiring", () => {
    const storeOnly = [
      { path: join(SRC_DIR, STORE), code: "recordHumanReply(exec, input);" },
    ];
    expect(productionCallersOf("recordHumanReply", storeOnly)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // The one-hop façade rule, and the false positive that forced it
  // -------------------------------------------------------------------------

  it("REGRESSION — requestHumanOwnership is reachable via the gate façade", () => {
    // The first version of this guard called this one UNWIRED while the live
    // staging chain was reaching HUMAN_REQUESTED through it. Pinned so the
    // false positive cannot come back.
    expect(storeExportsCalling("requestHumanOwnership", STORE_SOURCE)).toContain(
      "createPostgresOwnershipGate",
    );
    expect(isReachable("requestHumanOwnership", FILES, STORE_SOURCE)).toBe(true);
  });

  it("NEGATIVE CONTROL — one hop only: a dead enclosing function does not launder reachability", () => {
    const store = `
export function aDeadFunctionNobodyCalls(exec) { return someTransition(exec); }
export function someTransition(exec) { return 1; }
`;
    // The enclosing function exists but has no production caller, so the
    // transition must still count as unreachable.
    expect(storeExportsCalling("someTransition", store)).toContain("aDeadFunctionNobodyCalls");
    expect(isReachable("someTransition", [], store)).toBe(false);
  });

  it("NEGATIVE CONTROL — a façade call written only in a comment does not count", () => {
    const store = `
export function createGate(exec) {
  // return { requestHuman: () => someTransition(exec) };
  return {};
}
`;
    expect(storeExportsCalling("someTransition", store)).toHaveLength(0);
  });
});
