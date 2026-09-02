/**
 * These tests exist to stop the acceptance gate from being quietly weakened.
 *
 * The properties under test are NEGATIVE ones: no input shape may yield PASS
 * unless a browser rendered the exact values the live API returned in the same
 * run. Checks 11 and 16 sat at NOT RUN for a long time, and the cheapest way to
 * make a stubborn check go green is to let something other than the browser
 * satisfy it. Each test below closes one such shortcut.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  judgeCheck11,
  judgeCheck16,
  expectedCompanyName,
  requiredFields,
  runBrowserChecks,
  SyntheticGuardRefusal,
  type ApiSnapshot,
  type Check11Evidence,
  type Check16Evidence,
  type FieldObservation,
} from "./isola-browser-acceptance";
import { chromiumSearchRoots, findChromium } from "./isola-browser";
import { CHECKS, DEFAULT_CONTEXT, assertSyntheticAccount, type CheckContext } from "./isola-28-point-acceptance";

// ---------------------------------------------------------------------------
// Fixtures — modelled on the real deployed payload, but nothing here is
// hard-coded into the implementation. Expectations are derived from `API`.
// ---------------------------------------------------------------------------

const API: ApiSnapshot = {
  tenantId: "AVQLG3L",
  companyLegalName: "EPIC Communications Inc.",
  companyTradingName: "EPIC",
  progressPercent: 17,
  completedSteps: 1,
  totalSteps: 6,
  blockedCount: 5,
  steps: [
    { key: "company_profile", state: "SUCCEEDED", external_ref: "ALRE0PJ", blocked_reason: null },
    { key: "nocobase_tenant", state: "BLOCKED", blocked_reason: "Held: no scoped credential yet." },
    { key: "paperclip_company", state: "BLOCKED", blocked_reason: "Held: depends on the tenant record." },
    { key: "paperclip_employee", state: "BLOCKED", blocked_reason: "Held: depends on the tenant record." },
    { key: "chatwoot_workspace", state: "BLOCKED", blocked_reason: "Held: depends on the tenant record." },
    { key: "gateway_binding", state: "BLOCKED", blocked_reason: "Held: depends on the workspace." },
  ],
};

const ROUTE = "/en/T/provisioning";

/** Build the observation set a fully correct UI would produce. */
function perfectObservations(api: ApiSnapshot = API): FieldObservation[] {
  const obs: FieldObservation[] = [
    { field: "tenant_id", expected: api.tenantId, renderedText: api.tenantId, route: ROUTE, visible: true },
    {
      field: "company_name",
      expected: expectedCompanyName(api),
      renderedText: expectedCompanyName(api),
      route: ROUTE,
      visible: true,
    },
    {
      field: "progress_percent",
      expected: `${api.progressPercent}%`,
      renderedText: `${api.progressPercent}%`,
      route: ROUTE,
      visible: true,
    },
    {
      field: "completed_of_total",
      expected: `${api.completedSteps}/${api.totalSteps}`,
      renderedText: `${api.completedSteps}/${api.totalSteps}`,
      route: ROUTE,
      visible: true,
    },
  ];
  for (const s of api.steps) {
    obs.push({ field: `step:${s.key}:state`, expected: s.state, renderedText: s.state, route: ROUTE, visible: true });
    if (s.state === "BLOCKED") {
      obs.push({
        field: `step:${s.key}:blocked_reason`,
        expected: s.blocked_reason ?? "",
        renderedText: s.blocked_reason ?? "",
        route: ROUTE,
        visible: true,
      });
    }
  }
  return obs;
}

const evidence11 = (over: Partial<Check11Evidence> = {}): Check11Evidence => ({
  api: API,
  observations: perfectObservations(),
  routes: [{ route: ROUTE, landedUrl: `https://app.example${ROUTE}`, uiState: "loaded" }],
  completionClaim: null,
  ...over,
});

/** Replace one observation, leaving the rest correct. */
function mutate(field: string, patch: Partial<FieldObservation>): Check11Evidence {
  const observations = perfectObservations().map((o) => (o.field === field ? { ...o, ...patch } : o));
  return evidence11({ observations });
}

// ---------------------------------------------------------------------------
// Check 11
// ---------------------------------------------------------------------------

test("check 11 passes when every rendered value exactly matches the live API", () => {
  const r = judgeCheck11(evidence11());
  assert.equal(r.status, "PASS");
  assert.match(r.method, /exact comparison/i);
});

