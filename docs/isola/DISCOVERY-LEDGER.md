# Isola Discovery Ledger

**Version 1.0 · Frozen 2026-07-25 · Owner: Opus 5 section orchestrator**

The reusable record of Isola's codebase and runtime truth, per
`dec-isola-full-stack-chunked-delivery-2026-07-25` and
`xp-isola-canonical-program-map-and-discovery-ledger`.

**Read this before running discovery.** Re-probe a fact only when its
invalidation condition fires, when it is directly contradicted, or when your
change touches it. Every fact carries source, verification date, owner and
invalidation condition.

Legend — **Source**: how it was established. **Verified**: date of that reading.
**Invalidates when**: the event that makes the fact stale.

---

## 0. Corrections to prior belief (read first)

| # | Prior belief | Verified reality | Impact |
|---|---|---|---|
| C1 | Canonical UI lives on `feat/front-of-house-launch-readiness` @ `dfbcce7` (per `isola-current-state`) | That branch has **0 commits not in `main`**; `main` is **15 ahead**. `dfbcce7` is a brain-provider handoff fix, **not** the FOH baseline — the FOH routes commit is `27e598e0`. Both are ancestors of `main`. | **`main` is canonical.** Base all work on `main`. |
| C2 | `/app/home`, `/app/assistants`, `/app/conversations` are canonical routes | Those paths exist **only as strings in `contracts/cta-registry.js`**. No such pages exist. The real owner surface is the `app/(owner)/` group. | Build the "accepted equivalents", never a second `/app/*` route family. |
| C3 | The owner UI needs mock replacement | **All 10 existing `app/(owner)/` pages already read real data.** The only mock surface is the FOH/marketing adapter, reached solely from `app/(marketing)/**`. | Chunk 1 is **additive**, not a mock swap. |
| C4 | "The EPIC tenant/EMA data" is one dataset | It is **two unrelated datasets in two apps**. See §3. | Never bind Foundation UI to bff-v2 column names. |
| C5 | Clawith v1.11 holds EMA's channel config | Clawith `channel_configs` has **0 rows**. WhatsApp binding lives entirely in Foundation + Chatwoot. | A UI reading channel state from Clawith renders empty. |

---

## 1. Repositories and canonical branches

