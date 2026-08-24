/**
 * SECRETS-ROUTE LOGGING POLICY.
 *
 * A failed `POST /api/companies/{id}/secrets` was writing the whole request
 * body — secret value in clear — to the service log at WARN. A 201 did not;
 * only the failure path did, which is worse than it sounds, because a 409
 * means "this key already exists", exactly when an operator retries with the
 * same value.
 *
 * WHY THIS IS AN ALLOWLIST AND NOT A SANITISER.
 *
 * The first attempt at this fix was a recursive redactor that walked the
 * request body and error and replaced anything credential-shaped. Three rounds
 * of adversarial review broke it every time — `toJSON` re-introducing the value
 * at serialisation, getters firing during enumeration, `cause` chains, Proxy
 * traps throwing with the secret in the message, `reqQuery` never covered,
 * pino's own `err` serialiser emitting `message` and `stack` regardless. Each
 * fix revealed another path into the log record.
 *
 * The lesson is that sanitising an arbitrary object graph is an open-ended
 * problem: it can only ever remove the leaks somebody has thought of. So this
 * module does the opposite. On a secrets route it CONSTRUCTS a new object from
 * a fixed list of safe scalars and emits that. Nothing is enumerated, nothing
 * is traversed, nothing is copied. A field that is not on the list below
 * cannot reach the log by any route, however it is nested, proxied or
 * serialised.
 *
 * The trade is deliberate: less detail in the log for these few routes, in
 * exchange for a property that can be stated in one sentence and tested at the
 * bytes.
 */

/**
 * Routes whose request body or error may carry a credential.
 *
 * Matched on the ORIGINAL url path, so it holds even when `req.route` is not
 * populated — which is the case for a 404 or a body-parser failure, both of
 * which happen before routing completes.
 */
/**
 * Matched as a path SEGMENT, deliberately NOT anchored at `^/api`.
 *
 * Anchoring was a blocking defect: an absolute-form request target
 * (`http://host/api/.../secrets`) and a mounted-router prefix
 * (`/paperclip/api/.../secrets`) both reach the secrets handler while an
 * anchored matcher calls them ordinary routes — and an ordinary route logs the
 * whole body. The trailing `(?:\/|$)` keeps `/secretsanity` from matching, so
 * loosening the left side does not loosen the right.
 */
const SECRET_BEARING_PATHS = [
  /\/secrets(?:\/|$)/i,
  /\/secret-provider-configs(?:\/|$)/i,
  /\/agents\/[^/]+\/keys(?:\/|$)/i,
];

/** The message emitted in place of any real error text on these routes. */
export const SAFE_SECRET_ROUTE_MESSAGE =
  "secrets-route request failed; detail withheld because this route may carry a credential";

/**
 * Normalise a url path before matching.
 *
 * Three ways a secrets request could MISS this policy and fall through to the
 * ordinary logging path, all found by review:
 *   - CASE. Express routing is case-insensitive by default, so
 *     `/api/companies/x/SECRETS` reaches the secrets handler while a
 *     case-sensitive matcher says it is an ordinary route.
 *   - PERCENT-ENCODING. `/api/companies/x/%73ecrets` is the same resource to
 *     the router and a different string to a naive matcher.
 *   - REPEATED SLASHES. `//api//companies//x//secrets` likewise.
 *
 * A miss here is not a cosmetic difference: it means the request body reaches
 * the ordinary `customProps` branch and is logged in full. So normalisation is
 * deliberately generous, and matching is the safe direction to over-apply.
 */
function normalisePathForMatch(url) {
  let raw = url.split("?")[0] ?? url;
  // ABSOLUTE-FORM REQUEST TARGET. RFC 7230 permits `POST http://host/path`,
  // and Node exposes it verbatim on req.url. Strip the origin so the path is
  // compared, not the scheme and authority.
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(raw);
  if (origin) raw = raw.slice(origin[0].length) || "/";
  let decoded = raw;
  // Decode repeatedly: a doubly-encoded path (%2573) decodes to %73 and then
  // to `s`. Bounded, because decoding is attacker-influenced.
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break; // malformed escape: match on what we have rather than throwing
    }
  }
  return decoded.replace(/\/{2,}/g, "/").toLowerCase();
}

export function isSecretBearingPath(url) {
  if (typeof url !== "string" || url.length === 0) return false;
  return SECRET_BEARING_PATHS.some((re) => re.test(normalisePathForMatch(url)));
}

/**
 * Classify a REQUEST, not a single string.
 *
 * `originalUrl ?? url` was a blocking defect on a mounted router: Express
 * routes the STRIPPED `req.url` while `originalUrl` keeps the mount prefix, and
 * `??` never falls back once `originalUrl` exists. Both forms are tested, plus
 * `baseUrl + url`, and ANY match classifies the request as secrets-bearing.
 * Over-classifying costs a little log detail; under-classifying logs a
 * credential.
 */
export function isSecretBearingRequest(req) {
  if (typeof req !== "object" || req === null) return false;
  const r = req;
  const candidates = [r.originalUrl, r.url];
  if (typeof r.baseUrl === "string" && typeof r.url === "string") {
    candidates.push(r.baseUrl + r.url);
  }
  return candidates.some((c) => isSecretBearingPath(typeof c === "string" ? c : undefined));
}

/** A stable, non-revealing classification. Derived from the error TYPE only. */
export function classifyError(err, statusCode) {
  if (err && typeof err === "object") {
    const name = err.name;
    if (typeof name === "string" && name.length > 0 && name.length <= 64) {
      // A constructor name is a type, not caller data.
      if (/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return name;
    }
  }
  if (statusCode === 400) return "ValidationError";
  if (statusCode === 409) return "ConflictError";
  if (statusCode >= 500) return "InternalError";
  if (statusCode >= 400) return "RequestError";
  return "Unknown";
}

/**
 * Build the ONLY properties a secrets-route log line may carry.
 *
 * Every value here is either a fixed template string, an id, or a number.
 * Nothing is read from the request body, the query string, or an error
 * message. `req.route.path` is the express ROUTE TEMPLATE
 * (`/companies/:companyId/secrets`), not the caller's url, so it cannot carry
 * caller data.
 */
export function safeSecretRouteLogProps(input) {
  const out = {
    secretsRoute: true,
    status: input.statusCode,
    // Says plainly that detail was withheld on purpose, so nobody spends an
    // afternoon wondering why this one route logs so little.
    detail: "request body, query, params and error text omitted by secrets-route logging policy",
  };
  if (isSafeScalar(input.routePath)) out.routePath = input.routePath;
  if (isSafeScalar(input.method)) out.method = input.method;
  if (isSafeId(input.companyId)) out.companyId = input.companyId;
  if (isSafeId(input.requestId)) out.reqId = input.requestId;
  if (typeof input.errorCode === "string") out.errorCode = input.errorCode;
  return out;
}

/**
 * A replacement Error for a secrets-route failure.
 *
 * NEW object. Its message is a constant, it carries no `cause`, and its stack
 * is generated here — so it points at this function rather than containing any
 * caller data. The original error is never referenced again.
 */
export function safeSecretRouteError(statusCode, err) {
  const safe = new Error(SAFE_SECRET_ROUTE_MESSAGE);
  safe.name = classifyError(err, statusCode);
  return safe;
}

/** Ids and short scalars only; never an object, never unbounded text. */
function isSafeId(v) {
  return typeof v === "string" && v.length > 0 && v.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(v);
}

function isSafeScalar(v) {
  return typeof v === "string" && v.length > 0 && v.length <= 256;
}

//# sourceMappingURL=secret-route-log-policy.js.map