test("check 11 fails on a wrong tenant id", () => {
  assert.equal(judgeCheck11(mutate("tenant_id", { renderedText: "ZZZZZZZ" })).status, "FAIL");
});

test("check 11 fails on a wrong company name", () => {
  const r = judgeCheck11(mutate("company_name", { renderedText: "Some Other Company Ltd" }));
  assert.equal(r.status, "FAIL");
  assert.match(r.detail, /company_name/);
});

test("check 11 fails on a stale percentage", () => {
  // The exact bug a hard-coded "17%" would hide: the UI keeps showing an old
  // value after provisioning advances.
  const r = judgeCheck11(mutate("progress_percent", { renderedText: "17%" , expected: "33%" }));
  assert.equal(r.status, "FAIL");
  assert.match(r.detail, /progress_percent/);
});

test("check 11 fails on an incorrect completed/total count", () => {
  const r = judgeCheck11(mutate("completed_of_total", { renderedText: "6/6" }));
  assert.equal(r.status, "FAIL");
  assert.match(r.detail, /completed_of_total/);
});

test("check 11 fails when a step is missing from the screen", () => {
  const observations = perfectObservations().filter((o) => o.field !== "step:gateway_binding:state");
  const r = judgeCheck11(evidence11({ observations }));
  assert.equal(r.status, "FAIL");
  assert.match(r.detail, /step:gateway_binding:state/);
});

test("check 11 fails on an incorrect step state", () => {
  const r = judgeCheck11(mutate("step:nocobase_tenant:state", { renderedText: "SUCCEEDED" }));
  assert.equal(r.status, "FAIL");
  assert.match(r.detail, /step:nocobase_tenant:state/);
});

test("check 11 fails when exactly one blocked reason is missing", () => {
  // The old corpus check passed all five reasons off a single "Held:" match.
  const observations = perfectObservations().filter(
    (o) => o.field !== "step:chatwoot_workspace:blocked_reason",
  );
  const r = judgeCheck11(evidence11({ observations }));
  assert.equal(r.status, "FAIL");
  assert.match(r.detail, /step:chatwoot_workspace:blocked_reason/);
});

test("every blocked step contributes its own required reason field", () => {
  const fields = requiredFields(API);
  for (const s of API.steps.filter((x) => x.state === "BLOCKED")) {
    assert.ok(fields.includes(`step:${s.key}:blocked_reason`), `${s.key} must require its own reason`);
  }
  assert.ok(!fields.includes("step:company_profile:blocked_reason"), "a succeeded step needs no reason");
});

test("the succeeded step required by the contract is checked, not assumed", () => {
  assert.ok(requiredFields(API).includes("step:company_profile:state"));
  const r = judgeCheck11(mutate("step:company_profile:state", { renderedText: "PENDING" }));
  assert.equal(r.status, "FAIL");
});

test("generic words like blocked, held and succeeded cannot pass", () => {
  // Precisely what the previous /blocked/i and /held:/i sweeps accepted.
  const observations = perfectObservations().map((o) =>
    o.field.startsWith("step:")
      ? { ...o, renderedText: o.field.endsWith(":state") ? "blocked" : "Held:" }
      : o,
  );
  const r = judgeCheck11(evidence11({ observations }));
  assert.equal(r.status, "FAIL");
});

test("an encoded tenant id in a URL cannot pass for the tenant identifier", () => {
  const encoded = Buffer.from(`TenantType:${API.tenantId}`).toString("base64");
  assert.ok(!encoded.includes(API.tenantId), "sanity: the raw id is not a substring of its encoding");
  const r = judgeCheck11(mutate("tenant_id", { renderedText: encoded }));
  assert.equal(r.status, "FAIL");
});

test("hidden text cannot pass, even when its content is exactly right", () => {
  const r = judgeCheck11(mutate("tenant_id", { visible: false }));
  assert.equal(r.status, "FAIL");
  assert.match(r.detail, /tenant_id/);
});

test("API-only evidence cannot pass: a correct snapshot with nothing rendered fails", () => {
  const r = judgeCheck11(evidence11({ observations: [] }));
  assert.equal(r.status, "FAIL");
  assert.match(r.detail, /not rendered/);
});

test("check 11 is NOT RUN when no browser evidence exists at all", () => {
  const r = judgeCheck11(null);
  assert.equal(r.status, "NOT RUN");
  assert.equal(r.method, "");
});

