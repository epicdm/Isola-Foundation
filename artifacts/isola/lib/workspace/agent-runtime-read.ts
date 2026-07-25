/**
 * Governed read adapter for the customer-agent runtime (Clawith v1.11).
 *
 * SERVER ONLY. Browser pages never import this — they reach it through
 * `/api/workspace/*`, which is the control-plane boundary.
 *
 * What this is for: EMA's real enabled tools and its real role/knowledge text
 * live in the runtime, not in Foundation. Reporting them as "not configured"
 * would be false — the information exists, it simply has to be read across a
 * boundary. This adapter is that read.
 *
 * What it must never do:
 *  - expose runtime credentials, `api_key_hash`, container ids/ports, model
 *    ids, autonomy policy internals, tenant slugs or token counters;
 *  - be called from a client component;
 *  - mutate anything. Every call here is a GET.
 *
 * Configuration (names only — values come from the deployment's secret store):
 *   AGENT_RUNTIME_BASE_URL   e.g. an internal, governed base URL for the runtime
 *   AGENT_RUNTIME_TOKEN      bearer credential for a read-scoped service identity
 *
 * When either is absent the adapter reports `configured: false` and the caller
 * renders an honest `unavailable` state naming the missing wiring — never
 * `not_configured`, which would imply the data does not exist.
 */

/**
 * Server-only guard. The `server-only` package is not a dependency of this
 * workspace, so the boundary is enforced directly: importing this module into
 * anything that runs in a browser throws immediately and loudly, rather than
 * shipping a runtime credential to the client.
 */
if (typeof window !== 'undefined') {
  throw new Error('agent-runtime-read is server-only and must not be imported by client code');
}

const TIMEOUT_MS = 8000;

export interface RuntimeTool {
  name: string;
  displayName: string;
  description: string | null;
  category: string | null;
}

export interface RuntimeProfile {
  /** The assistant's role text as configured in the runtime. */
  roleDescription: string | null;
  bio: string | null;
  welcomeMessage: string | null;
  /** Runtime lifecycle state, mapped to owner-readable words. */
  runtimeState: string | null;
  lastActiveAt: string | null;
}

export type RuntimeReadResult =
  | { configured: false; reason: string }
  | { configured: true; ok: false; reason: string }
  | { configured: true; ok: true; profile: RuntimeProfile; tools: RuntimeTool[]; toolsVerified: boolean; readAt: string };

function config(): { baseUrl: string; token: string } | null {
  const baseUrl = process.env.AGENT_RUNTIME_BASE_URL;
  const token = process.env.AGENT_RUNTIME_TOKEN;
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

/** Owner-readable mapping for the runtime's lifecycle enum. */
const STATE_LABELS: Record<string, string> = {
  running: 'Running',
  idle: 'Idle — ready for the next message',
  creating: 'Starting up',
  stopped: 'Stopped',
  error: 'Needs attention',
};

async function get(path: string, cfg: { baseUrl: string; token: string }): Promise<unknown | null> {
  const res = await fetch(cfg.baseUrl + path, {
    method: 'GET',
    headers: { authorization: `Bearer ${cfg.token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return res.json();
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Read one agent's public-facing profile and enabled tools from the runtime.
 *
 * `clawithAgentId` must come from the tenant-scoped `ClawithBinding` — this
 * function performs no tenant resolution of its own and must never be handed a
 * caller-supplied id.
 */
export async function getAgentRuntimeProfile(clawithAgentId: string): Promise<RuntimeReadResult> {
  const cfg = config();
  if (!cfg) {
    return {
      configured: false,
      reason:
        'This deployment has no governed read path to the assistant runtime, so live tool and role details cannot be shown here yet. They exist in the runtime.',
    };
  }

  try {
    // Agent profile. `GET /api/agents/` returns a typed list; filtering it is
    // the verified path. `GET /api/agents/{id}` exists but declares no response
    // schema, so it is used only as a fallback.
    let agent: Record<string, unknown> | null = null;
    const list = await get('/api/agents/', cfg);
    if (Array.isArray(list)) {
      agent = (list as Array<Record<string, unknown>>).find((a) => a?.id === clawithAgentId) ?? null;
    }
    if (!agent) {
      const single = await get(`/api/agents/${encodeURIComponent(clawithAgentId)}`, cfg);
      if (single && typeof single === 'object') agent = single as Record<string, unknown>;
    }
    if (!agent) {
      return { configured: true, ok: false, reason: 'The assistant was not found in the runtime.' };
    }

    const rawState = asString(agent.status);
    const profile: RuntimeProfile = {
      roleDescription: asString(agent.role_description),
      bio: asString(agent.bio),
      welcomeMessage: asString(agent.welcome_message),
      runtimeState: rawState ? (STATE_LABELS[rawState] ?? rawState) : null,
      lastActiveAt: asString(agent.last_active_at),
    };

    // Enabled tools. The per-agent tool endpoint is not present in the verified
    // OpenAPI document, so treat its absence as "not verified" rather than
    // "no tools" — silently rendering an empty list would be a false statement.
    let tools: RuntimeTool[] = [];
    let toolsVerified = false;
    const toolsBody = await get(`/api/agents/${encodeURIComponent(clawithAgentId)}/tools`, cfg);
    const rows = Array.isArray(toolsBody)
      ? toolsBody
      : Array.isArray((toolsBody as { items?: unknown })?.items)
        ? ((toolsBody as { items: unknown[] }).items as unknown[])
        : null;
    if (rows) {
      toolsVerified = true;
      tools = (rows as Array<Record<string, unknown>>)
        .filter((t) => t?.enabled !== false)
        .map((t) => {
          const tool = (t.tool as Record<string, unknown>) ?? t;
          return {
            name: asString(tool.name) ?? 'tool',
            displayName: asString(tool.display_name) ?? asString(tool.name) ?? 'Tool',
            description: asString(tool.description),
            category: asString(tool.category),
          };
        });
    }

    return { configured: true, ok: true, profile, tools, toolsVerified, readAt: new Date().toISOString() };
  } catch (err) {
    // Never surface the raw error — it can carry the base URL.
    const reason =
      err instanceof Error && err.name === 'TimeoutError'
        ? 'The assistant runtime did not respond in time.'
        : 'The assistant runtime could not be reached.';
    return { configured: true, ok: false, reason };
  }
}
