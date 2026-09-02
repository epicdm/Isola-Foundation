# bff-v2 → host03 MIGRATION INVENTORY

**VOICE lane · 2026-08-16 · READ-ONLY. Nothing moved, nothing changed.**
Deliverable 1 of the migration. `[U]` marks unmeasured — stated, not guessed.

---

## 0. HEADLINE NUMBERS

| | |
|---|---|
| API routes | **435** `route.ts` across 54 groups |
| Pages | 58 `page.tsx` |
| Background functions | 27 Inngest, **9 carrying crons** |
| Processes sharing the tree | **4** (not 1) |
| Databases on 5433 | **7** (+`postgres`), ~85 MB total |
| Real rows, all DBs | **~8,700** |
| Env keys | **233**, ~40 distinct external systems |
| node_modules | 1.4 GB |

**The data is small. The surface is not.** The move is not constrained by volume; it is
constrained by how many things point at this host.

---

## a. WHAT bff-v2 ACTUALLY IS

### Route groups (count of `route.ts`)
```
151 internal      39 lite        33 odoo       30 dashboard   29 platform
 15 voice         15 isola       14 admin      12 cron         8 agents
  7 whatsapp       6 reseller     6 campaigns   6 auth          5 agent
  4 broadcast      4 billing      3 wa-desk     3 templates     3 calling
  2 each: workspace wallet push contacts chatwoot catalog calls business
  1 each: todos testimonials test-ai telegram support reminders provision otp
          number messenger livekit inngest-relay inngest health fleet facebook
          conversations content connections chat calendar brand bills analytics
```
`internal/` alone is **151 routes** — a third of the service, and the group most likely to
be called host-to-host rather than through the public name.

### FOUR PROCESSES SHARE `/opt/bff-v2`, NOT ONE
Migrating "bff-v2" means migrating all four, or deciding deliberately which stay:

| pm2 process | what it is |
|---|---|
| `bff-v2-web` | the Next.js server, `next start`, port 3005 |
| `ami-listener` | `/opt/bff-v2/ami-listener.js` — Asterisk AMI listener |
| `inngest-resync` | `/opt/bff-v2/node_modules/.bin/tsx` — background resync |
| `mcp-isola-customer-tools` | `/opt/bff-v2/services/mcp-isola-customer-tools/run.sh` |

### Cron cadences in Inngest
`*/2`, `*/5`, `*/10`, `*/15` minutes, and daily `0 13`, `0 14`. **Two services must never
run these simultaneously**, which is the sharpest constraint on a parallel run — see §d.

---

## b. THE DATA — AND A STATS TRAP THAT WOULD HAVE RETIRED FIVE LIVE DATABASES

`pg_stat_user_tables.n_live_tup` reported **0 rows for six of seven databases**, and
`xact_commit` reported 0 for five. Both are wrong here:

- **Uptime is only 1 d 4 h.** `xact_commit=0` means "none in 29 hours", not "never". *Law:
  activity can prove alive, it cannot prove dead.*
- **`n_live_tup` is stats-derived and stale.** `Agent` holds 15 rows and did not appear in
  the top-15 list at all.

Real counts, via `count(*)`:

| database | size | **real rows** | stats claimed |
|---|---|---|---|
| **isolav2** | 21 MB | **8,153** | 19 |
| ocmt | 11 MB | **294** | 0 |
| isolav2_staging | 11 MB | **181** | 0 |
| bff | 9.4 MB | **14** | 0 |
| isola_shell_v2 | 8.2 MB | **67** | 0 |
| isola_shell | 7.9 MB | **12** | 0 |
| isola_staging | 8.5 MB | 0 | 0 |

`isolav2` is the live one: **5 connections, 187,932 commits, 80 tables** — 270 `User`,
15 `Agent`, 12 `tenant_registry`. Largest tables by bytes: `AgentActivity` 2.9 MB,
`PaperclipMirror` 880 kB, `WhatsAppMessage` 680 kB, `Agent` 528 kB, `call_record` 416 kB.

**Only `isola_staging` is provably empty.** Everything else holds data and needs a
positive reason before retirement, not an absence of traffic.

---

## c. CONFIGURATION — 233 KEYS, NAMES AND COUNTS ONLY

Source-stop honoured: no value was read. Grouped by leading token:

