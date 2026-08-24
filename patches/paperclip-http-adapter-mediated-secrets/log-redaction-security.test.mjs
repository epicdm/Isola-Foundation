import { redactSecretValuesForLogs, isSecretLogKey, SECRET_LOG_REPLACEMENT } from "./log-redaction.js";

/**
 * Security proofs for the log redactor that keeps credential values out of
 * Paperclip's logs on failed requests.
 *
 * Run from a directory containing log-redaction.js and this file:
 *   node log-redaction-security.test.mjs      # expects 0 failed
 *
 * The sections marked ADVERSARIAL REVIEW pin defects found by independent
 * review of the FIRST version of this redactor. Each one was a case where the
 * log looked redacted and was not.
 */
const D = "planted-dummy-value-4e7a91";
let p = 0, f = 0;
const ok = (n, c) => { c ? (p++, console.log("  PASS  " + n)) : (f++, console.log("  FAIL  " + n)); };
const J = (x) => JSON.stringify(x);
/** The real test: does the value survive ANYWHERE in what would be logged? */
const clean = (x) => !J(redactSecretValuesForLogs(x)).includes(D);

console.log("== the secrets request body: value redacted, identifiers kept ==");
{
  const r = redactSecretValuesForLogs({ name: "My Secret", key: "RUNTIME_SECRET", value: D, description: "desc" });
  ok("value redacted", r.value === SECRET_LOG_REPLACEMENT);
  ok("value absent entirely", !J(r).includes(D));
  ok("key NAME preserved", r.key === "RUNTIME_SECRET");
  ok("name preserved", r.name === "My Secret");
  ok("description preserved", r.description === "desc");
}

console.log("== ADVERSARIAL REVIEW (b): snake / kebab / mixed-case variants ==");
for (const k of [
  "secret_value", "access_token", "refresh_token", "client_secret", "private_key",
  "API_KEY", "api-key", "Api_Key", "SECRET-VALUE", "sessionKey", "bearerToken",
  "password", "passphrase", "credential", "authorization", "Cookie", "set-cookie",
]) {
  ok(`${k} redacted`, clean({ [k]: D }) && redactSecretValuesForLogs({ [k]: D })[k] === SECRET_LOG_REPLACEMENT);
}
console.log("  -- and names that must NOT be redacted (over-redaction destroys logs) --");
for (const k of ["author", "valueCount", "keyName", "tokenizer_note", "description", "name", "key", "status", "companyId"]) {
  const r = redactSecretValuesForLogs({ [k]: "keepme" });
  const expected = k === "tokenizer_note"; // contains "token" — accepted over-redaction
  ok(`${k} ${expected ? "redacted (accepted)" : "PRESERVED"}`, (r[k] === SECRET_LOG_REPLACEMENT) === expected);
}

console.log("== ADVERSARIAL REVIEW (c): a toJSON must not re-introduce the value ==");
{
  const body = { key: "K", name: "N", value: D, toJSON() { return { key: "K", value: D }; } };
  const r = redactSecretValuesForLogs(body);
  ok("toJSON is not copied onto the clone", typeof r.toJSON !== "function");
  ok("JSON.stringify of the clone has no value", !J(r).includes(D));
}

console.log("== ADVERSARIAL REVIEW (d): accessors are described, never invoked ==");
{
  let invoked = false;
  const body = {};
  Object.defineProperty(body, "diagnostic", { enumerable: true, get() { invoked = true; return D; } });
  const r = redactSecretValuesForLogs(body);
  ok("getter was NOT invoked", invoked === false);
  ok("accessor value absent", !J(r).includes(D));
}
{
  const body = {};
  Object.defineProperty(body, "note", { enumerable: true, get() { throw new Error("boom " + D); } });
  let threw = false, out = null;
  try { out = redactSecretValuesForLogs(body); } catch { threw = true; }
  ok("a throwing getter does not take the logger down", threw === false);
  ok("throwing getter leaks nothing", out !== null && !J(out).includes(D));
}