| Fact | Value | Source | Verified | Invalidates when |
|---|---|---|---|---|
| Owner UI repo | `epicdm/Isola-Foundation` | `git remote -v` | 2026-07-25 | remote changes |
| Canonical branch | **`main`** @ `c134f0f` (Merge PR #51) | `git merge-base --is-ancestor`, `git rev-list --count` | 2026-07-25 | any merge to main |
| FOH baseline commit | `27e598e0` "feat(isola): add Stage 1 front-of-house routes" — ancestor of main | `git log -1` | 2026-07-25 | never (historical) |
| Pricing (PR #49) | squash-merged as `e508680`, ancestor of main | `git merge-base` | 2026-07-25 | new pricing decision |
| Legacy ingress repo | `epicdm/isolav2` — deployed trunk is **`fix/bffv2-retire-dashboard-reseller-campaigns-broadcast`**, *not* GitHub's reported default (`legacy-pre-isola-archive`, stale) | R5A packet + pm2 exec cwd | 2026-07-25 | trunk renamed / PR #70, #72 merged |
| Monorepo shape | pnpm workspaces: `artifacts/isola` (Next 15 App Router), `artifacts/api-server` (Express auth), `artifacts/mockup-sandbox`, `lib/{db,api-zod,api-client-react,api-spec}`, `scripts` | `package.json`, `pnpm-workspace.yaml` | 2026-07-25 | workspace added |
| CI | **None.** No `.github/`, no CODEOWNERS, no lint script, no ESLint config anywhere | filesystem | 2026-07-25 | `.github/workflows` created |

**Verification commands**
```
pnpm --filter @workspace/isola typecheck                  # tsc --noEmit, incremental
pnpm --filter @workspace/isola exec vitest run <path>     # single test file
pnpm --filter @workspace/isola test                       # full suite
pnpm --filter @workspace/scripts test                     # guard tests, near-instant
node .claude/hooks/selftest.js                            # hook enforcement
```

---

## 2. UI routes and components

| Fact | Value | Source | Verified |
|---|---|---|---|
| Owner shell | `app/(owner)/layout.tsx` — server component; `getSession()` → redirect `/` if null; admin without `act_as_tenant_id` → `/admin`; shadcn `SidebarProvider` + `AppSidebar` + `Topbar` | file read | 2026-07-25 |
| Owner nav source of truth | `OWNER_NAV` in `components/app-sidebar.tsx`. Two **secondary** lists must be updated in step: `TITLES` in `components/topbar.tsx`, `OWNER_PAGES` in `components/command-menu.tsx` | file read | 2026-07-25 |
| Existing owner routes | `/workspace` `/dashboard` `/inbox` `/inbox/[id]` `/agent` `/voice` `/wallet` `/plan` `/onboard` `/workspace/[type]/[id]` — **all read real data** | file read | 2026-07-25 |
| Added by Chunk 1 | `/team`, `/team/[agentId]`, `/activity` | this packet | 2026-07-25 |
| Design system | Vendored shadcn (Radix + CVA + `cn`), pre-`data-slot` era. **Tailwind v4, CSS-first — there is no `tailwind.config.*`**; tokens live in `app/globals.css` + `styles/presets/*.css`. Extra tokens beyond stock: `success`, `warning` | file read | 2026-07-25 |
| Canonical patterns | Page header `text-2xl font-semibold tracking-tight`; page root `flex flex-col gap-5`; stat grid `grid gap-4 sm:grid-cols-2 lg:grid-cols-4`; detail split `grid gap-5 lg:grid-cols-3` + `lg:col-span-2`; empty state `CardContent flex flex-col items-center gap-2 py-16 text-center`; errors via `Alert variant="destructive"`; loading via `Skeleton`; icons `lucide-react` sized with `size-*` | file read | 2026-07-25 |
| Lists | Sortable/searchable lists use the generic `components/data-table.tsx` (TanStack). Raw `<Table>` only for non-sortable logs | file read | 2026-07-25 |
| Mobile | shadcn `Sidebar` becomes a `Sheet` below `MOBILE_BREAKPOINT = 768` (`hooks/use-mobile.tsx`). Owner app has **no** bottom nav — that is the consumer PWA only, do not reuse | file read | 2026-07-25 |
| Client data fetching | **No SWR, no react-query.** Server components + Prisma for reads; `useEffect` + `fetch` for client panels; mutation = `fetch` + `router.refresh()` with optimistic revert | file read | 2026-07-25 |

**Invalidates when:** any route added/removed under `app/(owner)/`, or the design system is upgraded.

---

## 3. The two-dataset rule (highest-value fact in this ledger)

**Foundation and bff-v2 are different applications with different databases and different schemas. Their tables have similar names and incompatible shapes.**

| | **Isola-Foundation** (the owner UI) | **bff-v2** (legacy ingress) |
|---|---|---|
| Repo | `epicdm/Isola-Foundation` | `epicdm/isolav2` |
| Runs on | Replit — `ema.epic.dm` resolves to `34.111.179.208`, Google Frontend, `x-powered-by: Next.js`. **Not on deepseek.** | deepseek, pm2 `bff-v2-web`, `*:3005`, nginx `bff.epic.dm` |
| Database | Its own Prisma DB (prod Neon `ep-fancy-cake…`; dev helium) | `isolav2` on deepseek `localhost:5433` |
| Tenant model | `Tenant` (cuid id, `business_name`, `wa_phone_number_id`, `chatwoot_account_id`, `clawith_tenant_id`, `magnus_did_number`) | `tenant_registry` (74 cols, `tenantId` PK, `waPhoneNumberId`, `v11TenantId`, `containerUrl`…) |
| Agent model | `Agent` (`tenant_id`, `name`, `greeting`, `business_info`, `knowledge_text`, `is_active`, `brain_provider`) | `Agent` (48 cols: `tenantId`, `chatwootInboxId`, `tools` as **JSON-in-text**, `soul`, `approvalMode`…) |
| Conversations | `Conversation` + `Message` (local mirror, `human_handling` flag) | reads Chatwoot directly |

> **Rule:** the owner UI reads **Foundation** models only. Never bind a Foundation
> component to a `tenant_registry` / bff-v2 `Agent` column name. They are not the
> same records.

**Source:** Foundation `prisma/schema.prisma` + read-only `psql` on deepseek `isolav2`.
**Verified:** 2026-07-25. **Invalidates when:** Foundation migrates onto the isolav2 database, or bff-v2 is retired.

---

## 4. Engine authority and ownership

| Concern | Authority | Notes | Verified |
|---|---|---|---|
| Product truth, packets, evidence | **Port.io** | — | 2026-07-25 |
| Business/commercial records | **Odoo** | `epic-communications-inc.odoo.com`, profile `retail-smb`, tier `T3` | 2026-07-25 |
| Voice / rating / CDR | **Magnus** | EPIC's `magnus*` columns in `tenant_registry` are **all NULL** | 2026-07-25 |
| Conversations + human takeover | **Chatwoot** | account **5**, sole surviving account, `EPIC Communications Inc — LIVE` | 2026-07-25 |
| Customer-agent runtime | **Clawith v1.11** | `agents.epic.dm` → `127.0.0.1:3309`; backend `:8801` | 2026-07-25 |
| Identity, entitlement, provisioning, audit, routing | **Isola/Foundation** | — | 2026-07-25 |
| Internal owner/ops cockpit | **Hermes** | internal only, never the customer brain | 2026-07-25 |
| WhatsApp assets | **Meta** | owner-gated; shared WABA `272252189309178` | 2026-07-25 |

---

## 5. EPIC Tenant Zero — live facts (read-only, deepseek)

**Source:** `psql` on `isolav2`, `docker exec` psql on Clawith + Chatwoot, `curl` openapi, `dig`/`curl -I`. **Verified:** 2026-07-25.

### Foundation-side registry row (bff-v2 `tenant_registry`)
`tenantId` `8166ea11-8db0-4f26-879a-e2067be0a018` · `businessName` EPIC Communications Inc ·
`didNumber` `17678183742` · `waPhoneNumberId` `975632242309171` · `wabaId` `272252189309178` ·
`whatsappStatus` active · `status`/`provision_status` active · `chatwootAccountId` `5` ·
`clawithTenantId` `47768881-…` / `clawithAgentId` `8166ea11-…` (**v1.8.3 binding**) ·
`v11TenantId` `6572bd90-…` / `v11AgentId` `81b38cd6-…` / `v11DispatchEnabled` **true** ·
`containerUrl` **still `http://127.0.0.1:8800/…` (v1.8.3)**.

> **Trap 1:** `tenantId`, Foundation `Agent.id` and `clawithAgentId` are **the same UUID reused three ways**.
> **Trap 2:** `clawith*` = v1.8.3 binding, `v11*` = v1.11 binding — different rows in different databases.
> **Trap 3:** dispatch is live on v1.11 while `containerUrl` still names 8800. Anything reading `containerUrl` reads the old runtime.

### Clawith v1.11 (the canonical customer runtime)
Tenant `6572bd90-…` = **EPIC Front Desk** (slug `test-83a674` — auto-generated, **never surface it**).
EMA agent `81b38cd6-…`: `status` **idle**, `agent_type` native, `role_description` a single 95-char sentence,
`bio` and `welcome_message` **empty**, model `deepseek-v4-pro`, no fallback wired, `tokens_used_total` 853,792.
**`channel_configs` = 0 rows** — Clawith knows nothing about WhatsApp.
**`agent_tools` = 133 rows for EMA, exactly 3 enabled**: `escalate_to_human`, `finish`, `get_my_account`.
`agent_tools.enabled` is the authoritative per-agent flag (`tools.enabled` is catalog-wide `true`).

> **Version trap:** the `:8801` backend self-reports **`1.10.3`**, while Foundation stores
> `v11RuntimeGeneration = 'v1.11.0'`. Foundation's string is an assertion, not an observation.

### Chatwoot (account 5)
91 conversations. Inboxes: **3** `EPIC WhatsApp (Live)` (`Channel::Api`, the 3742 inbox), 17 Isola Web,
36, 38, 46 (`Channel::Whatsapp`, the 6737 line).

**Human-handoff truth — the label is the gate:**
- Authoritative marker is the **`human_takeover` label** in `cached_label_list`.
- Observed `escalated:<reason>` values: `human-request`, `low-confidence`, `out-of-scope`, `follow-up-delayed`, `support-team-wiring-test`.
- `custom_attributes` keys always set by warm handoff: `isola_agent`, `handoff_reason`, `ai_mode`, `human_owner`.
- `status` enum: `open:0, resolved:1, pending:2, snoozed:3` (72/3/16 observed) — **status alone is not handoff state**.
- **`assignee_agent_bot_id` is NULL on all 91 rows** — it is dead in practice, do not derive handoff from it.

**Invalidates when:** any tenant/agent/channel change on 3742, a Clawith upgrade, or a Chatwoot account change.

---

## 6. Protected production assets

Never build, write or mutate in: `/opt/bff-v2` · `/opt/isola-runtime` (v1.8.3, frozen) ·
`/home/epicdm/clawith-v1110` · `/home/epicdm/hermes-workspace` · `~/.hermes/hermes-agent` ·
`/opt/hermes-eric` · `/opt/isola-bridge` · `/opt/lk-voice-agent` · `/opt/emapro-api`.

Protected numbers: **3742** (sole public front door) · **9043** (Hermes internal — out of scope) ·
**6737** (Front Desk / Customer Zero) · **0001** (legacy) · **9525** (Anansi).
Shared WABA `272252189309178` carries 11 numbers — flip webhooks **per phone, never per WABA**.

Enforcement is deterministic in `.claude/hooks/isola-guard.js` (26 self-tests).

---

## 7. Known gaps (assigned, not hidden)

| # | Gap | Consequence | Owner |
|---|---|---|---|
| G1 | No live Chatwoot conversation reader. `engines/chatwoot.ts` has only `getContactConversations(contactId)` — no list, no messages | Owner UI shows the **Foundation mirror**, labelled `isola.mirror`, not live Chatwoot | Later chunk |
| G2 | No per-agent tool/responsibility model in Foundation. `TOOL_NAMES` is 3 global constants | Tools panel renders `not_configured` honestly; real per-agent truth lives in Clawith `agent_tools` and is unsurfaced | Later chunk |
| G3 | `Conversation` has no agent foreign key | Per-agent volumes only attributable when the tenant has exactly one assistant; otherwise reported workspace-level | Later chunk |
| G4 | Authenticated Clawith endpoints (`/api/agents/{id}`, `/sessions`, `/chat-history/*`, `/metrics`) declare **no response schema** and were not callable without a token | Do not build against those shapes from the spec alone | Later chunk |
| G5 | `getSessionFromCookie(header)` ignores its argument entirely | New code must call `getSession()` | Done in Chunk 1 |
| G6 | Admin guarding inconsistent — `requireAdmin()` used by exactly one route; all others inline `ctx?.isAdmin` | Hardening candidate | Later chunk |
| G7 | Tenant→ChatwootBinding is 1:many; `findFirst({tenant_id})` is ambiguous | Always resolve per-conversation `chatwoot_binding_id` or via `resolveActiveBinding()` | Standing rule |
| G8 | No local Postgres, no Docker, no Playwright in the engineering environment | Signed-in real-data UAT cannot be run locally — requires owner-provided dev DB or a deploy gate | Owner |
| G9 | 18 IsolaServices contracts are all mock; `configure({mode:'real'})` is never called | FOH funnel remains mock; owner workspace deliberately uses the control-plane API instead | Later chunk |

---

## 8. Freshness and invalidation rules

1. **Repository facts** (§1, §2) — invalid on any merge to `main`. Re-check with `git log`/`git ls-tree`; cheap.
2. **Schema facts** (§3) — invalid on any Prisma migration. Re-read `schema.prisma`.
3. **Live runtime facts** (§5) — treat as **stale after 7 days** or immediately on any deploy, cutover, or channel change. Re-verify read-only.
4. **Engine authority** (§4) — changes only by ratified decision.
5. **Protected assets** (§6) — changes only by ratified decision; mirrored in `.claude/hooks/lib/isola-topology.js`.
6. **Repository code is not evidence of deployed behaviour.** Verify the substrate before asserting production behaviour.
7. **An app's own success banner is not proof.** Read live columns/config, or observe real behaviour.

---

## 9. Change log

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-07-25 | Initial freeze. Corrections C1–C5, two-dataset rule, EPIC live facts, gaps G1–G9. |