test("check 11 fails when the UI claims completion while the API reports blocked steps", () => {
  const r = judgeCheck11(evidence11({ completionClaim: "100%" }));
  assert.equal(r.status, "FAIL");
  assert.match(r.detail, /claims "100%"/);
});

test("a completion claim is not a failure when nothing is actually blocked", () => {
  const done: ApiSnapshot = {
    ...API,
    blockedCount: 0,
    progressPercent: 100,
    completedSteps: 6,
    steps: API.steps.map((s) => ({ ...s, state: "SUCCEEDED", blocked_reason: null })),
  };
  const r = judgeCheck11({
    api: done,
    observations: perfectObservations(done),
    routes: [],
    completionClaim: "100%",
  });
  assert.equal(r.status, "PASS");
});

test("whitespace differences do not create false failures", () => {
  const r = judgeCheck11(mutate("tenant_id", { renderedText: `\n  ${API.tenantId}  \n` }));
  assert.equal(r.status, "PASS");
});

test("the company name shown is the trading name when set, else the legal name", () => {
  assert.equal(expectedCompanyName({ companyLegalName: "L Ltd", companyTradingName: "T" }), "T");
  assert.equal(expectedCompanyName({ companyLegalName: "L Ltd", companyTradingName: "  " }), "L Ltd");
});

// ---------------------------------------------------------------------------
// Check 16
// ---------------------------------------------------------------------------

const MARKER = "isola-run-abc123";

const surfaceAbsent: Check16Evidence = {
  appRoutes: [
    { route: "/en/T/conversations", landedUrl: "x", uiState: "not-found" },
    { route: "/en/T/inbox", landedUrl: "x", uiState: "not-found" },
  ],
  chatwoot: { widgetAvailable: null, inboxChannel: null, probe: null },
  operatorSessionAvailable: false,
  operatorSessionDescription: null,
  replyAttempt: null,
  renderedReplies: [],
  observedConversationRef: null,
};

const surfacePresent: Check16Evidence = {
  ...surfaceAbsent,
  appRoutes: [{ route: "/en/T/conversations", landedUrl: "x", uiState: "loaded" }],
};

const withOperator: Check16Evidence = {
  ...surfacePresent,
  operatorSessionAvailable: true,
  operatorSessionDescription: "pre-authorized operator surface",
};

const withReply = (over: Partial<Check16Evidence> = {}): Check16Evidence => ({
  ...withOperator,
  replyAttempt: { conversationRef: "conv-42", runMarker: MARKER, submittedAt: "2026-08-11T03:00:00Z" },
  observedConversationRef: "conv-42",
  renderedReplies: [
    { text: `Hello from a person. ${MARKER}`, senderLabel: "Ada (EPIC Support)", senderKind: "human", messageRef: "m-9" },
  ],
  ...over,
});

test("check 16 is NOT RUN when no conversation surface rendered", () => {
  const r = judgeCheck16(surfaceAbsent);
  assert.equal(r.status, "NOT RUN");
  assert.match(r.detail, /no customer-facing conversation interface rendered/i);
});

test("check 16 makes no Chatwoot claim it did not observe", () => {
  const r = judgeCheck16(surfaceAbsent);
  assert.match(r.detail, /not probed in this run/i);
  assert.doesNotMatch(r.detail, /Channel::Api/);
  assert.doesNotMatch(r.detail, /404/);
});

test("check 16 reports an observed Chatwoot probe verbatim when there is one", () => {
  const r = judgeCheck16({
    ...surfaceAbsent,
    chatwoot: { widgetAvailable: false, inboxChannel: "Channel::Api", probe: "GET /widget?website_token -> 404" },
  });
  assert.match(r.detail, /GET \/widget\?website_token -> 404/);
});

test("check 16 is NOT RUN when a surface exists but no operator session does", () => {
  const r = judgeCheck16(surfacePresent);
  assert.equal(r.status, "NOT RUN");
  assert.match(r.detail, /no already-authorized operator session/i);
});

test("a surface alone cannot pass", () => {
  assert.notEqual(judgeCheck16(surfacePresent).status, "PASS");
  assert.notEqual(judgeCheck16(withOperator).status, "PASS");
});

test("check 16 is NOT RUN when surface and operator exist but no reply was sent", () => {
  const r = judgeCheck16(withOperator);
  assert.equal(r.status, "NOT RUN");
  assert.match(r.detail, /no reply was submitted in this run/i);
});

