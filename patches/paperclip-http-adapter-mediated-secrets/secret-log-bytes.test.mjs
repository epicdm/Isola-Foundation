/**
 * FINAL-BYTES test for the secrets-route logging policy.
 *
 * Every earlier attempt at this fix was tested by inspecting a helper's return
 * value, and every one of them passed while a credential still reached the log
 * — through `toJSON` at serialisation, through pino's own `err` serialiser,
 * through `errorContext`, through `msg`. So this test does not call the policy
 * helpers at all. It builds a REAL pino-http logger writing to a real stream,
 * drives real request/response objects through it, and greps the emitted JSON
 * line for planted canaries.
 *
 * Layout to run:
 *   ./secret-route-log-policy.js
 *   ./secret-log-bytes.test.mjs
 *   (pino + pino-http resolvable)
 *
 *   node secret-log-bytes.test.mjs
 */
import { Writable } from "node:stream";
import { pino } from "pino";
import { pinoHttp } from "pino-http";
import {
  isSecretBearingRequest,
  safeSecretRouteLogProps,
  safeSecretRouteError,
  classifyError,
  SAFE_SECRET_ROUTE_MESSAGE,
} from "./secret-route-log-policy.js";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS  " + n)) : (fail++, console.log("  FAIL  " + n)); };

// Distinct canary per surface, so a leak names its own route in.
const C = {
  body:      "CANARY-BODY-11111111",
  query:     "CANARY-QUERY-22222222",
  params:    "CANARY-PARAMS-33333333",
  authz:     "CANARY-AUTHZ-44444444",
  errMsg:    "CANARY-ERRMSG-55555555",
  errStack:  "CANARY-ERRSTACK-66666666",
  causeMsg:  "CANARY-CAUSEMSG-77777777",
  causeStk:  "CANARY-CAUSESTACK-88888888",
  errProp:   "CANARY-ERRPROP-99999999",
  ctxError:  "CANARY-CTXERROR-AAAAAAAA",
  customMsg: "CANARY-CUSTOMMSG-BBBBBBBB",
};
const ALL = Object.values(C);

