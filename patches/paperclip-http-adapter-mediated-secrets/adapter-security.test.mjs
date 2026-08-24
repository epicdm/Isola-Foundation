import { resolveHeaderValue, resolveHeaders, execute } from "./adapters/http/execute.js";

const CANARY = "not-a-real-credential-fixture-b41d77e2";
let pass = 0, fail = 0;
const ok  = (n, c) => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n); } };
const throws = (n, fn, mustContain, mustNotContain) => {
  try { fn(); fail++; console.log("  FAIL  " + n + " (did not throw)"); }
  catch (e) {
    const m = e.message;
    const good = (!mustContain || m.includes(mustContain)) && (!mustNotContain || !m.includes(mustNotContain));
    if (good) { pass++; console.log("  PASS  " + n); }
    else { fail++; console.log("  FAIL  " + n + " -> " + m); }
  }
};

console.log("== literal headers are unchanged (every existing agent keeps working) ==");
ok("plain string passes through", resolveHeaderValue("X-A", "literal-value", {}) === "literal-value");
ok("empty string is allowed as a literal", resolveHeaderValue("X-A", "", {}) === "");
const mixed = resolveHeaders({ "X-Plain": "abc", "Authorization": { $env: "RUNTIME_SECRET" } }, { RUNTIME_SECRET: CANARY });
ok("literal + reference resolve together", mixed["X-Plain"] === "abc" && mixed["Authorization"] === CANARY);

console.log("== the reference resolves ONLY from mediated config.env ==");
ok("resolves from mediated env", resolveHeaderValue("Authorization", { $env: "K" }, { K: CANARY }) === CANARY);

console.log("== process.env is NEVER a source ==");
process.env.LEAK_PROBE_VAR = CANARY;
throws("a reference to a real process.env var is refused",
  () => resolveHeaderValue("Authorization", { $env: "LEAK_PROBE_VAR" }, {}),
  "not present", CANARY);
delete process.env.LEAK_PROBE_VAR;

console.log("== fail closed on missing / malformed / ambiguous ==");
throws("missing key fails closed", () => resolveHeaderValue("Authorization", { $env: "NOPE" }, {}), "not present");
throws("empty resolved value fails closed", () => resolveHeaderValue("Authorization", { $env: "K" }, { K: "" }), "not present");
throws("non-string resolved value fails closed", () => resolveHeaderValue("Authorization", { $env: "K" }, { K: 123 }), "not present");
throws("ambiguous (extra key) refused", () => resolveHeaderValue("Authorization", { $env: "K", value: "x" }, { K: CANARY }), "exactly one key", CANARY);
throws("nested reference refused", () => resolveHeaderValue("Authorization", { $env: { $env: "K" } }, { K: CANARY }), "non-string", CANARY);
throws("array refused", () => resolveHeaderValue("Authorization", ["K"], {}), "must be a string");
throws("number refused", () => resolveHeaderValue("Authorization", 42, {}), "must be a string");
throws("null refused", () => resolveHeaderValue("Authorization", null, {}), "must be a string");
throws("empty $env name refused", () => resolveHeaderValue("Authorization", { $env: "  " }, {}), "empty");
throws("wrong key name refused", () => resolveHeaderValue("Authorization", { env: "K" }, { K: CANARY }), "exactly one key", CANARY);

console.log("== the value NEVER appears in an error message ==");
let seen = "";
try { resolveHeaderValue("Authorization", { $env: "K", extra: 1 }, { K: CANARY }); } catch (e) { seen = e.message; }
ok("ambiguity error omits the value", seen.length > 0 && !seen.includes(CANARY));
ok("ambiguity error names the header", seen.includes("Authorization"));

console.log("== another company's env cannot resolve it (env is the only scope) ==");
throws("empty env (other tenant) cannot resolve", () => resolveHeaderValue("Authorization", { $env: "K" }, {}), "not present", CANARY);

console.log("== fails BEFORE any outbound request ==");
let fetched = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetched = true; return { ok: true, status: 200 }; };
try {
  await execute({ runId: "r", agent: { id: "a" }, context: {},
    config: { url: "http://upstream.invalid/x", headers: { Authorization: { $env: "MISSING" } }, env: {} } });
  fail++; console.log("  FAIL  execute should have thrown");
} catch (e) {
  ok("execute threw on a bad reference", true);
  ok("NO outbound request was made", fetched === false);
  ok("execute error omits the value", !e.message.includes(CANARY));
}

console.log("== the upstream receives the correctly resolved header ==");
let capturedAuth = null, capturedPlain = null;
globalThis.fetch = async (_u, init) => { capturedAuth = init.headers["Authorization"]; capturedPlain = init.headers["X-Plain"]; return { ok: true, status: 200 }; };
await execute({ runId: "r", agent: { id: "a" }, context: {},
  config: { url: "http://upstream.invalid/x",
            headers: { Authorization: { $env: "RUNTIME_SECRET" }, "X-Plain": "keepme" },
            env: { RUNTIME_SECRET: CANARY } } });
ok("upstream got the resolved secret", capturedAuth === CANARY);
ok("literal header still delivered", capturedPlain === "keepme");
globalThis.fetch = realFetch;

console.log("== the config object is not mutated (nothing persists back) ==");
const cfg = { url: "http://u.invalid", headers: { Authorization: { $env: "K" } }, env: { K: CANARY } };
resolveHeaders(cfg.headers, cfg.env);
ok("config.headers still holds only the REFERENCE", JSON.stringify(cfg.headers) === JSON.stringify({ Authorization: { $env: "K" } }));
ok("serialised config does not contain the value", !JSON.stringify(cfg.headers).includes(CANARY));

console.log("");
console.log("  CONTROL: the canary is findable in a string that contains it: " +
  (("x " + CANARY).includes(CANARY) ? "PASS" : "FAIL - all absence checks void"));
console.log("");
console.log(`RESULT ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