```
18 ISOLA   16 ODOO    14 META    12 CHATWOOT  9 LITE     8 NEXT    8 EPIC
 7 STRIPE   7 OCMT     7 MAGNUS   7 INTERNAL  6 SMTP     5 WORK    5 LIVEKIT
 5 INNGEST  5 HYPERSWITCH  4 UISP  4 OWNER    4 BFF      4 ASTPP   3 WHATSAPP
 3 VOICE00  3 VAPID    3 POOL     3 PAPERCLIP 3 OPS      3 LANGFUSE 3 EMA
 2 V11 STAFF SMTP2GO RELOADLY READINESS POSTHOG OPENCLAW NODE FLOW FISERV ESL CLERK
```

**~40 distinct external systems in one service.** Payments (Stripe, Hyperswitch, Fiserv),
telephony (Magnus, LiveKit, ESL, ASTPP, VOICE00), messaging (Meta, Chatwoot, WhatsApp,
SMTP2GO), ERP (Odoo), observability (Langfuse, PostHog), identity (Clerk). Each is a
credential to re-place as a swarm secret and a dependency to re-verify after the move.

`ASTPP` keys exist here `[U]` — the poller was ruled legacy; whether these are live or
vestigial is unresolved and must not be assumed either way.

---

## d. WHAT BREAKS IF IT MOVES

### DNS — measured, and it removes one worry and confirms another
| hostname | resolves to | consequence |
|---|---|---|
| **bff.epic.dm** | **66.118.37.12 deepseek** | **MUST MOVE.** The live public name. |
| **voice.isola.epic.dm** | **66.118.37.12 deepseek** | **MUST MOVE.** |
| test.epic.dm | **66.118.37.110 host03** | **deepseek's `test.epic.dm` nginx vhost is DEAD CONFIG** — public traffic already goes to host03's fiserv-api. Nothing to move. |
| inbox.epic.dm | deepseek | Chatwoot — retires after 6737 cutover proves. |
| paperclip.epic.dm | deepseek | legacy Paperclip — agents migrate, instance retires. |
| isola.epic.dm / staging.isola.epic.dm | 34.111.179.208 | Foundation on Replit — unaffected. |
| isola-ai.saas00.epic.dm | host03 | authoritative Paperclip — already home. |

### nginx does per-path proxying, not one blanket rule
`bff.epic.dm` proxies **six path prefixes individually** — `/api/whatsapp/`, `/api/voice/`,
`/api/internal/`, `/api/dashboard/`, `/api/platform/`, `/api/cron/` — plus a catch-all, and
one comment records a 2026-04-12 repoint from `:3004` (v1) to `:3005` (v2). **A Traefik
rule that only matches the host will not reproduce this**; the path map has to be carried
across deliberately, or a prefix silently 404s.

### The IP-bypass blocker — ENUMERATED, AND IT COMES BACK CLEAN

A caller that hardcodes an address does not migrate when a name moves; it keeps calling
the old machine until the old machine stops. That is how a "completed" cutover leaves
half its traffic behind. So this was enumerated by **configuration, not traffic** — a
single `ss` sample shows who is connected now, not who calls every 15 minutes.

| caller | how it addresses bff-v2 | migrates with DNS? |
|---|---|---|
| `isolaruntime-backend-1` (docker, deepseek) | `bff.epic.dm` | **yes** |
| `/opt/lk-voice-agent/agent.py` | `BFF_URL`, default `https://bff.epic.dm` | **yes** |
| `lk-voice-agent/.env` `BFF_URL` value | epic.dm name — **no dotted quad, no localhost** (pattern counts only; value never read) | **yes** |
| `/opt/emapro-api` | no reference | n/a |
| `/home/epicdm/.hermes` | matches are **June session request-dumps** — historical artefacts, not configuration | n/a |
| nginx | only `bff.epic.dm` (+ its `sites-available` twin). No hidden upstreams. | n/a |

**No hardcoded-IP caller found.** Every configured consumer uses the hostname, so the DNS
cutover carries them. This materially de-risks the cutover — but it is a *point-in-time
configuration* finding: re-run it immediately before cutover, because a new caller can be
added at any time.

Still requiring action regardless:
- **Meta webhooks** — registered per phone number, must be re-registered; owner-gated.
- **Chatwoot** webhooks into bff-v2.
- `ss` showed exactly one connection on 3005 at rest: `127.0.0.1 → 127.0.0.1`, the server
  to itself. Consistent with the above, and not by itself sufficient evidence.

### THE ami-listener CONSTRAINT — MEASURED. IT IS REAL, AND IT IS AN ACL CHANGE.

`ami-listener` cannot simply move. Measured in `/etc/asterisk/manager.conf` on voice00:

```
[epic-ai-app]
deny  = 0.0.0.0/0.0.0.0
permit = 66.118.37.12/255.255.255.255      ← DEEPSEEK, /32
```

