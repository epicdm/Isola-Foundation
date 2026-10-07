/**
 * server.ts
 *
 * MCP server over Streamable HTTP transport, plus a plain /healthz route.
 * Binds to 127.0.0.1 only (localhost-bind-only posture) — putting this on
 * the public internet requires a human-added TLS/reverse-proxy layer
 * (see docs/CHATGPT-PORT-CONNECTION-HANDOFF.md), which is explicitly NOT
 * done by this server itself.
 *
 * Every tool call is gated by bearer auth + rate limiting (src/auth.ts)
 * before it ever reaches the MCP SDK's request handling.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { PortClient } from "./portClient.js";
import { JsonlAuditLogger, callerRefFromToken } from "./audit.js";
import { isAuthorized, extractBearerToken, RateLimiter, RATE_LIMIT_PER_MINUTE } from "./auth.js";
import { buildMcpServer } from "./register.js";

const PORT = Number(process.env.PORT ?? 8890);
const HOST = "127.0.0.1";

const client = new PortClient();
const audit = new JsonlAuditLogger(new URL("../data/audit.log", import.meta.url).pathname);
const rateLimiter = new RateLimiter(RATE_LIMIT_PER_MINUTE);

// Session store for the Streamable HTTP transport. Without this, a fresh
// McpServer + transport was constructed on every HTTP request, so no
// session ever survived past its own `initialize` call — every subsequent
// tools/call hit a blank transport and got "Server not initialized". This
// is the SDK-standard Map<sessionId, transport> pattern from the reference
// StreamableHTTPServerTransport example: reuse the pair on a known
// Mcp-Session-Id, construct fresh only on a genuine new-session
// `initialize` request, and drop the entry when the transport closes.
const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

function buildForCaller(callerRef: string): McpServer {
  return buildMcpServer({ client, audit, callerRef });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  const authHeader = req.headers["authorization"];
  const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;

  if (!isAuthorized(headerValue)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const token = extractBearerToken(headerValue) ?? "unknown";
  const rateKey = token;
  if (!rateLimiter.tryConsume(rateKey)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "rate_limited" }));
    return;
  }

  const callerRef = callerRefFromToken(token);

  let parsedBody: unknown;
  try {
    const raw = await readBody(req);
    parsedBody = raw ? JSON.parse(raw) : undefined;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_json" }));
    return;
  }

  const sessionIdHeader = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

  let entry = sessionId ? sessions.get(sessionId) : undefined;

  if (!entry) {
    if (sessionId) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unknown_session" }));
      return;
    }

    if (!isInitializeRequest(parsedBody)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no_valid_session" }));
      return;
    }

    const server = buildForCaller(callerRef);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        sessions.set(newSessionId, { server, transport });
      },
      onsessionclosed: (closedSessionId) => {
        sessions.delete(closedSessionId);
      }
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
      server.close();
    };

    await server.connect(transport);
    entry = { server, transport };
  }

  await entry.transport.handleRequest(req, res, parsedBody);
}

const httpServer = createServer(async (req, res) => {
  const url = req.url ?? "/";

  if (url === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.startsWith("/mcp")) {
    try {
      await handleMcp(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

httpServer.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`isola-port-control-plane-mcp listening on http://${HOST}:${PORT} (mcp endpoint: /mcp, health: /healthz)`);
});

export { httpServer };

