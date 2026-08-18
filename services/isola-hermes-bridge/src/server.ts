import { createBridge, readCharter, type BridgeConfig } from "./bridge.js";
import { readFileSync } from "node:fs";

/** Secrets arrive as FILES (Swarm), never as env values. */
function fromFile(path: string | undefined, what: string): string {
  if (path === undefined || path.length === 0) throw new Error(`${what} file path is unset`);
  const v = readFileSync(path, "utf8").trim();
  if (v.length === 0) throw new Error(`${what} file is empty`);
  return v;
}

const cfg: BridgeConfig = {
  port: Number(process.env["PORT"] ?? 3000),
  hermesBaseUrl: process.env["HERMES_BASE_URL"] ?? "http://hermes-tunnel:8645",
  hermesToken: fromFile(process.env["HERMES_API_TOKEN_FILE"], "HERMES_API_TOKEN"),
  hermesModel: process.env["HERMES_MODEL"] ?? null,
  paperclipBaseUrl: (process.env["PAPERCLIP_BASE_URL"] ?? "").replace(/\/+$/, ""),
  paperclipAgentKey: fromFile(process.env["PAPERCLIP_AGENT_KEY_FILE"], "PAPERCLIP_AGENT_KEY"),
  charterPath: process.env["CHARTER_PATH"] ?? null,
  paperclipAgentId: process.env["PAPERCLIP_AGENT_ID"] ?? null,
  charterFile: process.env["CHARTER_FILE"] ?? "AGENTS.md",
  charterTtlMs: Number(process.env["CHARTER_TTL_MS"] ?? 60_000),
  requestTimeoutMs: Number(process.env["REQUEST_TIMEOUT_MS"] ?? 110_000),
  inboundToken:
    process.env["BRIDGE_TOKEN_FILE"] === undefined
      ? null
      : fromFile(process.env["BRIDGE_TOKEN_FILE"], "BRIDGE_TOKEN"),
};

const log = (e: Record<string, unknown>): void => {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), service: "isola-hermes-bridge", ...e })}\n`,
  );
};

createBridge(cfg, log).listen(cfg.port, "0.0.0.0", () => {
  log({
    event: "boot",
    outcome: "listening",
    port: cfg.port,
    hermesBaseUrl: cfg.hermesBaseUrl,
    paperclipBaseUrl: cfg.paperclipBaseUrl,
    modelPinned: cfg.hermesModel !== null,
    inboundAuth: cfg.inboundToken !== null,
    charterChars: readCharter(cfg.charterPath).length,
  });
});