**AMI would refuse a connection from host03 outright.** This is the named constraint, so
per the ruling it is an ACL change and not an exemption: `manager.conf` must permit
**66.118.37.110** before `ami-listener` moves, and the old entry is removed after.

### AND THERE IS A **SECOND** GATE IN FRONT OF IT — MEASURED, AND IT WAS NOT IN THE PLAN

`manager.conf` alone is **not sufficient**. AMI is also filtered at the network layer, by
iptables on voice00 itself:

```
-P INPUT DROP                                                  ← default-deny
-A INPUT -s 127.0.0.1/32    -p tcp --dport 5038 -j ACCEPT
-A INPUT -s 66.118.37.12/32 -p tcp --dport 5038 -j ACCEPT      ← DEEPSEEK ONLY, /32
```

Proven by TCP probe from three vantage points, each with a known-open control (22) and a
known-closed control (5039), so a "filtered" result is a finding and not a broken probe:

| source | 22 (control) | **5038** | 5039 (control) |
|---|---|---|---|
| workstation 66.118.37.10 | CONNECTED | **filtered** | filtered |
| **deepseek 66.118.37.12** (permitted) | CONNECTED | **CONNECTED** | filtered |
| **host03 66.118.37.110** (target) | CONNECTED | **filtered** | filtered |

**⇒ MOVING `ami-listener` REQUIRES TWO CHANGES ON voice00, NOT ONE:**
1. **iptables** — `ACCEPT` 5038 from `66.118.37.110`
2. **manager.conf** — `permit = 66.118.37.110`

**If only `manager.conf` is changed, the service still fails — refused at the network
before AMI ever sees a login — and the symptom is indistinguishable from an ACL problem,
sending whoever is debugging it to the wrong file at the worst moment.**

IPv6: voice00 has **no AAAA record**, so there is no v6 target. The v6 half is **n/a, not
skipped**.

### Sequencing and scope
- Both are **live PBX changes**, and there is already a scheduled edit to `manager.conf`
  (the line-34 item). **One backup, both edits, one reload.** Batching is correct here
  because these share a rollback unit and fail loudly and immediately — a PBX either
  reloads and completes calls or it does not. **Take a completed call as the positive
  control FIRST**, because "calls are broken" discovered after an edit is
  indistinguishable from "calls were already broken" without it.
- **`bindaddr = 0.0.0.0` is ANSWERED, not open.** The network filter fronts it, so the
  bind address contributes nothing either way. Defence-in-depth preference — **filed, not
  urgent.**
- **F-01 (full-privilege AMI account) rides along ONLY if the required privilege set is
  already known.** If right-sizing needs discovering which classes `ami-listener` uses, it
  does **not** ride along; it goes to the scheduled right-sizing day. Do not turn a
  two-line change into an open investigation on a live PBX.
- `[magnus]` is loopback-only (`permit=127.0.0.1`) and unaffected.
- `[U]` **Is this iptables ruleset persisted across reboot?** This estate has a recorded
  case of rules present in `ufw status` and absent from `iptables -S` after a reboot. With
  `-P INPUT DROP`, losing the ruleset breaks AMI rather than exposing it — it fails in the
  safe direction — but it would look exactly like a broken migration. Verify before the
  change window.

### The parallel-run hazard, and it is the big one
**Nine Inngest cron functions.** Standing bff-v2 up on host03 alongside deepseek means
**both would fire the same schedules** — double provisioning, double polling, double
outbound messages. The parallel run must start with **schedulers disabled on the new
instance**, enabled only at cutover. This is the single most likely way a careful
migration causes a customer-visible incident.

### Exposure note, needs verification `[U]`
`next-server` binds **`*:3005`** (all interfaces), not loopback. ufw shows a rule allowing
3005 only from `172.17.0.0/16` — but this estate has a recorded failure where **ufw listed
rules that `iptables -S` did not have after a reboot**. Confirm at the iptables level, both
IPv4 and IPv6, before trusting containment. Not chased tonight.

---

## e. THE TARGET — DECLARED COMPOSE, NOT AN EASYPANEL APP

Shape only; **ESTATE writes the stack and the secrets, VOICE defines the service.**

