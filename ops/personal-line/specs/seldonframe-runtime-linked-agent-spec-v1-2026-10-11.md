# SeldonFrame runtime-linked agent (Class 2) — spec v1 (draft, 2026-10-11)

Port: `spec-seldonframe-runtime-linked-agent-hermes-v1-2026-10-11` · decision
`dec-two-agent-classes-seldonframe-native-and-runtime-linked-hermes-2026-10-11` (ratified).

## Purpose
Sell and manage long-running, goal-driven agents (COO, CEO, operations manager) whose **brain runs on an external
runtime** — first Hermes — through SeldonFrame, next to the native Class 1 agents. SeldonFrame owns the storefront,
customer, channels, management UI, metering, billing and governance. Hermes owns reasoning, tools, memory and sub-agents.

Out of scope here: building the Hermes COO/CEO itself (another team), and Class 1 agents (unchanged).

## Seams already in SeldonFrame (production code, read 2026-10-11)
- `lib/agents/runtime.ts` / `executeTurn`: model resolution happens before the turn. The remote branch goes right after it,
  in the same place as the existing "usage capped" short-circuit. `stateless-turn.ts` (`runStatelessAgentTurn`) gets the same.
- `lib/agents/runtime/select-turn-model.ts`, `turn-model.ts`: the model selection point the executor sits beside.
- `voice-agent-context` route: precedent for an external runtime pulling an agent's persona/config from SeldonFrame.
- `lib/agents/mcp/*`: MCP connectors with secrets by name (`getSecretValue`) — same pattern for the runtime credential.
- `triggers/*` (event + schedule) and `channels/run-channel-turn.ts`: how work is started; reused, not duplicated.
- SeldonFrame's own MCP server (list_agents, get_agent_metrics, tail_agent_conversations, run_agent_evals,
  update_agent_blueprint, …): what a COO uses to supervise Class 1 agents.

## 1. Data model (jsonb blueprint, no migration for v1)
```
blueprint.executor = { kind: "native" }                       // default; Class 1, byte-for-byte today
                   | { kind: "remote",
                       runtime: "hermes",                     // later: openclaw | agno | paperclip
                       endpoint: "https://…",                 // per-customer Hermes profile API
                       profile: "<hermes profile id>",
                       secretName: "<SeldonFrame secret name>",// bearer for that profile; never stored inline
                       mode: "async" }                        // v1: async jobs only
```
A `runtime_bindings` table (later, P-D2) generalises this for many endpoints (inboxes, DIDs) per agent.

## 2. Turn / job contract (async — a COO does not answer in 10 s)
1. **Start** — SeldonFrame → `POST {endpoint}/v1/runs`
   `{ run_ref, agent_id, workspace_id, conversation_id, input: {text, attachments?}, context: {persona, facts,
   allowed_tools_hint}, callback_url, deadline_s }` → `202 { run_id }`. Signed request (HMAC with the binding secret,
   timestamp ±300 s), idempotent on `run_ref`.
2. **Progress / result** — Hermes → `POST {callback_url}` events: `started`, `progress{note}`, `needs_approval{action,
   summary, risk}`, `message{text}` (to post to the customer channel), `completed{summary, usage}`, `failed{code}`.
   Signed with the same scheme; SeldonFrame verifies, dedups by event id, and appends to the agent conversation +
   activity feed. `message` goes out through the native channel/guardrail/verify path (Class 1 safety still applies to
   anything sent to a customer).
3. **Status pull** (fallback) — SeldonFrame → `GET {endpoint}/v1/runs/{run_id}`.
4. **Cancel / kill switch** — SeldonFrame → `POST {endpoint}/v1/runs/{run_id}/cancel`; the agent-level kill switch
   cancels all open runs and refuses new ones. A test must prove the run actually stopped (state read back from Hermes).

## 3. Management UI (SeldonFrame agent page, new "Runtime" tab; Connections tab is the base)
- Binding: runtime, endpoint, profile, secret name (value never shown), health (last heartbeat).
- **Resolved toolset**: read from the Hermes profile via API, displayed as-is (Law 24 — a prompt/charter is not a permission).
- Runs: open / recent, progress notes, results, cost.
- Approvals queue: `needs_approval` items → approve / reject (recorded with actor).
- Budget: monthly cap + per-run cap; a run that would exceed it is refused before start.
- Kill switch.
- Every setting here is written to Hermes through its API (UI → API → readback); nothing is hand-edited on the host.

## 4. COO supervising Class 1 agents
Hermes profile gets an MCP connection to SeldonFrame's MCP server with a **per-workspace scoped key**: read
(agents, metrics, conversations, evals) by default; writes (update_agent_blueprint, publish) only via `needs_approval`
until the owner widens it.

## 5. Selling
Marketplace listing type "runtime agent"; price models per_usage / monthly. Hermes reports usage in `completed.usage`;
SeldonFrame meters and bills through the existing listing/wallet path. Usage is recorded as `model: "remote:hermes"`.

## 6. Isolation and safety rules (from the decision)
- One Hermes profile per customer workspace; never the owner cockpit profile (`epic-operator`).
- New profiles: enumerate what they START, disable inherited platforms explicitly in config AND env (Law 25).
- Scope the toolset before raising timeouts (Law 24).
- Secrets: referenced by name; minted through the owner secret path; shape-checked on staging before attach.
- Fail closed: runtime unreachable → the customer is told plainly and staff are alerted; never a confident guess.

## 7. Build order (Lane A, after the native WhatsApp channel)
1. `executor` field + remote branch + signed start/callback/cancel + conversation/activity append (staging, mock runtime).
2. Runtime tab (binding, health, resolved toolset, runs, kill switch) — UI/API/readback.
3. Approvals queue + budget caps.
4. First real binding: the other team's internal EPIC COO (Hermes) — internal workspace only.
5. SeldonFrame MCP link for the COO (read-only first).
6. Marketplace listing + per-customer profile provisioning.

## 8. Acceptance (each with a positive control)
- Native agents unchanged (existing suites green; a native agent turn byte-for-byte the same).
- Remote run: start → progress → message posted through the native send path → completed; usage metered.
- Bad signature / replay / unknown run → refused (and a correctly signed one accepted in the same run).
- Kill switch cancels an open run (state read back from Hermes) and refuses a new one.
- Toolset shown in the UI equals the toolset Hermes resolves.
- Customer A's workspace can never reach customer B's profile (tenant-isolation test).

## Open questions for the Hermes team
- Hermes run API shape today (`/v1/runs` contract recorded in Port 2026-10-03) — confirm fields, callbacks, cancel.
- Profile provisioning API (create profile, set toolset, disable platforms) — or manual for v1?
- Where usage/cost is measured on the Hermes side.