console.log("== ADVERSARIAL REVIEW (e): Errors and class instances ==");
{
  const r = redactSecretValuesForLogs({ diagnostic: Object.assign(new Error("boom"), { value: D }) });
  ok("Error's own secret prop redacted", !J(r).includes(D));
  ok("Error message preserved", J(r).includes("boom"));
}
{
  const inner = Object.assign(new Error("inner"), { token: D });
  const outer = new Error("outer", { cause: inner });
  const r = redactSecretValuesForLogs(outer);
  ok("nested Error cause redacted", !J(r).includes(D));
  ok("cause chain preserved structurally", J(r).includes("inner"));
}
{
  class Cfg { constructor() { this.name = "cfg"; this.apiKey = D; } }
  ok("class instance redacted", clean(new Cfg()));
  ok("class instance keeps safe fields", redactSecretValuesForLogs(new Cfg()).name === "cfg");
}
{
  const np = Object.create(null); np.value = D; np.key = "K";
  ok("null-prototype object redacted", clean(np));
}

console.log("== inherited properties must not leak ==");
{
  Object.prototype.value = D;
  const r = redactSecretValuesForLogs({ key: "K" });
  delete Object.prototype.value;
  ok("inherited secret is not copied", !J(r).includes(D));
}

console.log("== nested / array / exotic containers ==");
ok("nested object", clean({ a: { b: { value: D } } }));
ok("inside array", clean({ items: [{ value: D }, { token: D }] }));
ok("array at root", clean([{ value: D }]));
ok("Map is described, not traversed", clean({ m: new Map([["value", D]]) }));
ok("Set is described, not traversed", clean({ s: new Set([D]) }));
ok("Buffer is described", typeof Buffer !== "undefined" ? clean({ b: Buffer.from(D) }) : true);
ok("Date survives as ISO", typeof redactSecretValuesForLogs({ d: new Date(0) }).d === "string");

console.log("== safe diagnostic data is NOT destroyed ==");
{
  const safe = { companyId: "3ed3869b", routePath: "/companies/:companyId/secrets", status: 409,
                 error: "Secret already exists", count: 3, ok: false, nested: { id: "abc" } };
  const r = redactSecretValuesForLogs(safe);
  ok("companyId kept", r.companyId === "3ed3869b");
  ok("routePath kept", r.routePath === "/companies/:companyId/secrets");
  ok("status kept", r.status === 409);
  ok("error classification kept", r.error === "Secret already exists");
  ok("primitives kept", r.count === 3 && r.ok === false);
  ok("nested non-secret kept", r.nested.id === "abc");
}

console.log("== robustness: nothing here may throw or hang ==");
ok("null / undefined", redactSecretValuesForLogs(null) === null && redactSecretValuesForLogs(undefined) === undefined);
ok("plain string", redactSecretValuesForLogs("hello") === "hello");
{ const deep = (n) => (n === 0 ? { value: D } : { a: deep(n - 1) });
  ok("depth-limited and still clean", clean(deep(30))); }
{ const cyc = { value: D }; cyc.self = cyc;
  let threw = false, out = null;
  try { out = redactSecretValuesForLogs(cyc); } catch { threw = true; }
  ok("cyclic input does not hang or throw", threw === false && !J(out).includes(D)); }
{ const shared = { key: "K" }; ok("a DAG is not mistaken for a cycle", J(redactSecretValuesForLogs({ a: shared, b: shared })).includes("K")); }

console.log("== the live request object must NOT be mutated (it is still in flight) ==");
{
  const body = { key: "K", value: D, nested: { token: D } };
  const before = J(body);
  redactSecretValuesForLogs(body);
  ok("request object unchanged", J(body) === before);
  ok("original still holds its value", body.value === D);
}

console.log("== isSecretLogKey is exported and behaves ==");
ok("isSecretLogKey('value')", isSecretLogKey("value") === true);
ok("isSecretLogKey('author')", isSecretLogKey("author") === false);

console.log("");
console.log("  CONTROL: the dummy is findable in a string containing it: " +
  (("x " + D).includes(D) ? "PASS" : "FAIL — every absence check above is void"));
console.log("");
console.log(`RESULT ${p} passed, ${f} failed`);
process.exit(f === 0 ? 0 : 1);