```yaml
# host03 — declared stack, NOT created as an EasyPanel app.
# EasyPanel injects restart.condition=on-failure on every deploy and strips
# out-of-band network attachments; a `docker service update` shows success and
# silently reverts. Declare it.
services:
  bff-v2-web:
    image: <registry>/bff-v2:<DIGEST>      # digest-pinned, never a mutable tag
    command: ["node_modules/.bin/next", "start"]
    environment:
      NODE_ENV: production
      PORT: "3005"
    secrets: [bff_env]                      # 233 keys as a swarm secret, not a baked file
    deploy:
      replicas: 1                           # single replica: crons are not idempotent
      restart_policy: { condition: any }    # `any`, not on-failure
    networks: [isola_net, traefik_net]
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:3005/api/health"]
secrets:
  bff_env: { external: true }
```

### THE SCHEDULER MUST BE STRUCTURALLY INERT, NOT PROCEDURALLY DISABLED

**A runbook step gets skipped. A default does not.** The new instance must be *incapable*
of firing a scheduled function until deliberately enabled — same shape as
`unset = nothing migrated` in the persona gate.

```yaml
    environment:
      # DEFAULT OFF. Absent or "0" => the Inngest functions are NOT REGISTERED,
      # not merely skipped. A new instance is inert by construction; enabling
      # schedulers is an explicit, separate act performed only at cutover.
      ISOLA_SCHEDULERS_ENABLED: "0"
```
Both instances firing the same nine crons means double provisioning, double polling and
**double outbound messages to real customers**. Four of the nine run every 2–15 minutes,
so the window to notice is minutes.

### SINGLE REPLICA IS A CONSTRAINT OF THE SERVICE, NOT A DEPLOYMENT PREFERENCE

```yaml
    deploy:
      replicas: 1   # CONSTRAINT, NOT A TUNING CHOICE.
      # The Inngest cron functions are NOT IDEMPOTENT. A second replica does not
      # add availability, it duplicates every scheduled side effect. Do not scale
      # this for uptime. Making it safely >1 requires leader election or moving
      # the schedulers out of the web service — neither of which is done.
```

### TRAEFIK REPRODUCES THE PATH MAP — ACCEPTANCE IS PER-PREFIX

nginx proxies six prefixes individually. **A host-only rule silently 404s five of them**,
and a 404 on one prefix of a 435-route service is exactly what nobody notices until a
customer does. Acceptance is **six probes, one per prefix, each asserting a real response**
— *a host answering proves the route exists and proves nothing about the five prefixes you
did not ask for.*

```
/api/whatsapp/   /api/voice/   /api/internal/   /api/dashboard/   /api/platform/   /api/cron/
```
Carry forward the recorded reason on the catch-all: **repointed from `:3004` (v1) to
`:3005` (v2) on 2026-04-12.** A repoint without a reason is the next person's mystery.

### DECISIONS — RULED

1. **All four processes move.** The `ami-listener` exception is refused; its real
   constraint is the AMI ACL (see §d) and the fix is an ACL change.
2. **Postgres: a PROVEN RESTORE.** Acceptance is the `count(*)` table in §b matched
   **exactly, per database**, after restore into host03 Postgres — `isolav2` **8,153**,
   `ocmt` 294, `isolav2_staging` 181, `isola_shell_v2` 67, `bff` 14, `isola_shell` 12,
   `isola_staging` 0. A backup nobody has restored is a hypothesis; a restore is proven
   against the objects the next step needs, and the next step needs rows.
   **`isola_staging` is provably empty and still moves** — it is dropped later,
   deliberately, not skipped now.
3. **Secrets: SPLIT PROD AND STAGING AT THE MOMENT OF THE MOVE.** Swarm secrets, never a
   file baked into the image. Sweep item 9 exists because one `.env.shared` serves both
   environments in the portal trees, which makes a staging mistake a production
   credential exposure. **The split is cheapest now, because the new one is being created
   from scratch either way.** Do not wait for Infisical — that is deferred and this
   cannot be.
4. **`read_only: true` — attempt it.** Next writes a runtime cache; uploads and temp files
   may too. Mount those paths explicitly as writable rather than abandoning the property.
   **"read_only was not viable" is only acceptable accompanied by the list of paths that
   made it so.**

---

---

## KNOWN ACCEPTED LOSSES AT THE 3742 CUTOVER — recorded 2026-08-17

Enumerating bff-v2's inbound side effects (§d) established that **"it only replies"
was a hypothesis and it was wrong** — ten distinct effects fire on an inbound
WhatsApp message. Most are superseded by the new path. These are the ones that are
**not**, recorded here so they are learned from us now rather than from an empty
dashboard later.

### 1. PostHog activation analytics — **KNOWN ACCEPTED LOSS**

