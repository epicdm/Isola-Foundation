/**
 * The single egress primitive, and the config that derives its allowlist.
 */
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  createSafeFetch,
  EgressBlockedError,
  hostOf,
  isAllowedHost,
  parseAllowlist,
} from "../src/egress.js";

const OK = new Response("{}", { status: 200 });

describe("createSafeFetch", () => {
  it("permits an allowlisted https host", async () => {
    const calls: string[] = [];
    const safeFetch = createSafeFetch({
      allowlist: ["chatwoot.example.test"],
      transport: async (url) => {
        calls.push(String(url));
        return OK;
      },
    });
    await safeFetch("https://chatwoot.example.test/api/v1/accounts/1/conversations/2/messages");
    expect(calls).toHaveLength(1);
  });

  it("permits an allowlisted plain-http container host", async () => {
    // The runtime lives on the private container network at
    // http://isola_isola-runtime:3000 — http is fine, the allowlist is not.
    const safeFetch = createSafeFetch({
      allowlist: ["isola_isola-runtime"],
      transport: async () => OK,
    });
    await expect(
      safeFetch("http://isola_isola-runtime:3000/v1/invoke"),
    ).resolves.toBeDefined();
  });

  it("blocks a host that is not on the allowlist", async () => {
    const safeFetch = createSafeFetch({
      allowlist: ["chatwoot.example.test"],
      transport: async () => OK,
    });
    await expect(safeFetch("https://evil.example.test/x")).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
  });

  it("does not do suffix matching", async () => {
    const safeFetch = createSafeFetch({
      allowlist: ["epic.dm"],
      transport: async () => OK,
    });
    await expect(safeFetch("https://evil-epic.dm/x")).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    await expect(safeFetch("https://epic.dm.evil.test/x")).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
  });

  it("blocks every non-http scheme", async () => {
    const safeFetch = createSafeFetch({
      allowlist: ["chatwoot.example.test"],
      transport: async () => OK,
    });
    for (const url of [
      "file:///etc/passwd",
      "ftp://chatwoot.example.test/x",
      "data:text/plain,hello",
    ]) {
      await expect(safeFetch(url)).rejects.toBeInstanceOf(EgressBlockedError);
    }
  });

  it("blocks an unparseable url", async () => {
    const safeFetch = createSafeFetch({ allowlist: ["x"], transport: async () => OK });
    await expect(safeFetch("not a url")).rejects.toBeInstanceOf(EgressBlockedError);
  });
});

describe("allowlist helpers", () => {
  it("parses and normalises a comma list", () => {
    expect(parseAllowlist(" A.test , b.TEST ,, ")).toEqual(["a.test", "b.test"]);
    expect(parseAllowlist(undefined)).toEqual([]);
  });

  it("extracts hosts", () => {
    expect(hostOf("https://Chatwoot.Example.Test/api")).toBe("chatwoot.example.test");
    expect(hostOf("http://isola_isola-runtime:3000")).toBe("isola_isola-runtime");
    expect(hostOf("nonsense")).toBeNull();
  });

  it("matches exactly", () => {
    expect(isAllowedHost("a.test", ["A.TEST"])).toBe(true);
    expect(isAllowedHost("", ["a.test"])).toBe(false);
  });
});

describe("the derived allowlist", () => {
  it("defaults to the Chatwoot host plus the runtime host", () => {
    const config = loadConfig({
      CHATWOOT_BASE_URL: "https://isola-chat.saas00.epic.dm",
      RUNTIME_BASE_URL: "http://isola_isola-runtime:3000",
    });
    expect(config.egressAllowlist).toEqual(["isola-chat.saas00.epic.dm", "isola_isola-runtime"]);
  });

  it("is replaced wholesale by an explicit EGRESS_ALLOWLIST", () => {
    const config = loadConfig({ EGRESS_ALLOWLIST: "only.example.test" });
    expect(config.egressAllowlist).toEqual(["only.example.test"]);
  });
});
