# Isola — engineering operating rules

This file is loaded into every session in this repository. It is the short form.
Port.io is the authority; where this file and Port disagree, **Port wins** — re-read
the record and correct this file.

Run `/isola-start` at the beginning of any substantive task.

---

## 1. Authority map — who owns what

| System | Owns |
|---|---|
| **Port.io** | Product truth, execution packets, evidence, acceptance. The plan of record. |
| **Odoo** | Business/commercial system of record (invoices, customers, work orders). **The authority is `epic-communications-inc.odoo.com` and nothing else** — deepseek's `epic` is empty (0 moves), `epic_sandbox` has 283 moves, a company correctly named "EPIC Communications Inc" and **no invoice 348**; host03's `isola_erp` has no `account_move` table at all. The ledger outranks any record of the ledger — AR figures come from Odoo, never from Port. Only `payment_state` is trustworthy; the note trail is not. Never sum currencies. |
| **Magnus** | Voice/PBX/DID/rating/CDR authority. Never rebuilt in Isola. |
| **Chatwoot** | Conversations, human takeover, dedup. AI plugs in as an agent-bot. |
| **Clawith v1.11.0** | Customer-agent runtime — registration, tenants, agents, native WhatsApp. |
| **Isola/Foundation** | Identity, entitlements, governed provisioning, permissions, audit, routing. |
| **Hermes** | EPIC-internal owner/operator cockpit only. **Never** the customer-facing brain. |
| **Meta** | WhatsApp asset ownership (WABA, phone numbers, webhooks). Owner-gated. |

**Do not rebuild what an engine already owns.** Isola's remaining scope is commerce,
entitlements, governance, Meta asset ownership, Chatwoot handoff, voice, support,
acceptance, audit correlation, suspension/rollback.

## 2. Laws that block a change

1. **One authoritative processor per WhatsApp number.** Never wire a number to Clawith,
   Chatwoot and the BFF at once. Human takeover is a governed escalation contract, not a
   second webhook.
2. **Zero upstream forks of Clawith.** Glue lives in `isola-customer-tools` (MCP), the
   additive `isola_bridge.py` endpoint, and the `brain-provider.ts` per-number gate.
3. **Never build in a live checkout.** See §4.
4. **No `prisma db push`.** Ever. Use a reviewed migration, or `db execute` with explicit
   DDL against a zero-row target. Never edit `_prisma_migrations`; never `migrate resolve`.
5. **Repository code is not evidence of deployed behavior.** Verify the substrate — read
   the live config/catalog or observe real behavior. An app's own success banner, a
   write-then-read-back, or "someone set the config" are not proof.
6. **A firewall rule is not containment.** Verify exposure from a genuinely external
   client, never from loopback. Structural fix beats a filter rule.
7. **Direct DB/SSH mutation is emergency containment, not the operating model.** Every fix
   must leave a state model, an API boundary, audit evidence and a UI management path.
8. **Completion semantics.** A packet at 100% means only that item is accepted. Nothing is
   "done" because it compiles.
9. **Never infer a permission from an error code; read the ACL.** Odoo resolves the
   recordset **before** checking access, so a ghost-id `write`/`unlink` probe raises
   `MissingError` whether the right is granted or denied — it made a genuinely read-only
   credential look write-capable (2026-08-14). The authority is `ir.model.access`
   intersected with the user's effective groups; `ir.rule` only ever *restricts*, so the
   ACL is the ceiling. And **a `create` permission cannot be probed without creating**:
   there is no read-only test for it. If a create probe is authorised on a live system it
   **is a write** — choose the target deliberately, write the cleanup before the attempt,
   and verify both removal *and* unchanged neighbouring state. Never probe by writing to
   `account.move`: automations #10/#11/#12 fire `on_write` and post the false "paid"
   notes, so the probe would manufacture the defect being investigated.
10. **A retry that changes the request is a different request, not a retry.** It can
    carry you from one failure mode into another while looking like recovery. Measured
    2026-08-15: an agent key with no `X-Paperclip-Run-Id` gets `401 "Agent run id
    required"`; with a run id Paperclip never issued it gets `500`. Both call sites
    "recovered" from the 500 by dropping the header — walking straight into the 401.
    **The retry meant to save the employee's output was guaranteeing its loss.** Check
    every retry path against that sentence.
11. **The measuring instrument is part of the system under test.** An acceptance script
    reported `INCONCLUSIVE` on a test that plainly passed, because it asserted a word
    absent from the "before" answer that the *question itself* contained. Same family as
    a traceability gate that rejected its own source data (hyphens read as minus signs),
    a `--include` that matched nothing, and a structural scan that passes on a capital
    letter. When a check reports failure, **verify the check before believing it about
    the system** — and a check nobody has deliberately fired is a check that reports
    success.