`fireAiRepliedAndActivated` (`app/api/whatsapp/webhook/route.ts` L901, L1139) stops
firing for 3742 at cutover. **No equivalent exists in the new path**
(Chatwoot → gateway → runtime → Paperclip).

- **Not customer-facing. Not a blocker. Accepted deliberately, 2026-08-17.**
- What is lost: the "AI replied / tenant activated" product-analytics signal for
  EPIC's own front door. Other numbers still on bff-v2 are unaffected.
- If this signal is later wanted, it is re-emitted from the gateway or the runtime,
  not by keeping bff-v2 in the path.

### 2. Paperclip conversation history splits at the cutover line — **NOT DATA LOSS**

`paperclipMirrorInbound` (L160, fire-and-forget, runs **before** dedup) currently
mirrors every inbound message into Paperclip company **`48f327a1` on the deepseek
instance**. After cutover, `isolart_runtime` writes issues and cost-events to
**`3ed3869b` on host03**.

- **THE MOVE IS THE GOAL** — `3ed3869b` is the authoritative instance. Work tracking
  does not stop; it lands where it should.
- **THE SPLIT IS THE COST.** Conversations before the flip live on deepseek; after,
  on host03. **Nothing is deleted and the legacy instance stays readable.**
- **DO NOT READ THE GAP AS DATA LOSS**, and do not "fix" it by editing an agent's
  `paperclipCompanyId` ahead of the cutover: `paperclipMirrorInbound` returns early
  on an empty company id and 404s on a company that does not exist on the target,
  so a well-meant field edit silently stops the mirror. **Let the cutover move it.**
- Joined by step 6 of the sequence (agents migrate off `paperclip.epic.dm`).

### Still `[U]`, carried not chased
`reconcileInboundAttribution` (L1067) and `appendUserMessage` (L881–882) —
continuity across the cutover unverified.

---

## HARD PRECONDITIONS ON THE SERVICE — for ESTATE, alongside `replicas: 1`

These are properties of the service, not deployment notes. Written here so they cannot be
lost between the definition and the stack.

```yaml
# PRECONDITION 1 — ami-listener CANNOT START on a host that is not permitted BY BOTH:
#   (a) voice00 iptables : ACCEPT tcp/5038 from that host
#   (b) voice00 manager.conf [epic-ai-app] : permit = that host
# Only 66.118.37.12 (deepseek) satisfies both today. Starting it on host03 before both
# are changed fails closed, on a live PBX, mid-cutover.
#
# PRECONDITION 2 — AFTER THE DNS CHANGE, EVERY LONG-LIVED CALLER IS RESTARTED.
# DNS migrates NAMES. It does not migrate established connections or cached
# resolutions. A process that resolved bff.epic.dm once at startup and holds it in a
# keep-alive pool is INDISTINGUISHABLE FROM A HARDCODED IP at the moment the name moves —
# it keeps calling deepseek until restarted. Known long-lived callers:
#   isolaruntime-backend-1 (docker, deepseek)   lk-voice-agent (pm2, deepseek)
# PROOF IS TRAFFIC ARRIVING AT host03 FROM THAT CALLER — not the absence of errors.
# Errors stay absent while it happily talks to the old machine.
```

---

## CUTOVER CHECKLIST ITEMS WITH A FRESHNESS REQUIREMENT

**Clean has a shelf life.** A finding recorded as "we checked" is read six weeks later as
"it is fine", and nobody remembers which day it was true.

- [ ] **Re-run the caller enumeration INSIDE the cutover window.** Date the result. A new
      caller can be added at any time, and the whole conclusion rests on every consumer
      using a hostname.
- [ ] Re-confirm `git -C /opt/bff-v2 rev-parse HEAD` before anything is built from it.
- [ ] Confirm voice00 iptables + `manager.conf` both permit host03 **before** starting
      `ami-listener` there.
- [ ] After DNS: restart long-lived callers, then prove host03 receives their traffic.

---

## SEQUENCE (owner's order, restated for execution)

1. 6737 probe on host03 — needs nothing from this migration.
2. This inventory (VOICE) ‖ landing prep (ESTATE).
3. Stand bff-v2 on host03 **with schedulers disabled**. Parallel run.
4. Prove it. Cut over DNS (`bff.epic.dm`, `voice.isola.epic.dm`) and repoint
   `lk-voice-agent`. Enable schedulers **only here**.
5. `9b9edc7` ships in that deploy — on host03, once.
6. Agents migrate off `paperclip.epic.dm`; instance retires.
7. `inbox.epic.dm` retires.

**asptt stays. Nothing is deleted before its replacement is proven.**