test("check 16 fails when the reply is absent after an attempted send", () => {
  const r = judgeCheck16(withReply({ renderedReplies: [] }));
  assert.equal(r.status, "FAIL");
  assert.match(r.detail, /no message carrying its run marker is visible/i);
});

test("check 16 fails when the visible reply is AI-labelled", () => {
  const r = judgeCheck16(
    withReply({
      renderedReplies: [
        { text: `Answer. ${MARKER}`, senderLabel: "Front Desk (AI)", senderKind: "ai", messageRef: "m-9" },
      ],
    }),
  );
  assert.equal(r.status, "FAIL");
  assert.match(r.detail, /visibly distinguishable from an AI reply/i);
});

test("check 16 fails when the visible reply is the wrong message", () => {
  const r = judgeCheck16(
    withReply({
      renderedReplies: [
        { text: "Some other reply entirely", senderLabel: "Ada", senderKind: "human", messageRef: "m-1" },
      ],
    }),
  );
  assert.equal(r.status, "FAIL");
});

test("check 16 fails when the reply is rendered more than once", () => {
  const r = judgeCheck16(
    withReply({
      renderedReplies: [
        { text: `Hi. ${MARKER}`, senderLabel: "Ada", senderKind: "human", messageRef: "m-9" },
        { text: `Hi. ${MARKER}`, senderLabel: "Ada", senderKind: "human", messageRef: "m-10" },
      ],
    }),
  );
  assert.equal(r.status, "FAIL");
  assert.match(r.detail, /exactly once/);
});

test("stale conversation evidence cannot pass", () => {
  const r = judgeCheck16(withReply({ observedConversationRef: "conv-7" }));
  assert.equal(r.status, "FAIL");
  assert.match(r.detail, /different conversation/i);
});

test("a reply from a previous run cannot pass: the marker is run-scoped", () => {
  const r = judgeCheck16(
    withReply({
      renderedReplies: [
        { text: "Hello from yesterday. isola-run-OLDRUN", senderLabel: "Ada", senderKind: "human", messageRef: "m-2" },
      ],
    }),
  );
  assert.equal(r.status, "FAIL");
});

test("an unknown sender kind cannot pass", () => {
  const r = judgeCheck16(
    withReply({
      renderedReplies: [
        { text: `Hi. ${MARKER}`, senderLabel: "Support", senderKind: "unknown", messageRef: null },
      ],
    }),
  );
  assert.equal(r.status, "FAIL");
});

test("check 16 passes on exactly one visibly-human current-run reply", () => {
  const r = judgeCheck16(withReply());
  assert.equal(r.status, "PASS");
  assert.match(r.detail, /exactly one human reply/i);
  assert.match(r.detail, /conv-42/);
});

test("check 16 is NOT RUN when no browser evidence exists at all", () => {
  assert.equal(judgeCheck16(null).status, "NOT RUN");
});

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

const BASE_INPUT = {
  portalApp: "https://app.example",
  portalApi: "https://api.example",
  syntheticAccounts: ["customer-zero@epic.dm"],
  syntheticTenants: ["AVQLG3L"],
  tenantId: "AVQLG3L",
};

const REAL_EMAIL = "a.real.person@bigcustomer.example";
const REAL_TENANT = "REALTEN";

test("an undeclared account stops before browser launch and echoes no address", async () => {
  await assert.rejects(
    () =>
      runBrowserChecks({
        ...BASE_INPUT,
        credential: { email: REAL_EMAIL, password: "irrelevant" },
        // A path that cannot exist: if a browser were launched, this throws a
        // different error and the assertions below fail.
        chromiumPath: "C:/definitely/not/here/chrome.exe",
      }),
    (err: unknown) => {
      assert.ok(err instanceof SyntheticGuardRefusal);
      assert.equal((err as SyntheticGuardRefusal).kind, "account");
      assert.doesNotMatch((err as Error).message, /bigcustomer|a\.real\.person/);
      assert.ok((err as SyntheticGuardRefusal).ref.length > 0);
      return true;
    },
  );
});

test("an undeclared tenant stops before browser launch and echoes no identifier", async () => {
  await assert.rejects(
    () =>
      runBrowserChecks({
        ...BASE_INPUT,
        tenantId: REAL_TENANT,
        credential: { email: "customer-zero@epic.dm", password: "irrelevant" },
        chromiumPath: "C:/definitely/not/here/chrome.exe",
      }),
    (err: unknown) => {
      assert.ok(err instanceof SyntheticGuardRefusal);
      assert.equal((err as SyntheticGuardRefusal).kind, "tenant");
      assert.doesNotMatch((err as Error).message, new RegExp(REAL_TENANT));
      return true;
    },
  );
});

