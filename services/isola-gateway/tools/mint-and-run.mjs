#!/usr/bin/env node
/**
 * mint-and-run.mjs: the standalone one-off VERIFICATION runner for the UAT fixture assertion minter.
 *
 * WHAT IT DOES
 *   Lane 59 runs it ON HOST03 (never against production Hermes' owner-privileged gateway) to prove the REAL tool
 *   path before the UAT gateway is deployed: it reads the signing key and the fixture wa_id from FILES, mints ONE
 *   token for the conversation id you give it (--rid), builds the user message with the SAME function the gateway
 *   uses (`renderHermesInput`, so the `Conversation id:` / `Isola assertion:` lines cannot drift), sends ONE run to
 *   the public Hermes service, waits for it, and prints only NON-SECRET facts.
 *
 * WHAT IT NEVER DOES
 *   - It never prints the token, the signature, the key, the bearer or the wa_id, not even if the model echoes them
 *     (every output line is redacted against all of them). It never writes a file. It never logs a header.
 *   - It refuses unless GATEWAY_ASSERTION_ENV is exactly `uat`, and it refuses the owner-privileged operator
 *     gateway (hermes-tunnel / isolahb_bridge / :8645) as a target.
 *   - It follows no redirect, retries nothing, and sends exactly one POST /v1/runs per invocation.
 *
 * USAGE
 *   node tools/mint-and-run.mjs --rid <conversation id> [--mid <message id>] [--message "<customer text>"]
 *                                [--dry-run] [--show-text]
 *   Environment (names only; the *_FILE variables hold PATHS, e.g. the mounted Swarm secrets):
 *     GATEWAY_ASSERTION_ENV=uat   GATEWAY_ASSERTION_KID   GATEWAY_ASSERTION_PNID
 *     GATEWAY_ASSERTION_KEY_FILE   GATEWAY_ASSERTION_FIXTURE_WA_ID_FILE
 *     GATEWAY_HERMES_BASE_URL   GATEWAY_HERMES_BEARER_FILE            (not needed for --dry-run)
 *   The key file is used as its EXACT bytes (the verifier does not trim): a trailing newline is refused. The wa_id
 *   file may end with ONE newline. It needs the gateway BUILT (`npx tsc -p tsconfig.build.json` -> dist/) because it
 *   imports the same compiled modules the gateway runs.
 *
 * EXIT CODES  0 ok | 2 refused (configuration/arguments; nothing was sent) | 3 failed (transport, status or deadline)
 *
 * This file is outside src/ on purpose: the gateway's own source has no `node:fs` and a test asserts it.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const EXIT = { ok: 0, refused: 2, failed: 3 };

const REDACTED = "[redacted]";
const RID_RE = /^[\x21-\x7E]{1,128}$/;
const MID_RE = /^[^\u0000-\u001F\u007F]{1,256}$/;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const FORBIDDEN_HOSTS = new Set(["hermes-tunnel", "isolahb_bridge"]);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const SHOW_TEXT_MAX = 500;
const DEFAULT_MESSAGE = "Hello, what is my current balance?";

export function createDefaultDeps(over = {}) {
  return {
    readFile: (path) => readFileSync(path, "utf8"),
    fetch: globalThis.fetch,
    modules: null,
    stdout: (line) => process.stdout.write(`${line}\n`),
    nowMs: () => Date.now(),
    /* the clock for the DEADLINE only (nowMs is the iat clock and may be pinned by a test) */
    monotonicMs: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollIntervalMs: 1000,
    deadlineMs: 90_000,
    requestTimeoutMs: 20_000,
    ...over,
  };
}

async function loadDefaultModules() {
  const minter = await import(new URL("../dist/assertion-minter.js", import.meta.url).href);
  const input = await import(new URL("../dist/hermes-input.js", import.meta.url).href);
  return { assertionMinterFromTexts: minter.assertionMinterFromTexts, renderHermesInput: input.renderHermesInput };
}

