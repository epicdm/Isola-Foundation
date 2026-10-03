/**
 * The standalone one-off RUNNER (tools/mint-and-run.mjs): lane 59 runs it on host03 to prove the real tool
 * path BEFORE the UAT gateway is deployed. It reads the key and the fixture wa_id from FILES, mints ONE token
 * for a conversation id `rid`, sends ONE run to Hermes with `Isola assertion:` / `Conversation id:` lines built
 * by the same function the gateway uses, and prints only non-secret facts.
 *
 * Socket-free: Hermes is the fake from test/hermes-fake.ts and the files are an in-memory map (plus one test
 * with real temp files). NOTHING here is ever pointed at a host.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { assertionMinterFromTexts, ASSERTION_ENV } from "../src/assertion-minter.js";
import { renderHermesInput } from "../src/hermes-input.js";
import { FakeHermes, type FakeRun } from "./hermes-fake.js";
import { verifyAssertion } from "./pl-verifier-oracle.js";

type RunnerModule = {
  runMintAndRun(args: {
    argv: string[];
    env: Record<string, string | undefined>;
    deps: Record<string, unknown>;
  }): Promise<number>;
  createDefaultDeps(over?: Record<string, unknown>): Record<string, unknown>;
};
const RUNNER_URL = new URL("../tools/mint-and-run.mjs", import.meta.url).href;
async function loadRunner(): Promise<RunnerModule> {
  return (await import(/* @vite-ignore */ RUNNER_URL)) as RunnerModule;
}

const KEY = randomBytes(32).toString("hex"); // generated in-process
const BEARER = "not-a-real-hermes-key-aaaaaaaaaaaaaaaa";
const WA = "15555550100"; // SYNTHETIC
const KID = "fxuat1";
const PNID = "990000000017";
const RID = "igw1-" + "e".repeat(64);
const NOW_MS = 1_790_000_005_000;
const FILES: Record<string, string> = {
  "/s/key": KEY,
  "/s/wa": WA + "\n",
  "/s/bearer": BEARER + "\n",
};
const ENV = {
  GATEWAY_ASSERTION_ENV: "uat",
  GATEWAY_ASSERTION_KID: KID,
  GATEWAY_ASSERTION_PNID: PNID,
  GATEWAY_ASSERTION_KEY_FILE: "/s/key",
  GATEWAY_ASSERTION_FIXTURE_WA_ID_FILE: "/s/wa",
  GATEWAY_HERMES_BASE_URL: "http://hermes.test:8642",
  GATEWAY_HERMES_BEARER_FILE: "/s/bearer",
};

interface Rig {
  out: string[];
  fake: FakeHermes;
  run(argv: string[], over?: { env?: Record<string, string | undefined>; files?: Record<string, string>; fetch?: unknown }): Promise<number>;
  text(): string;
}
function rig(): Rig {
  const out: string[] = [];
  const fake = new FakeHermes();
  fake.bearer = BEARER;
  return {
    out,
    fake,
    text: () => out.join("\n"),
    run: async (argv, over = {}) => {
      const files = over.files ?? FILES;
      const mod = await loadRunner();
      return mod.runMintAndRun({
        argv,
        env: over.env ?? ENV,
        deps: {
          readFile: (p: string) => {
            const v = files[p];
            if (v === undefined) throw new Error("ENOENT");
            return v;
          },
          fetch: over.fetch ?? fake.fetch,
          modules: { assertionMinterFromTexts, renderHermesInput },
          stdout: (line: string) => out.push(line),
          nowMs: () => NOW_MS,
          pollIntervalMs: 10,
          deadlineMs: 2000,
          requestTimeoutMs: 1000,
        },
      });
    },
  };
}
function completeWith(fake: FakeHermes, output: string): void {
  fake.onRun = (run: FakeRun) => {
    run.running();
    setTimeout(() => run.complete(output), 15);
  };
}
function tokenOfInput(input: string): string {
  const line = input.split("\n").find((l) => l.startsWith("Isola assertion: "));
  return line === undefined ? "" : line.slice("Isola assertion: ".length);
}