// --- a real logger writing to a buffer we can read back -------------------
function makeLogger() {
  const lines = [];
  const sink = new Writable({
    write(chunk, _enc, cb) { lines.push(chunk.toString("utf8")); cb(); },
  });
  const logger = pino({
    level: "debug",
    redact: [
      "req.headers.authorization", "req.headers.cookie",
      "req.body.value", "req.body.secret", "req.body.password", "req.body.token",
      "req.query.token", "req.query.value",
      "reqBody.value", "reqBody.secret", "reqBody.password", "reqBody.token",
    ],
  }, sink);

  const httpLogger = pinoHttp({
    logger,
    serializers: {
      // Pino's DEFAULT req serializer emits req.params and req.query — a path
      // into the record that customProps cannot influence. This mirrors the
      // production logger exactly.
      req(req) {
        if (isSecretBearingRequest(req)) {
          return { id: req.id, method: req.method, url: req.route?.path ?? "[secrets route]" };
        }
        return pinoHttp.stdSerializers.req(req);
      },
    },
    customLogLevel(_req, res, err) {
      // The `err` ARGUMENT cannot be replaced, only emptied — mirrors production.
      if (err && isSecretBearingRequest(_req)) {
        try {
          err.message = SAFE_SECRET_ROUTE_MESSAGE;
          err.stack = `${err.name ?? "Error"}: ${SAFE_SECRET_ROUTE_MESSAGE}`;
          for (const k of Object.keys(err)) { if (k !== "name") delete err[k]; }
          // `cause` is NON-ENUMERABLE — mirrors production.
          try { delete err.cause; } catch {}
          if ("cause" in err) {
            try { Object.defineProperty(err, "cause", { value: undefined, enumerable: false, configurable: true }); } catch {}
          }
        } catch {}
      }
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    customSuccessMessage(req, res) {
      // req.url carries the QUERY STRING — mirrors production.
      if (isSecretBearingRequest(req)) {
        return `${req.method} ${req.route?.path ?? "[secrets route]"} ${res.statusCode}`;
      }
      return `${req.method} ${req.url} ${res.statusCode}`;
    },
    customErrorMessage(req, res, err) {
      if (isSecretBearingRequest(req)) {
        return `${req.method} ${req.route?.path ?? "[secrets route]"} ${res.statusCode} — ${SAFE_SECRET_ROUTE_MESSAGE}`;
      }
      const ctx = res.__errorContext;
      const errMsg = ctx?.error?.message || err?.message || res.err?.message || "unknown error";
      return `${req.method} ${req.url} ${res.statusCode} — ${errMsg}`;
    },
    customProps(req, res) {
      if (isSecretBearingRequest(req)) {
        if (res.statusCode >= 400 && res.err) {
          res.err = safeSecretRouteError(res.statusCode, res.err);
        }
        if (res.statusCode < 400) return { secretsRoute: true };
        return safeSecretRouteLogProps({
          routePath: req.route?.path,
          method: req.method,
          companyId: req.params?.companyId,
          statusCode: res.statusCode,
          requestId: req.id,
          errorCode: classifyError(res.__errorContext?.error ?? res.err, res.statusCode),
        });
      }
      if (res.statusCode >= 400) {
        const ctx = res.__errorContext;
        if (ctx) {
          return { errorContext: ctx.error, reqBody: ctx.reqBody, reqParams: ctx.reqParams, reqQuery: ctx.reqQuery };
        }
        const props = {};
        const { body, params, query } = req;
        if (body && typeof body === "object" && Object.keys(body).length > 0) props.reqBody = body;
        if (params && typeof params === "object" && Object.keys(params).length > 0) props.reqParams = params;
        if (query && typeof query === "object" && Object.keys(query).length > 0) props.reqQuery = query;
        if (req.route?.path) props.routePath = req.route.path;
        return props;
      }
      return {};
    },
  });
  return { httpLogger, lines };
}

/** Drive one request through the real middleware and return the emitted bytes. */
function emit({ url, status, attachErrorContext, attachErr, hostile, errArgument }) {
  const { httpLogger, lines } = makeLogger();
  const req = {
    method: "POST",
    url,
    originalUrl: url,
    id: "req-abc-123",
    headers: { authorization: "Bearer " + C.authz, "content-type": "application/json" },
    body: { name: "Runtime", key: "RUNTIME_SECRET", value: C.body },
    query: { token: C.query },
    params: { companyId: "3ed3869b-463c-4876-8e16-ddc058f06cd9", id: C.params },
    route: { path: "/companies/:companyId/secrets" },
    socket: { remoteAddress: "127.0.0.1" },
    httpVersion: "1.1",
  };
  if (hostile) {
    Object.defineProperty(req.body, "hostileGetter", { enumerable: true, get() { throw new Error("boom " + C.body); } });
    req.body.self = req.body;                                  // cycle
    req.body.toJSON = () => ({ value: C.body });               // re-introduction at serialise time
    req.proxied = new Proxy({}, { ownKeys() { throw new Error("ownKeys " + C.body); } });
  }

  const listeners = {};
  const res = {
    statusCode: status,
    getHeader: () => undefined, setHeader: () => {}, getHeaders: () => ({}),
    on(ev, fn) { listeners[ev] = fn; },
    removeListener() {}, once(ev, fn) { listeners[ev] = fn; },
    writableEnded: true,
  };

  if (attachErr) {
    const cause = new Error("cause " + C.causeMsg);
    cause.stack = "Error: cause " + C.causeMsg + "\n    at " + C.causeStk;
    const err = new Error("boom " + C.errMsg, { cause });
    err.stack = "Error: boom " + C.errMsg + "\n    at " + C.errStack;
    err.secretProp = C.errProp;
    err.body = { value: C.body };
    res.err = err;
  }
  if (attachErrorContext) {
    const ctxErr = new Error("ctx " + C.ctxError);
    ctxErr.token = C.ctxError;
    res.__errorContext = {
      error: ctxErr, method: "POST", url,
      reqBody: { value: C.body }, reqParams: { id: C.params }, reqQuery: { token: C.query },
    };
  }

  // pino-http's third parameter is `next`, not an error. The `err` ARGUMENT
  // reaches it through the response's own 'error' event, which is exactly the
  // path customProps cannot influence — so it must be driven that way here.
  httpLogger(req, res, () => {});
  if (errArgument && listeners.error) listeners.error(errArgument);
  else if (listeners.finish) listeners.finish();
  else if (listeners.close) listeners.close();
  return lines.join("");
}

function assertClean(label, bytes, mustContain) {
  // The event must actually have been captured — otherwise "canary absent" is
  // just "nothing was logged", which proves nothing at all.
  ok(label + ": a log line WAS emitted", bytes.length > 0);
  for (const m of mustContain) {
    ok(label + `: safe marker ${JSON.stringify(m)} present`, bytes.includes(m));
  }
  const leaked = ALL.filter((c) => bytes.includes(c));
  ok(label + ": no canary in the emitted bytes" + (leaked.length ? " -> LEAKED " + leaked.join(", ") : ""), leaked.length === 0);
}

const SECRETS_URL = "/api/companies/3ed3869b-463c-4876-8e16-ddc058f06cd9/secrets";

console.log("== secrets route, 400 (validation) ==");
assertClean("400", emit({ url: SECRETS_URL, status: 400 }), ["secretsRoute", "400", "ValidationError"]);

console.log("== secrets route, 409 (duplicate key) ==");
assertClean("409", emit({ url: SECRETS_URL, status: 409 }), ["secretsRoute", "409", "ConflictError"]);

console.log("== secrets route, 500 with err + __errorContext + cause chain ==");
assertClean("500", emit({ url: SECRETS_URL, status: 500, attachErr: true, attachErrorContext: true }),
  ["secretsRoute", "500"]);

console.log("== secrets route, 500 with HOSTILE body (cycle, toJSON, getter, proxy) ==");
{
  let threw = false, bytes = "";
  try { bytes = emit({ url: SECRETS_URL, status: 500, attachErr: true, attachErrorContext: true, hostile: true }); }
  catch { threw = true; }
  ok("hostile body: logging did not throw", threw === false);
  assertClean("hostile", bytes, ["secretsRoute"]);
}

console.log("== secrets route, 201 success ==");
{
  const bytes = emit({ url: SECRETS_URL, status: 201 });
  ok("201: a log line WAS emitted", bytes.length > 0);
  const leaked = ALL.filter((c) => bytes.includes(c));
  ok("201: no canary in the emitted bytes" + (leaked.length ? " -> LEAKED " + leaked.join(", ") : ""), leaked.length === 0);
}

console.log("== REVIEW dc614d2 (1): the QUERY STRING must not reach top-level msg ==");
{
  const url = SECRETS_URL + "?value=" + C.body + "&token=" + C.query;
  for (const st of [201, 400, 409]) {
    const bytes = emit({ url, status: st });
    ok(`msg leak, status ${st}: a log line WAS emitted`, bytes.length > 0);
    const leaked = ALL.filter((c) => bytes.includes(c));
    ok(`msg leak, status ${st}: query string absent from the emitted bytes` +
       (leaked.length ? " -> LEAKED " + leaked.join(", ") : ""), leaked.length === 0);
  }
}

console.log("== REVIEW dc614d2 (2,3): case / percent-encoded / double-slash variants ==");
for (const [label, url] of [
  ["UPPERCASE", "/api/companies/acme/SECRETS"],
  ["percent-encoded", "/api/companies/acme/%73ecrets"],
  ["double-encoded", "/api/companies/acme/%2573ecrets"],
  ["repeated slashes", "//api//companies//acme//secrets"],
]) {
  const bytes = emit({ url, status: 400 });
  ok(`${label}: a log line WAS emitted`, bytes.length > 0);
  const leaked = ALL.filter((c) => bytes.includes(c));
  ok(`${label}: treated as a secrets route, no canary` +
     (leaked.length ? " -> LEAKED " + leaked.join(", ") : ""), leaked.length === 0);
}

console.log("== REVIEW dc614d2 (4): the err ARGUMENT (res.on('error')) path ==");
{
  const cause = new Error("cause " + C.causeMsg);
  const argErr = new Error("stream failure " + C.errMsg, { cause });
  argErr.stack = "Error: stream failure " + C.errMsg + " at " + C.errStack;
  argErr.secretProp = C.errProp;
  const bytes = emit({ url: SECRETS_URL, status: 500, errArgument: argErr });
  ok("err-argument: a log line WAS emitted", bytes.length > 0);
  const leaked = ALL.filter((c) => bytes.includes(c));
  ok("err-argument: no canary in the emitted bytes" +
     (leaked.length ? " -> LEAKED " + leaked.join(", ") : ""), leaked.length === 0);
}

console.log("== UNRELATED route still logs its detail (no global suppression) ==");
{
  const bytes = emit({ url: "/api/companies/3ed3869b/issues", status: 400 });
  ok("unrelated route: a log line WAS emitted", bytes.length > 0);
  ok("unrelated route: reqBody IS still logged", bytes.includes("reqBody"));
  ok("unrelated route: routePath still logged", bytes.includes("routePath"));
}

console.log("== the request/response objects must not be mutated ==");
{
  const { httpLogger } = makeLogger();
  const body = { value: C.body };
  const req = { method:"POST", url:SECRETS_URL, originalUrl:SECRETS_URL, id:"r", headers:{}, body,
                query:{}, params:{}, route:{path:"/companies/:companyId/secrets"},
                socket:{remoteAddress:"127.0.0.1"}, httpVersion:"1.1" };
  const before = JSON.stringify(body);
  const listeners = {};
  const res = { statusCode:409, getHeader:()=>undefined, setHeader:()=>{}, getHeaders:()=>({}),
                on:(e,f)=>{listeners[e]=f;}, once:(e,f)=>{listeners[e]=f;}, removeListener(){}, writableEnded:true };
  httpLogger(req, res); if (listeners.finish) listeners.finish();
  ok("req.body unchanged", JSON.stringify(body) === before);
  ok("req.body still holds its value", body.value === C.body);
}


console.log("== DRIFT CONTROL: the shipped logger must carry every mechanism ==");
{
  // The reviewer was right that the previous "drift check" was a shell grep I
  // ran by hand, not an assertion. If the shipped logger lost a protection
  // while this harness kept its copy, every test above would still pass and
  // the deployed service would leak. So the shipped file is read and asserted.
  const { readFileSync, existsSync } = await import("node:fs");
  const candidates = ["./logger.js", "../logger.js", "/app/server/dist/middleware/logger.js"];
  const found = candidates.find((c) => existsSync(c));
  ok("shipped logger.js is readable (otherwise this control proves nothing)", Boolean(found));
  if (found) {
    const src = readFileSync(found, "utf8");
    const REQUIRED = [
      ["route-level classification", "isSecretBearingRequest("],
      ["route-aware req serializer", "stdSerializers.req"],
      ["success message not req.url", "customSuccessMessage"],
      ["error message replaced", "SAFE_SECRET_ROUTE_MESSAGE"],
      ["allowlist props", "safeSecretRouteLogProps"],
      ["res.err swapped", "safeSecretRouteError"],
      ["non-enumerable cause cleared", "delete err.cause"],
    ];
    for (const [label, needle] of REQUIRED) {
      ok(`shipped logger has: ${label}`, src.includes(needle));
    }
    // NEGATIVE CONTROL: the assertion must be capable of FAILING.
    ok("drift control can fail (a fabricated mechanism is absent)",
       src.includes("THIS_MECHANISM_DOES_NOT_EXIST") === false);
  }
}

console.log("");
console.log("  SCANNER CONTROL — a planted canary IS findable in bytes that contain it: " +
  (('{"x":"' + C.body + '"}').includes(C.body) ? "PASS" : "FAIL — every absence check above is void"));
console.log("");
console.log(`RESULT ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
