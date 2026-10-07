/**
 * Offline mock of the Port API. Records every request (method + path) so
 * tests can assert exactly what the server did on the wire.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockEntity {
  identifier: string;
  title: string;
  blueprint: string;
  updatedAt: string;
  properties: Record<string, unknown>;
}

export interface MockPort {
  url: string;
  requests: { method: string; path: string }[];
  /** true once an access_token request carried exactly the expected id+secret */
  authMatched: () => boolean;
  authAttempts: () => number;
  setEntities: (e: MockEntity[]) => void;
  close: () => Promise<void>;
}

// generated per run: no credential-shaped literal lives in the repo
export const MOCK_CLIENT_ID = "cid-" + randomUUID();
export const MOCK_CLIENT_SECRET = "fake-" + randomUUID() + "-" + randomUUID();
const MOCK_ACCESS = "mock-access-token-not-a-secret";

function evalRule(rule: any, e: MockEntity): boolean {
  if (rule.rules) {
    const rs = (rule.rules as any[]).map((r) => evalRule(r, e));
    return rule.combinator === "or" ? rs.some(Boolean) : rs.every(Boolean);
  }
  const val =
    rule.property === "$blueprint" ? e.blueprint
    : rule.property === "$title" ? e.title
    : rule.property === "$identifier" ? e.identifier
    : (e.properties as any)[rule.property];
  const s = String(val ?? "").toLowerCase();
  const want = String(rule.value ?? "").toLowerCase();
  if (rule.operator === "=") return s === want;
  if (rule.operator === "contains") return s.includes(want);
  return false;
}

export async function startMockPort(initial: MockEntity[], expected = { id: MOCK_CLIENT_ID, secret: MOCK_CLIENT_SECRET }): Promise<MockPort> {
  let entities = initial;
  const requests: { method: string; path: string }[] = [];
  let authMatched = false;
  let authAttempts = 0;

  const server: Server = createServer((req, res) => {
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0];
    requests.push({ method, path });
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status: number, obj: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (method === "POST" && path === "/v1/auth/access_token") {
        authAttempts++;
        const b = JSON.parse(body || "{}");
        if (b.clientId === expected.id && b.clientSecret === expected.secret) {
          authMatched = true;
          return send(200, { ok: true, accessToken: MOCK_ACCESS, expiresIn: 3600 });
        }
        return send(401, { ok: false });
      }
      if (req.headers["authorization"] !== `Bearer ${MOCK_ACCESS}`) return send(401, { ok: false });

      if (method === "POST" && path === "/v1/entities/search") {
        const q = JSON.parse(body || "{}");
        return send(200, { ok: true, entities: entities.filter((e) => evalRule(q, e)) });
      }
      let m = /^\/v1\/blueprints\/([^/]+)\/entities\/([^/]+)$/.exec(path);
      if (method === "GET" && m) {
        const e = entities.find((x) => x.blueprint === decodeURIComponent(m![1]) && x.identifier === decodeURIComponent(m![2]));
        return e ? send(200, { ok: true, entity: e }) : send(404, { ok: false });
      }
      m = /^\/v1\/blueprints\/([^/]+)\/entities$/.exec(path);
      if (method === "GET" && m) {
        return send(200, { ok: true, entities: entities.filter((x) => x.blueprint === decodeURIComponent(m![1])) });
      }
      return send(404, { ok: false });
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    authMatched: () => authMatched,
    authAttempts: () => authAttempts,
    setEntities: (e) => { entities = e; },
    close: () => new Promise((r) => { server.close(() => r()); (server as any).closeAllConnections?.(); })
  };
}
