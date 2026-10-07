/**
 * stdio.ts
 *
 * Internal Agent mode: the SAME tool set as the HTTP server, served over MCP
 * stdio. There is NO network listener and NO HTTP bearer: the process
 * boundary is the authentication (only the parent process that spawned us
 * holds our stdin/stdout). Do not expose this process's stdio over a socket.
 *
 * Env:
 *   PORT_CLIENT_ID_FILE / PORT_CLIENT_SECRET_FILE  absolute paths to files
 *     containing just the value (preferred; Hermes strips subprocess env)
 *   PORT_CLIENT_ID / PORT_CLIENT_SECRET            used only when the
 *     matching *_FILE var is unset
 *   PORT_API_BASE_URL     default https://api.port.io
 *   PORT_MCP_AUDIT_LOG    default ./data/audit.log
 *
 * Missing/unreadable credentials: the process still starts and answers
 * tools/list; every data tool returns
 * {status:'unavailable', reason:'credentials_not_configured'}.
 *
 * stdout carries ONLY MCP protocol frames. All diagnostics go to stderr and
 * never contain credential values or file contents.
 */
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { PortClient } from "./portClient.js";
import { JsonlAuditLogger } from "./audit.js";
import { resolveCredentials } from "./credentials.js";
import { buildMcpServer } from "./register.js";

export function buildStdioServer(env: NodeJS.ProcessEnv = process.env): { server: McpServer; log: string[] } {
  const creds = resolveCredentials(env);
  const log: string[] = [];
  log.push(`credentials: client_id=${creds.sources.clientId} client_secret=${creds.sources.clientSecret}`);
  for (const w of creds.warnings) log.push(`warning: ${w}`);
  if (!creds.clientId || !creds.clientSecret) {
    log.push("credentials_not_configured: data tools will return {status:'unavailable'}");
  }

  const client = new PortClient({
    baseUrl: env.PORT_API_BASE_URL || undefined,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    envFallback: false
  });
  const audit = new JsonlAuditLogger(env.PORT_MCP_AUDIT_LOG || "./data/audit.log");
  const server = buildMcpServer(
    { client, audit, callerRef: `stdio:${process.pid}` },
    { unavailableWithoutCredentials: true }
  );
  return { server, log };
}

async function main(): Promise<void> {
  // Defensive: nothing may write to stdout except the protocol transport.
  console.log = (...a: unknown[]) => console.error(...a);
  console.info = console.log;
  console.debug = console.log;

  const { server, log } = buildStdioServer(process.env);
  for (const line of log) console.error(`[isola-port-mcp] ${line}`);
  await server.connect(new StdioServerTransport());
  console.error("[isola-port-mcp] stdio server ready");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[isola-port-mcp] fatal: ${err instanceof Error ? err.message : "unknown error"}`);
    process.exit(1);
  });
}