describe("DRY RUN: mints and prints the non-secret header fields, sends nothing", () => {
  it("exit 0, no request, and the output carries kid/pnid/rid/mid/iat/nonce length but NOT the wa_id, the key, the bearer or the token", async () => {
    const r = rig();
    const code = await r.run(["--rid", RID, "--mid", "424242", "--dry-run"]);
    expect(code).toBe(0);
    expect(r.fake.log).toHaveLength(0);
    const text = r.text();
    expect(text).toContain(`kid=${KID}`);
    expect(text).toContain(`pnid=${PNID}`);
    expect(text).toContain(`rid=${RID}`);
    expect(text).toContain("mid=424242");
    expect(text).toContain(`iat=${Math.floor(NOW_MS / 1000)}`);
    expect(text).toContain("nonce_length=22");
    expect(text).toMatch(/dry.run/i);
    for (const secret of [WA, KEY, BEARER]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/v1\.[A-Za-z0-9_-]{20,}/); // no token-shaped string
  });
});

describe("REAL RUN against the fake Hermes", () => {
  it("POSITIVE: one POST /v1/runs, the user message built by the gateway's own function, the token verifies for exactly this rid, the bearer only in the header", async () => {
    const r = rig();
    completeWith(r.fake, JSON.stringify({ disposition: "answer", text: "Your balance is 42 minutes." }));
    const code = await r.run(["--rid", RID, "--mid", "424242", "--message", "What is my balance?"]);
    expect(code).toBe(0);

    expect(r.fake.creates).toHaveLength(1);
    const body = r.fake.creates[0]!.body!;
    const input = String(body["input"]);
    expect(input.startsWith(`Conversation id: ${RID}\nIsola assertion: v1.`)).toBe(true);
    const token = tokenOfInput(input);
    const v = verifyAssertion(token, { keys: { [KID]: KEY }, pnidAllowlist: [PNID], now: Math.floor(NOW_MS / 1000), conversationId: RID });
    expect(v.ok).toBe(true);
    // NO DRIFT: the message is exactly what the gateway's function renders for the same token
    expect(input).toBe(renderHermesInput({ conversationLabel: RID, assertion: token, message: "What is my balance?" }));
    expect(body["session_id"]).toBe(RID);
    expect(JSON.stringify(body)).not.toContain(BEARER);
    expect(JSON.stringify(body)).not.toContain(KEY);
    // the bearer went in the Authorization header (and nowhere else)
    expect(String(r.fake.creates[0]!.headers["authorization"])).toBe(`Bearer ${BEARER}`);
  });

  it("prints the run status and the output length; the model text only with --show-text, trimmed to 500 characters", async () => {
    const r = rig();
    completeWith(r.fake, JSON.stringify({ disposition: "answer", text: "x".repeat(900) }));
    expect(await r.run(["--rid", RID, "--mid", "1"])).toBe(0);
    expect(r.text()).toMatch(/run\.status=completed/);
    expect(r.text()).toMatch(/run\.output_chars=\d+/);
    expect(r.text()).not.toContain("x".repeat(50));

    const r2 = rig();
    completeWith(r2.fake, JSON.stringify({ disposition: "answer", text: "y".repeat(900) }));
    expect(await r2.run(["--rid", RID, "--mid", "1", "--show-text"])).toBe(0);
    const shown = r2.text();
    expect(shown).toContain("y".repeat(100));
    expect(shown).not.toContain("y".repeat(600));
  });

  it("REDACTION: if the model echoes the token, the wa_id, the key or the bearer, none of it reaches the output", async () => {
    const r = rig();
    r.fake.onRun = (run: FakeRun) => {
      run.running();
      const echoed = String(r.fake.creates[0]!.body!["input"]);
      setTimeout(() => run.complete(JSON.stringify({ disposition: "answer", text: `echo: ${echoed} | ${WA} | ${KEY} | ${BEARER}` })), 15);
    };
    expect(await r.run(["--rid", RID, "--mid", "7", "--show-text"])).toBe(0);
    const text = r.text();
    const token = tokenOfInput(String(r.fake.creates[0]!.body!["input"]));
    expect(token.startsWith("v1.")).toBe(true);
    for (const secret of [token, token.split(".")[2] as string, WA, KEY, BEARER]) expect(text).not.toContain(secret);
    expect(text).toContain("[redacted]");
  });
});

