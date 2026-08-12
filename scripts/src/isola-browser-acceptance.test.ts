/**
 * The property under test is a NEGATIVE one: checks 11 and 16 must be
 * incapable of reporting PASS unless a browser actually rendered the required
 * values in the current run.
 *
 * This matters because both checks were `NOT RUN` for a long time, and the
 * cheapest way to make a stubborn check go green is to quietly let something
 * other than the browser satisfy it. These tests exist to make that fail loudly.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  judgeCheck11,
  judgeCheck16,
  type ConversationSurfaceProbe,
  type RenderedProbe,
} from "./isola-browser-acceptance";
import { chromiumSearchRoots, findChromium } from "./isola-browser";
import { CHECKS, DEFAULT_CONTEXT, assertSyntheticAccount, type CheckContext } from "./isola-28-point-acceptance";

const FULLY_RENDERED: RenderedProbe = {
  tenantIdVisible: true,
  companyNameVisible: true,
  progressVisible: true,
  succeededStepVisible: true,
  blockedStepsVisible: true,
  blockedReasonVisible: true,
  falseCompleteClaim: false,
  provisioningWordVisible: true,
};

test("check 11 is NOT RUN when no browser probe was captured", () => {
  const r = judgeCheck11(null);
  assert.equal(r.status, "NOT RUN");
  assert.match(r.detail, /no rendered probe/i);
});

test("check 11 cannot pass when any single required value is missing", () => {
  const required: Array<keyof RenderedProbe> = [
    "tenantIdVisible",
    "companyNameVisible",
    "progressVisible",
    "succeededStepVisible",
    "blockedStepsVisible",
    "blockedReasonVisible",
  ];
  for (const key of required) {
    const probe = { ...FULLY_RENDERED, [key]: false };
    const r = judgeCheck11(probe);
    assert.equal(r.status, "FAIL", `omitting ${key} must not pass`);
  }
});

test("check 11 fails when the UI claims completion while steps are held", () => {
  const r = judgeCheck11({ ...FULLY_RENDERED, falseCompleteClaim: true });
  assert.equal(r.status, "FAIL");
  assert.match(r.detail, /complete\/ready\/100%/i);
});

test("check 11 passes only when every required value is rendered", () => {
  const r = judgeCheck11(FULLY_RENDERED);
  assert.equal(r.status, "PASS");
  assert.match(r.method, /rendered DOM/i);
});

test("an all-false probe — the shape a blank page produces — is never a pass", () => {
  const blank = Object.fromEntries(
    Object.keys(FULLY_RENDERED).map((k) => [k, false]),
  ) as unknown as RenderedProbe;
  assert.notEqual(judgeCheck11(blank).status, "PASS");
});

test("check 16 is NOT RUN when no conversation-surface probe was captured", () => {
  const r = judgeCheck16(null);
  assert.equal(r.status, "NOT RUN");
});

test("check 16 is NOT RUN — never PASS — when no customer conversation surface exists", () => {
  const probe: ConversationSurfaceProbe = {
    appRoutes: [
      { path: "/en/T/conversations", rendered: false },
      { path: "/en/T/inbox", rendered: false },
    ],
    chatwootWidgetAvailable: false,
    inboxChannel: "Channel::Api",
  };
  const r = judgeCheck16(probe);
  assert.equal(r.status, "NOT RUN");
  assert.match(r.detail, /no customer-facing conversation interface/i);
  assert.match(r.detail, /Channel::Api/);
});

test("check 16 does not pass merely because a surface was found", () => {
  const probe: ConversationSurfaceProbe = {
    appRoutes: [{ path: "/en/T/conversations", rendered: true }],
    chatwootWidgetAvailable: true,
    inboxChannel: "Channel::WebWidget",
  };
  // Finding a surface is a precondition, not the evidence. Without an observed
  // human reply rendered in it, the only honest answer is FAIL.
  assert.equal(judgeCheck16(probe).status, "FAIL");
});

test("neither judge exposes a code path that returns PASS from an empty input", () => {
  for (const outcome of [judgeCheck11(null), judgeCheck16(null)]) {
    assert.notEqual(outcome.status, "PASS");
    assert.equal(outcome.method, "", "a NOT RUN outcome must not claim a method");
  }
});

test("checks 11 and 16 are wired to a runner, not to a hard-coded blocked value", () => {
  for (const n of [11, 16]) {
    const check = CHECKS.find((c) => c.n === n);
    assert.ok(check, `check ${n} must exist`);
    assert.equal(typeof check!.run, "function", `check ${n} must execute, not report a fixed status`);
    assert.equal(check!.blocked, undefined, `check ${n} must not carry a hard-coded blocked status`);
  }
});

test("browser checks report NOT RUN, not PASS, when no credential is supplied", async () => {
  const ctx: CheckContext = { ...DEFAULT_CONTEXT, fetch: globalThis.fetch };
  for (const n of [11, 16]) {
    const check = CHECKS.find((c) => c.n === n)!;
    const result = await check.run!(ctx);
    assert.equal(result.status, "NOT RUN", `check ${n} must not pass without a credential`);
  }
});

test("a non-synthetic account is refused before a browser is ever launched", () => {
  const ctx: CheckContext = { ...DEFAULT_CONTEXT, fetch: globalThis.fetch };
  assert.throws(
    () => assertSyntheticAccount(ctx, "a.real.customer@example.com"),
    /not in the declared synthetic account list/,
  );
});

test("chromium discovery returns null rather than guessing a path", () => {
  const found = findChromium({ ISOLA_CHROMIUM_PATH: "C:/definitely/not/here/chrome.exe" } as NodeJS.ProcessEnv);
  assert.equal(found, null);
});

test("an explicit chromium path suppresses cache probing", () => {
  assert.deepEqual(chromiumSearchRoots({ ISOLA_CHROMIUM_PATH: "/x/chrome" } as NodeJS.ProcessEnv), []);
});