12. **Partial agreement is more dangerous than total disagreement.** When two figures
   disagree and a third agrees, **do not** assume the disagreement is definitional.
   **Confirm which database answered first.** Measured 2026-08-14: `epic_sandbox` returned
   246 XCD / 458,701.86 — wrong — alongside 2 USD / 971.17, *identical to the truth*. The
   matching leg made a wrong leg look like a definition problem rather than a wrong
   database, and cost real time.

## 3. The 9 questions — answer before implementing

1. User and role served. 2. Existing route/surface that owns the capability. 3. Canonical
state owner. 4. Existing service/API contract. 5. External engine authority. 6. Smallest
current delta. 7. How it becomes manageable through the UI. 8. Replit migration effect.
9. What is reused, and what duplicate work is avoided.

## 4. Production topology — never build or write here

Host **deepseek 66.118.37.12**. These are live checkouts served by running processes:

`/opt/bff-v2` · `/opt/isola-runtime` · `/home/epicdm/clawith-v1110` ·
`/home/epicdm/hermes-workspace` · `/home/epicdm/.hermes/hermes-agent` ·
`/opt/hermes-eric` · `/opt/isola-bridge` · `/opt/lk-voice-agent` · `/opt/emapro-api`

> **Precedent:** a production build run inside `/opt/bff-v2` on a feature branch overwrote
> the live `.next` output in place, changed `BUILD_ID`, and traced candidate files into live
> route manifests. Build in a `git worktree` or an isolated copy — never in the directory a
> live process serves. Determine the deployed commit from the process's exec cwd, **not**
> from GitHub's default branch (which is stale for `epicdm/isolav2`; the real trunk is
> `fix/bffv2-retire-dashboard-reseller-campaigns-broadcast`).

**Protected numbers** — 3742 (sole public front door) · 9043 (Hermes internal, out of
scope) · 6737 (Front Desk / Customer Zero) · 0001 (legacy, do not touch) · 9525 (Anansi).
Shared WABA `272252189309178` carries 11 numbers: flip webhooks **per phone, never per
WABA**, and re-check `GET /{waba}/subscribed_apps` after any Chatwoot inbox change.

## 5. This repo

pnpm monorepo. **No CI, no lint, no CODEOWNERS** — a guard only runs if it is chained into a
`package.json` script. Prior art: `scripts/src/guard-not-prod-db.ts` (pure predicates +
entry-point-gated `main()` + unit **and** child-process integration tests).

| Task | Command |
|---|---|
| Targeted typecheck | `pnpm --filter @workspace/isola typecheck` |
| Single test | `pnpm --filter @workspace/isola exec vitest run <path>` |
| Guard tests | `pnpm --filter @workspace/scripts test` |
| Full typecheck | `pnpm run typecheck` |

Two independent auth realms: `lib/session.ts` (operator, Replit OIDC, carries the
`act_as_tenant_id` admin impersonation override) and `lib/consumer-session.ts` (consumer
OTP, HMAC cookie). They deliberately share no code. Five `tenant_id String?` columns rely
on an "exactly one of tenant_id / consumer_account_id" XOR that the schema does not
enforce. `api/voice/*` and `api/wallet/*` each have a `api/consumer/*` twin — one per
realm. These are the sharpest tenant-isolation review targets.

## 6. Stop conditions — stop and ask the owner

Unresolved conflict between ratified decisions · irreversible production or customer-data
risk · unavailable access with no approved route · tenant-isolation failure · a required
owner decision on price, legal terms or material product scope · an external dependency
with no safe fallback · uncertainty whether a governance floor is safely closed.

**Routine bugs and research questions are not stop conditions** — investigate and proceed.

Owner-only actions: Meta asset changes · Replit Publish · real customer contact · real
payment · broad launch · merging to a protected branch.

## 7. Skills

`/isola-start` · `/isola-plan-section` · `/isola-production-safety` · `/isola-pr-review` ·
`/isola-test-matrix` · `/isola-port-closeout` · `/isola-ui-convergence` ·
`/isola-deploy-readiness` · `/isola-incident`

Enforcement is deterministic, not advisory: `.claude/hooks/` blocks builds in live
checkouts, secret reads/writes, writes into live checkouts and build output, Meta
mutations, and prohibited schema commands. Run `node .claude/hooks/selftest.js` to verify.