function parseArgs(argv) {
  const out = { rid: undefined, mid: undefined, message: DEFAULT_MESSAGE, dryRun: false, showText: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--show-text") out.showText = true;
    else if (a === "--rid" || a === "--mid" || a === "--message") {
      const v = argv[i + 1];
      if (v === undefined) return { error: `${a} needs a value` };
      i += 1;
      if (a === "--rid") out.rid = v;
      else if (a === "--mid") out.mid = v;
      else out.message = v;
    } else {
      return { error: `unknown argument ${a.slice(0, 24)}` };
    }
  }
  return { args: out };
}

function decodePayload(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function validateBase(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (raw.includes("?") || raw.includes("#") || u.username !== "" || u.password !== "") return null;
  if (FORBIDDEN_HOSTS.has(u.hostname.toLowerCase()) || u.port === "8645") return null;
  return { base: raw.replace(/\/+$/, ""), host: u.host };
}

/**
 * @param {{argv: string[], env: Record<string, string|undefined>, deps?: Record<string, any>}} input
 * @returns {Promise<number>} the exit code
 */
export async function runMintAndRun({ argv, env, deps: given = {} }) {
  const deps = { ...createDefaultDeps(), ...given };
  const secrets = new Set();
  const redact = (s) => {
    let t = String(s);
    for (const secret of secrets) if (secret.length > 0) t = t.split(secret).join(REDACTED);
    return t;
  };
  const say = (line) => deps.stdout(redact(line));
  const refuse = (what) => {
    say(`REFUSED: ${what}`);
    return EXIT.refused;
  };

  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) return refuse(parsed.error);
  const args = parsed.args;
  if (typeof args.rid !== "string" || !RID_RE.test(args.rid)) return refuse("--rid is required: 1..128 printable characters, no spaces");
  const mid = args.mid ?? `runner-${deps.nowMs()}`;
  if (!MID_RE.test(mid)) return refuse("--mid must be 1..256 characters without control characters");

  if (env["GATEWAY_ASSERTION_ENV"] !== "uat") return refuse("GATEWAY_ASSERTION_ENV must be exactly uat");
  for (const name of ["GATEWAY_ASSERTION_KID", "GATEWAY_ASSERTION_PNID", "GATEWAY_ASSERTION_KEY_FILE", "GATEWAY_ASSERTION_FIXTURE_WA_ID_FILE"]) {
    if (typeof env[name] !== "string" || env[name].length === 0) return refuse(`${name} is not set`);
  }
  if (!args.dryRun) {
    for (const name of ["GATEWAY_HERMES_BASE_URL", "GATEWAY_HERMES_BEARER_FILE"]) {
      if (typeof env[name] !== "string" || env[name].length === 0) return refuse(`${name} is not set`);
    }
  }

  // The files, read once, exactly as written. A read failure names the variable that pointed at it.
  const readNamed = (name) => {
    try {
      return deps.readFile(env[name]);
    } catch {
      return null;
    }
  };
  const keyText = readNamed("GATEWAY_ASSERTION_KEY_FILE");
  if (keyText === null) return refuse("GATEWAY_ASSERTION_KEY_FILE could not be read");
  const waText = readNamed("GATEWAY_ASSERTION_FIXTURE_WA_ID_FILE");
  if (waText === null) return refuse("GATEWAY_ASSERTION_FIXTURE_WA_ID_FILE could not be read");
  secrets.add(keyText);
  secrets.add(keyText.trim());
  secrets.add(waText.trim());
  for (const s of [...secrets]) if (s.length < 6) secrets.delete(s);
  const waId = waText.replace(/\r?\n$/, "");
  if (waId.length >= 6) secrets.add(waId);

  let bearer = "";
  let hermes = null;
  if (!args.dryRun) {
    const rawBearer = readNamed("GATEWAY_HERMES_BEARER_FILE");
    if (rawBearer === null) return refuse("GATEWAY_HERMES_BEARER_FILE could not be read");
    bearer = rawBearer.replace(/[\r\n]+$/, "");
    if (!/^[\x21-\x7E]{8,}$/.test(bearer)) return refuse("GATEWAY_HERMES_BEARER_FILE does not hold a usable key");
    secrets.add(bearer);
    hermes = validateBase(env["GATEWAY_HERMES_BASE_URL"]);
    if (hermes === null) return refuse("GATEWAY_HERMES_BASE_URL is not an acceptable target (http(s) only, no credentials/query/fragment, never the operator gateway)");
  }

  let modules = deps.modules;
  if (modules === null || modules === undefined) {
    try {
      modules = await loadDefaultModules();
    } catch {
      return refuse("dist/ is missing: build the gateway first (npx tsc -p tsconfig.build.json)");
    }
  }

  const loaded = modules.assertionMinterFromTexts({
    environment: env["GATEWAY_ASSERTION_ENV"],
    kid: env["GATEWAY_ASSERTION_KID"],
    pnid: env["GATEWAY_ASSERTION_PNID"],
    keyText,
    waIdText: waText,
    nowMs: deps.nowMs,
  });
  if (loaded.mode !== "fixture") {
    return refuse(`the minter configuration is not usable; check these variables: ${(loaded.problems ?? ["unknown"]).join(", ")}`);
  }

  let token;
  try {
    token = loaded.minter.mintForSubject({ subject: waId, rid: args.rid, mid });
  } catch (e) {
    return refuse(`the minter refused (${e && typeof e.code === "string" ? e.code : "error"})`);
  }
  secrets.add(token);
  const signature = token.split(".")[2];
  if (typeof signature === "string") secrets.add(signature);

  // NON-SECRET header facts only: never wa_id, never the signature, never the token.
  const payload = decodePayload(token);
  say(`kid=${payload?.kid}`);
  say(`pnid=${payload?.pnid}`);
  say(`rid=${payload?.rid}`);
  say(`mid=${payload?.mid}`);
  say(`iat=${payload?.iat}`);
  say(`nonce_length=${typeof payload?.nonce === "string" ? payload.nonce.length : 0}`);

  if (args.dryRun) {
    say("dry-run: the token was minted and nothing was sent");
    return EXIT.ok;
  }

  const input = modules.renderHermesInput({ conversationLabel: args.rid, assertion: token, message: args.message });
  const headers = { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json" };
  const deadlineAt = deps.monotonicMs() + deps.deadlineMs;
  const call = async (method, path, body, accept) => {
    const res = await deps.fetch(`${hermes.base}${path}`, {
      method,
      headers: accept === undefined ? headers : { ...headers, accept },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(deps.requestTimeoutMs),
    });
    return res;
  };

  say(`hermes.host=${hermes.host}`);
  let runId;
  try {
    const res = await call("POST", "/v1/runs", { input, session_id: args.rid });
    if (res.status !== 202) {
      say(`http.status=${res.status}`);
      return EXIT.failed;
    }
    const json = await res.json();
    runId = json?.run_id;
    if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
      say("run.id=unusable");
      return EXIT.failed;
    }
  } catch {
    say("transport=failed (create)");
    return EXIT.failed;
  }

  let last = null;
  for (;;) {
    if (deps.monotonicMs() >= deadlineAt) {
      say("run.status=deadline (the run did not finish in time)");
      return EXIT.failed;
    }
    try {
      const res = await call("GET", `/v1/runs/${runId}`);
      if (res.status !== 200) {
        say(`http.status=${res.status}`);
        return EXIT.failed;
      }
      last = await res.json();
    } catch {
      say("transport=failed (poll)");
      return EXIT.failed;
    }
    if (TERMINAL.has(last?.status)) break;
    await deps.sleep(deps.pollIntervalMs);
  }

  // Best effort: read the event stream to its end so the service's concurrency slot is released (contract s.5).
  try {
    const ev = await call("GET", `/v1/runs/${runId}/events`, undefined, "text/event-stream");
    if (ev.status === 200 && ev.body !== null) {
      const reader = ev.body.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
  } catch {
    // not an error for this runner
  }

  say(`run.status=${last.status}`);
  const output = typeof last.output === "string" ? last.output : "";
  say(`run.output_chars=${output.length}`);
  if (args.showText && output.length > 0) say(`run.text=${output.slice(0, SHOW_TEXT_MAX)}`);
  return last.status === "completed" ? EXIT.ok : EXIT.failed;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runMintAndRun({ argv: process.argv.slice(2), env: process.env, deps: createDefaultDeps() }).then(
    (code) => process.exit(code),
    () => process.exit(EXIT.failed),
  );
}