describe("it refuses, naming variables and never values, and sends NOTHING", () => {
  async function refused(over: Parameters<Rig["run"]>[1], argv: string[] = ["--rid", RID, "--mid", "1"]) {
    const r = rig();
    const code = await r.run(argv, over);
    return { code, text: r.text(), requests: r.fake.log.length };
  }

  it("CONTROL: the same arguments with a valid environment send exactly one request (so the refusals below are not a broken rig)", async () => {
    const r = rig();
    completeWith(r.fake, JSON.stringify({ disposition: "answer", text: "ok" }));
    expect(await r.run(["--rid", RID, "--mid", "1"])).toBe(0);
    expect(r.fake.creates).toHaveLength(1);
  });

  it("GATEWAY_ASSERTION_ENV other than exactly 'uat' (production, absent, UAT in capitals)", async () => {
    for (const v of ["production", undefined, "UAT", ""]) {
      const x = await refused({ env: { ...ENV, GATEWAY_ASSERTION_ENV: v } });
      expect(x.code, String(v)).toBe(2);
      expect(x.requests).toBe(0);
      expect(x.text).toContain(ASSERTION_ENV.environment);
    }
  });

  it("a key file with a trailing newline (the verifier does not trim it) is refused naming the key variable, never the key", async () => {
    const x = await refused({ files: { ...FILES, "/s/key": KEY + "\n" } });
    expect(x.code).toBe(2);
    expect(x.requests).toBe(0);
    expect(x.text).toContain(ASSERTION_ENV.key);
    expect(x.text).not.toContain(KEY);
  });

  it("the wa_id file may end with ONE newline (accepted: the positive runs above use it) but not two", async () => {
    const x = await refused({ files: { ...FILES, "/s/wa": WA + "\n\n" } });
    expect(x.code).toBe(2);
    expect(x.text).toContain(ASSERTION_ENV.fixtureWaId);
    expect(x.text).not.toContain(WA);
    expect(x.requests).toBe(0);
  });

  it("a missing file names the variable that pointed at it", async () => {
    const files = { ...FILES };
    delete files["/s/key"];
    const x = await refused({ files });
    expect(x.code).toBe(2);
    expect(x.text).toContain("GATEWAY_ASSERTION_KEY_FILE");
    expect(x.requests).toBe(0);
  });

  it("a missing *_FILE variable is a refusal naming it", async () => {
    const env = { ...ENV, GATEWAY_ASSERTION_FIXTURE_WA_ID_FILE: undefined };
    const x = await refused({ env });
    expect(x.code).toBe(2);
    expect(x.text).toContain("GATEWAY_ASSERTION_FIXTURE_WA_ID_FILE");
  });

  it("a missing Hermes base URL or bearer file is a refusal", async () => {
    expect((await refused({ env: { ...ENV, GATEWAY_HERMES_BASE_URL: undefined } })).code).toBe(2);
    expect((await refused({ env: { ...ENV, GATEWAY_HERMES_BEARER_FILE: undefined } })).code).toBe(2);
  });

  it("a Hermes base URL with credentials, a query, a fragment or a non-http scheme is refused (it is where the bearer would go)", async () => {
    for (const u of ["http://user:pw@hermes.test:8642", "http://hermes.test:8642?x=1", "http://hermes.test:8642#f", "ftp://hermes.test", "file:///etc/passwd"]) {
      const x = await refused({ env: { ...ENV, GATEWAY_HERMES_BASE_URL: u } });
      expect(x.code, u).toBe(2);
      expect(x.requests).toBe(0);
    }
  });

  it("the owner-privileged operator gateway (:8645, hermes-tunnel, isolahb_bridge) is refused as a target", async () => {
    for (const u of ["http://hermes-tunnel:8645", "http://hermes.test:8645", "http://isolahb_bridge:8000"]) {
      const x = await refused({ env: { ...ENV, GATEWAY_HERMES_BASE_URL: u } });
      expect(x.code, u).toBe(2);
      expect(x.requests).toBe(0);
    }
  });

  it("a bad --rid or --mid (empty, with a space, too long, a control character) or a missing --rid", async () => {
    for (const argv of [
      ["--mid", "1"],
      ["--rid", "", "--mid", "1"],
      ["--rid", "has space", "--mid", "1"],
      ["--rid", "r".repeat(129), "--mid", "1"],
      ["--rid", "a\nb", "--mid", "1"],
      ["--rid", RID, "--mid", "m".repeat(257)],
    ]) {
      const x = await refused(undefined, argv);
      expect(x.code, JSON.stringify(argv)).toBe(2);
      expect(x.requests).toBe(0);
    }
  });

  it("an unknown flag is refused (a typo must not look like a successful run)", async () => {
    const x = await refused(undefined, ["--rid", RID, "--mid", "1", "--wa-id", "15555550199"]);
    expect(x.code).toBe(2);
    expect(x.requests).toBe(0);
  });
});

