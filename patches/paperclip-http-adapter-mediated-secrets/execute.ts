import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, parseObject } from "../utils.js";

/**
 * MEDIATED SECRET REFERENCES IN HTTP HEADERS.
 *
 * Why this exists. A planted-canary redaction control on 2026-08-24 proved that
 * a literal value in `adapterConfig.headers` is returned IN PLAINTEXT from
 * `GET /api/agents/{id}` and `GET /api/companies/{id}/agents`. Storing an
 * upstream bearer there hands it to any actor with configuration-read
 * permission — including, per Isola Runtime's own auth module, the agent
 * itself, which can read and PATCH its own adapterConfig.
 *
 * Paperclip already has the right mechanism and this adapter simply could not
 * reach it: `secretService.resolveAdapterConfigForRuntime` resolves
 * `adapterConfig.env` bindings of the form `{type:"secret", secretId, version}`
 * into plaintext AT EXECUTION TIME ONLY, and emits an audit manifest. The
 * execution path already does this — `resolveExecutionRunAdapterConfig` feeds
 * `resolvedConfig` through to `adapter.execute({ config })` — so by the time we
 * are called, `config.env` holds the resolved values and nothing extra needs to
 * be built.
 *
 * So a header value may now be EITHER:
 *   - a plain string, used verbatim exactly as before, or
 *   - `{"$env": "NAME"}`, replaced by `config.env.NAME`.
 *
 * The stored configuration therefore contains only the NAME. The secret lives
 * in `company_secrets`, encrypted and provider-backed, and no API surface can
 * return it.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO:
 *   - it never reads `process.env`. The only source is the mediated,
 *     already-resolved `config.env`. A reference to a host process variable
 *     would reintroduce an unaudited credential path, which is the whole point
 *     of not having one.
 *   - it never puts a resolved value into an error, a log line, a return value
 *     or the config. Failures name the ENV KEY, never the value.
 *   - it resolves nothing lazily. Every header is resolved BEFORE the request
 *     is built, so a missing or malformed reference fails closed with no
 *     outbound call made at all.
 */
const ENV_REF_KEY = "$env";

/** The reference form, kept deliberately narrow so it cannot be ambiguous. */
function isEnvRefShape(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve one header value.
 *
 * Exported for tests: the security properties here are worth asserting
 * directly rather than only through an HTTP round trip.
 *
 * @throws Error naming the header and (where relevant) the env KEY. Never the
 *         value, and never the surrounding config.
 */
export function resolveHeaderValue(
  headerName: string,
  raw: unknown,
  env: Record<string, unknown>,
): string {
  // An ordinary literal header. Unchanged behaviour for every existing agent.
  if (typeof raw === "string") return raw;

  if (!isEnvRefShape(raw)) {
    throw new Error(
      `HTTP adapter header "${headerName}" must be a string or an ${ENV_REF_KEY} reference`,
    );
  }

  const keys = Object.keys(raw);
  // AMBIGUITY IS REFUSED, NOT RESOLVED. `{"$env":"A","value":"b"}` has two
  // plausible readings and picking either silently would be the kind of guess
  // that puts the wrong credential on the wire.
  if (keys.length !== 1 || keys[0] !== ENV_REF_KEY) {
    throw new Error(
      `HTTP adapter header "${headerName}" must have exactly one key, ${ENV_REF_KEY}`,
    );
  }

  const refName = raw[ENV_REF_KEY];
  if (typeof refName !== "string" || refName.trim().length === 0) {
    throw new Error(
      `HTTP adapter header "${headerName}" has a non-string or empty ${ENV_REF_KEY} reference`,
    );
  }

  // OWN DATA PROPERTIES ONLY. An inherited property must never satisfy a
  // reference: with a polluted `Object.prototype`, or an `env` built by
  // `Object.create({RUNTIME_SECRET: ...})`, a lookup would otherwise succeed
  // for a key the MEDIATED environment does not contain — quietly putting an
  // attacker-chosen value on the wire while every "is it present" check said
  // yes. Found by adversarial review, 2026-08-24.
  if (!Object.prototype.hasOwnProperty.call(env, refName)) {
    throw new Error(
      `HTTP adapter header "${headerName}" references env "${refName}", which is not present ` +
        `in the resolved mediated environment`,
    );
  }

  // A getter on `env` can throw, and its message could carry the very value
  // this function exists to keep out of error text. Read defensively and
  // replace any thrown message with our own. Same review.
  let value: unknown;
  try {
    value = env[refName];
  } catch {
    throw new Error(
      `HTTP adapter header "${headerName}" could not read env "${refName}" from the resolved ` +
        `mediated environment`,
    );
  }

  // FAIL CLOSED. A missing mediated secret must never degrade to an
  // unauthenticated request that then fails confusingly upstream.
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `HTTP adapter header "${headerName}" references env "${refName}", which is not present ` +
        `in the resolved mediated environment`,
    );
  }
  return value;
}

/**
 * Resolve every header. Pure, and separated from `execute` so the refusal
 * behaviour can be tested without a network stack.
 *
 * The accumulator has a NULL PROTOTYPE. With a plain `{}`, a legitimate literal
 * header named `__proto__` would hit the legacy prototype setter instead of
 * becoming an own property, and would be silently dropped from the request —
 * a literal header that stopped working. Also found by adversarial review.
 */
export function resolveHeaders(
  rawHeaders: Record<string, unknown>,
  env: Record<string, unknown>,
): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  // Own enumerable entries only, for the same reason as the env lookup above.
  for (const name of Object.keys(rawHeaders)) {
    out[name] = resolveHeaderValue(name, rawHeaders[name], env);
  }
  return out;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context } = ctx;
  const url = asString(config.url, "");
  if (!url) throw new Error("HTTP adapter missing url");

  const method = asString(config.method, "POST");
  const timeoutMs = asNumber(config.timeoutMs, 0);
  const rawHeaders = parseObject(config.headers);
  // The mediated, already-resolved environment. NOT process.env.
  const mediatedEnv = parseObject(config.env);
  // Resolved BEFORE the request is constructed: a bad reference must not reach
  // the network at all.
  const headers = resolveHeaders(rawHeaders, mediatedEnv);
  const payloadTemplate = parseObject(config.payloadTemplate);
  const body = { ...payloadTemplate, agentId: agent.id, runId, context };

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      ...(timer ? { signal: controller.signal } : {}),
    });

    if (!res.ok) {
      throw new Error(`HTTP invoke failed with status ${res.status}`);
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `HTTP ${method} ${url}`,
    };
  } catch (err) {
    if (timer && err instanceof Error && err.name === "AbortError") {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `HTTP ${method} ${url} timed out after ${timeoutMs}ms`,
        errorCode: "timeout",
      };
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