test("END TO END: an undeclared account surfaces through the harness without passing or leaking", async () => {
  const ctx: CheckContext = {
    ...DEFAULT_CONTEXT,
    portalCredential: { email: REAL_EMAIL, password: "irrelevant" },
    fetch: globalThis.fetch,
  };
  for (const n of [11, 16]) {
    const result = await CHECKS.find((c) => c.n === n)!.run!(ctx);
    assert.notEqual(result.status, "PASS", `check ${n} must not pass`);
    assert.notEqual(result.status, "NOT RUN", `check ${n} must not look like an ordinary prerequisite gap`);
    assert.match(result.detail, /REFUSED/);
    assert.doesNotMatch(result.detail, /bigcustomer|a\.real\.person/);
  }
});

test("END TO END: an undeclared tenant surfaces through the harness without passing or leaking", async () => {
  const ctx: CheckContext = {
    ...DEFAULT_CONTEXT,
    browserTenantId: REAL_TENANT,
    portalCredential: { email: "customer-zero@epic.dm", password: "irrelevant" },
    fetch: globalThis.fetch,
  };
  for (const n of [11, 16]) {
    const result = await CHECKS.find((c) => c.n === n)!.run!(ctx);
    assert.notEqual(result.status, "PASS");
    assert.notEqual(result.status, "NOT RUN");
    assert.match(result.detail, /REFUSED/);
    assert.doesNotMatch(result.detail, new RegExp(REAL_TENANT));
  }
});

test("the declared synthetic tenant set covers the tenant the browser checks target", () => {
  assert.ok(
    DEFAULT_CONTEXT.syntheticTenants.includes(DEFAULT_CONTEXT.browserTenantId),
    "browserTenantId must be declared synthetic or every run refuses",
  );
});

test("missing credential remains NOT RUN, and launches nothing", async () => {
  const r = await runBrowserChecks({ ...BASE_INPUT, chromiumPath: "C:/definitely/not/here/chrome.exe" });
  assert.equal(r.check11.status, "NOT RUN");
  assert.equal(r.check16.status, "NOT RUN");
  assert.equal(r.browser, "none");
});

test("missing Chromium remains NOT RUN", async () => {
  // `chromiumPath: null` means "discovery already ran and found nothing", which
  // is exactly the state this must handle. Passing a bogus path instead would
  // let a machine with Chromium installed launch a real browser during a unit
  // test, so the miss is modelled explicitly rather than by absence.
  const r = await runBrowserChecks({
    ...BASE_INPUT,
    credential: { email: "customer-zero@epic.dm", password: "irrelevant" },
    chromiumPath: null,
  });
  assert.equal(r.check11.status, "NOT RUN");
  assert.equal(r.check16.status, "NOT RUN");
  assert.match(r.check11.detail, /no Chromium binary found/i);
  assert.equal(r.browser, "none");
  assert.deepEqual(r.artifacts, []);
});

test("browser checks report NOT RUN, not PASS, when no credential is supplied to the harness", async () => {
  const ctx: CheckContext = { ...DEFAULT_CONTEXT, fetch: globalThis.fetch };
  for (const n of [11, 16]) {
    const result = await CHECKS.find((c) => c.n === n)!.run!(ctx);
    assert.equal(result.status, "NOT RUN");
  }
});

test("checks 11 and 16 stay wired to a runner, not a hard-coded status", () => {
  for (const n of [11, 16]) {
    const check = CHECKS.find((c) => c.n === n);
    assert.ok(check);
    assert.equal(typeof check!.run, "function");
    assert.equal(check!.blocked, undefined);
  }
});

test("the account guard still refuses directly", () => {
  const ctx: CheckContext = { ...DEFAULT_CONTEXT, fetch: globalThis.fetch };
  assert.throws(() => assertSyntheticAccount(ctx, REAL_EMAIL), /not in the declared synthetic account list/);
});

test("chromium discovery returns null rather than guessing a path", () => {
  assert.equal(findChromium({ ISOLA_CHROMIUM_PATH: "C:/definitely/not/here/chrome.exe" } as NodeJS.ProcessEnv), null);
});

test("an explicit chromium path suppresses cache probing", () => {
  assert.deepEqual(chromiumSearchRoots({ ISOLA_CHROMIUM_PATH: "/x/chrome" } as NodeJS.ProcessEnv), []);
});