describe("transport failures print a status and nothing else", () => {
  it("HTTP 401 => exit 3, the bearer never printed", async () => {
    const r = rig();
    const code = await r.run(["--rid", RID, "--mid", "1"], {
      fetch: async () => new Response(JSON.stringify({ error: { message: `bad key ${BEARER}` } }), { status: 401, headers: { "content-type": "application/json" } }),
    });
    expect(code).toBe(3);
    expect(r.text()).toContain("401");
    expect(r.text()).not.toContain(BEARER);
  });

  it("a redirect is NOT followed (redirect: manual) and is a failure", async () => {
    const r = rig();
    let init: RequestInit | undefined;
    const code = await r.run(["--rid", RID, "--mid", "1"], {
      fetch: async (_u: unknown, i?: RequestInit) => {
        init = i;
        return new Response(null, { status: 307, headers: { location: "http://evil.test/" } });
      },
    });
    expect(code).toBe(3);
    expect(init?.redirect).toBe("manual");
    expect(r.text()).toContain("307");
  });

  it("a run that never finishes ends at the deadline with exit 3 (it does not hang)", async () => {
    const r = rig();
    r.fake.onRun = (run: FakeRun) => run.running(); // never completes
    const code = await r.run(["--rid", RID, "--mid", "1"]);
    expect(code).toBe(3);
    expect(r.text()).toMatch(/deadline|timeout/i);
  });

  it("a failed run is reported as failed (exit 3), without its error text", async () => {
    const r = rig();
    r.fake.onRun = (run: FakeRun) => {
      run.running();
      setTimeout(() => run.fail(`provider said: ${BEARER}`), 15);
    };
    const code = await r.run(["--rid", RID, "--mid", "1"]);
    expect(code).toBe(3);
    expect(r.text()).toMatch(/run\.status=failed/);
    expect(r.text()).not.toContain(BEARER);
  });
});

describe("the runner never writes a file and never uses console", () => {
  it("static scan of tools/mint-and-run.mjs", () => {
    const src = readFileSync(new URL("../tools/mint-and-run.mjs", import.meta.url), "utf8");
    expect(src).not.toMatch(/writeFile|appendFile|createWriteStream|mkdir|unlink|rmSync|copyFile/);
    expect(src).not.toMatch(/\bconsole\./);
    expect(src).not.toMatch(/child_process|execSync|spawn/);
    expect(src.length).toBeGreaterThan(500); // not vacuous
  });
});

describe("with REAL files (the default dependencies)", () => {
  it("reads the key and the wa_id from real files, exactly as written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mintrun-"));
    writeFileSync(join(dir, "key"), KEY);
    writeFileSync(join(dir, "wa"), WA + "\n");
    writeFileSync(join(dir, "bearer"), BEARER + "\n");
    const mod = await loadRunner();
    const out: string[] = [];
    const deps = mod.createDefaultDeps({ modules: { assertionMinterFromTexts, renderHermesInput }, stdout: (l: string) => out.push(l), nowMs: () => NOW_MS });
    const code = await mod.runMintAndRun({
      argv: ["--rid", RID, "--mid", "9", "--dry-run"],
      env: { ...ENV, GATEWAY_ASSERTION_KEY_FILE: join(dir, "key"), GATEWAY_ASSERTION_FIXTURE_WA_ID_FILE: join(dir, "wa"), GATEWAY_HERMES_BEARER_FILE: join(dir, "bearer") },
      deps,
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("kid=fxuat1");
    // a key file WITH a trailing newline, written by a real writeFile, is refused
    writeFileSync(join(dir, "key"), KEY + "\n");
    const out2: string[] = [];
    const code2 = await mod.runMintAndRun({
      argv: ["--rid", RID, "--mid", "9", "--dry-run"],
      env: { ...ENV, GATEWAY_ASSERTION_KEY_FILE: join(dir, "key"), GATEWAY_ASSERTION_FIXTURE_WA_ID_FILE: join(dir, "wa"), GATEWAY_HERMES_BEARER_FILE: join(dir, "bearer") },
      deps: mod.createDefaultDeps({ modules: { assertionMinterFromTexts, renderHermesInput }, stdout: (l: string) => out2.push(l), nowMs: () => NOW_MS }),
    });
    expect(code2).toBe(2);
    expect(out2.join("\n")).not.toContain(KEY);
  });
});
