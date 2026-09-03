# Personal Line — live topology and flow reference

**Status:** living reference. No date suffix on purpose — this file is meant to be
*corrected*, not superseded by a dated successor.

**Why this exists.** On 2026-09-02 roughly two hours went into answering one question —
*"why do I still see the old UI?"* — and the answer was not a bug. It was topology
knowledge that lived nowhere: the customer app and the thing that decides which app a
customer opens are on **two different hosts**, and the setting that binds them
**deliberately ignores `.env`**. Port holds decisions, CLAUDE.md holds laws; neither holds
a map. This is the map.

**How to read it.** Every claim below is tagged `[measured YYYY-MM-DD]` or `[assumed]`.
A map is not an oracle — CLAUDE.md §2.5 still applies: *repository code is not evidence of
deployed behaviour.* Before you act on anything here, re-measure it with the recipe in
§7. If a re-measurement disagrees with this file, **the file is wrong** — fix it in the
same change that discovered the drift.

---

## 1. The one thing to internalise

> **The brain is on deepseek. The face is on Vercel.**

| | Brain | Face |
|---|---|---|
| What | Concierge, provisioning, every `/api/lite/*` | The customer PWA (`isola-connect`) |
| Where | **deepseek** `66.118.37.12`, pm2 (`bff-v2-web`) | **Vercel**, project `isola-connect` |
| Domain | `bff.epic.dm` | `app.isola.epic.dm` |
| Repo | `epicdm/isolav2` (bff-v2) | `epicdm/isola-connect-3fb9b312` |
| Deploy | isolated worktree build → `pm2 restart` | git push → Vercel |

Nearly every confusing symptom in this product comes from conflating those two. You can
verify the Vercel side is perfectly correct and still be wrong about what customers see,
because the redirect that *chooses* the app is configured on deepseek. Check both, always,
and say which one you checked.

Voice (DIDs, SIP, rating, CDRs) is **Magnus**, and is never rebuilt in Isola.
Conversations are **Chatwoot**. See CLAUDE.md §1 for the full authority map.

---

## 2. End-to-end customer flow

### 2.1 Signup — entirely inside WhatsApp

Customer messages the concierge number `+1 767 818 0001`. `bff-v2`'s
`app/lib/lite-concierge.ts` runs the conversation state machine:

```
"hi" → welcome card → "Get my number" → confirm their number → provision
```

Conversation state is **not** in `lite_accounts`. It lives in `prisma.agentActivity`
(`type: 'lite_concierge_state'`, `summary: <phone>`), keyed by a deterministic hash of the
phone. `[measured 2026-09-01]` This is why deleting a `lite_accounts` row alone leaves the
concierge still treating the caller as a returning customer — see §5.4.

### 2.2 Provisioning — `provisionTenantLine()` in `app/lib/magnus.ts`

1. `mintFreeSipUsername()` → an **opaque** SIP username (`lt_xxxxxxxx`), deliberately
   never derived from the phone number.
2. Creates the Magnus user + SIP peer, draws a DID from the pool, wires DID routing.
3. Grants the welcome minutes.

**Why the opaque username matters:** because nothing about a line is derived from the
phone number, a re-signup can never collide with, or resurrect, a previous line's Magnus
user, SIP peer or wallet. `[measured 2026-09-01, by reading the implementation]` A
consequence worth knowing: old Magnus users left behind by a reset are inert, not
blocking. Three were orphaned during UAT on 2026-09-01 (1588 → 1589 → 1590) with no
effect on subsequent signups.

### 2.3 The "You're all set" message — two links, two different lifetimes

`composeNoAppActivatedMsg()` in `lite-concierge.ts` sends:

- **The PWA link** — `buildAppSigninLink(phone)` (`app/lib/wa-signin-token.ts`): a signed,
  **reusable, 30-day** bearer token. Safe to sit unread in a chat for weeks.
- **"Reply *app*"** — the softphone offer, which mints a **single-use** activation link
  only on demand.

Do not confuse them. The 30-day token can be pre-baked into a message; the single-use
activation link cannot, which is exactly why the message offers a keyword instead of a
link.

### 2.4 Sign-in handoff — see §3, this is the expensive one

### 2.5 Getting the calling app — the 3-step takeover

On the first PWA open on a device that is not yet activated, `OnboardingTakeover.tsx`
auto-fires ~600 ms after sign-in resolves (mounted from `AppShell.tsx`, triggered through
the small pub-sub store in `src/lib/onboarding-takeover.ts`):

1. What Cloud Softphone adds
2. Install links + **"I've installed it — auto-provision"** →
   `POST /api/lite/softphone-activation` → `mintActivationLinkForUser()` → a one-time
   `/go/<nonce>` URL → `window.open()` → the Acrobits `csc:` handoff configures the app
   with no manual SIP entry
3. Confirmed

Fires **once per device**, gated on `isSoftphoneActivatedOnDevice()` plus a one-time flag
(`src/lib/onboarding-flag.ts`). Both are `localStorage`, per-device, and honest about it —
there is no backend signal for "is this SIP endpoint actually registered."

This replaced a 7-step wizard at `/line`, which still exists in the tree but is fully
unlinked. `[measured 2026-09-02, PR #49]`

### 2.6 Calling

- **Callback** — works with no app: EPIC rings the customer's mobile, then bridges.
- **Direct dial** — needs the softphone: a `cloudsip:` URI hands off to Cloud Softphone.
- **Inbound** — the DID rings per routing: `app`, `app_then_cell`, or `cell`.

---

## 3. The sign-in redirect chain — write this one on your hand

This is the trace that keeps getting re-derived from scratch. It is four hops:

```
customer taps the WhatsApp link
  │
  ├─ 1.  bff.epic.dm/api/lite/wa-open?t=<30-day HMAC token>
  │        app/api/lite/wa-open/route.ts
  │        verifies the token, mints a ONE-TIME code (2-minute TTL)
  │
  ├─ 2.  const appBase = getSetting('ISOLA_SIGNIN_URL')
  │        ← THE HINGE. Everything below depends on this value.
  │
  ├─ 3.  302 → {appBase}/?wa_code=<code>
  │
  └─ 4.  PWA: AppShell.tsx → bootstrapCredsFromWaCode()
           POST /api/lite/wa-open/exchange  → real SIP creds
           stored in localStorage `isola.creds.v1`, signedIn = true
```

The one-time-code step exists because an earlier version put the **plaintext SIP password
in the redirect URL**. That was a P0, fixed 2026-08-31. Do not reintroduce a credential
into a URL.

### 3.1 How `ISOLA_SIGNIN_URL` actually resolves — `app/lib/runtime-settings.ts`

```
1. admin override in  /opt/bff-v2/data/runtime-settings.json
2. committed default in SETTING_DEFAULTS   ('https://test.epic.dm')
```

> ### ⚠️ `.env` IS NEVER CONSULTED.
> The file says so, in its own header, and gives the reason: env kept drifting on a shared
> box, so it was deliberately disconnected. `/opt/bff-v2/.env` contains
> `ISOLA_SIGNIN_URL=https://staging.isola.epic.dm` and **it means nothing.**
> `[measured 2026-09-02]` That line was mistaken for a root cause and cost real time. If
> you find yourself citing it, stop.

**To change it for real:** `setSetting()` via the admin API — it persists to the JSON store,
survives restarts, and writes an audit line. Editing `.env` does nothing. Changing the
committed default is a code change and therefore a PR.

**Live value `[measured 2026-09-03 03:2x UTC]`:** `https://app.isola.epic.dm`.
The move off `isola-connect.vercel.app` **has landed** — this file previously recorded it
as still pending, and was wrong. Verified in effect, not merely written:
`runtime-settings.json` mtime `2026-09-02 10:30:12 UTC` vs `bff-v2-web` start
`2026-09-03 03:25:43 UTC` (restart #73) — the process started *after* the write, so §5.2's
per-process cache holds the new value.

---

## 4. Domains

`epic.dm` DNS is hosted at **easyDNS** (`dns1/2/3.easydnssec.com/.net/.org`), *not* Vercel.
Records are added at easyDNS, and Vercel asks for `A → 76.76.21.21` for these subdomains
(not a CNAME, because the zone is external). `[measured 2026-09-02]`

| Subdomain | Serves | Notes |
|---|---|---|
| `app.isola.epic.dm` | **isola-connect** (the PWA) | Live, direct to Vercel `[measured 2026-09-02]` |
| `bff.epic.dm` | bff-v2 on deepseek | The brain |
| `isola.epic.dm` | project `isola` (old isola-mvp) | Points at retired Replit — stale |
| `try.isola.epic.dm` | isola-marketing | |
| `get.isola.epic.dm` | isola-launchpad | |
| `lite.isola.epic.dm` | isola-lite-landing | |
| `pay.isola.epic.dm` | alias on project `isola` | |
| `staging.isola.epic.dm` | **unidentified project** | Serves a live Next.js app; owner not identifiable via CLI or API `[measured 2026-09-02]` |

### 4.1 The vestigial proxy hop

Until 2026-09-02, `app.isola.epic.dm` resolved to **deepseek**, where an nginx vhost
reverse-proxied it to Vercel (`proxy_pass https://vercel_isola_connect`). The DNS change
removed that hop; traffic now goes to Vercel directly. The nginx vhost still exists at
`/etc/nginx/sites-enabled/app.isola.epic.dm` but no longer receives traffic. It is inert,
not harmful — but see §8 for the header it used to add.

---

## 5. Traps — each of these has already cost time

### 5.1 `.env` is inert for runtime settings
See §3.1. The single most expensive false lead in this system.

### 5.2 Settings cache is per-process and never reloads
`_cache` in `runtime-settings.ts` loads once. An override written *after* the last
`pm2 restart bff-v2-web` is **not live**. Always compare the JSON file's mtime against
pm2's `pm_uptime` before concluding a value is in effect. `[measured 2026-09-02]`

### 5.3 The activation allowlist keys on identity, never on phone
`activationEnabledFor(la.userId ?? la.sipUsername)` — it does an exact match against
`userId`/`sipUsername` and **never** looks at `ownerPhone`. A phone-keyed row in
`lite_activation_allowlist` is dead weight for this gate. Because every account reset mints
a fresh `userId`, **every reset needs a fresh allowlist entry.** This bit UAT three times in
one day. `[measured 2026-09-02]`

### 5.4 Resetting a test account: use the existing tool
`scripts/reset-consumer.ts <phone>` (inventory) / `--yes` (execute). It clears the
`lite_accounts` row, the synthetic user, opt-ins, conversations, messages, **and the
concierge state cache** (§2.1), and deprovisions the Magnus chain. It deliberately
preserves `WaSendAudit`. A hand-rolled `DELETE` misses the concierge cache and leaves the
number looking like a returning customer. `[measured 2026-09-01 — by making exactly that
mistake]`

### 5.5 `ISOLA_SIGNIN_URL` has a wide blast radius
One setting feeds all of these:

| Consumer | File |
|---|---|
| PWA sign-in redirect | `app/api/lite/wa-open/route.ts` |
| Shareable call links | `app/lib/call-link.ts` (`buildCallLink`) |
| **Top-up payment return URLs** | `app/api/lite/topup/route.ts` |
| Email sign-in links | `app/lib/mail/sender.ts` |
| Odoo user provisioning | `app/api/odoo/users/route.ts` |

Changing it moves **all** of them at once. The payment return URL is the one that deserves
care: if the provider validates or allowlists return domains, a change breaks payment
returns.

### 5.6 `isola-app.saas00.epic.dm` is NOT the customer PWA

There is an older Isola app served from host03/EasyPanel at `isola-app.saas00.epic.dm`. It
looks right — it answers 200, its `<title>` is *Isola*, and it serves a valid 402-byte
`/manifest.json`. **It is not what a customer opens.** The customer is redirected to
`ISOLA_SIGNIN_URL` (§3.1), which is `app.isola.epic.dm` on Vercel.

The two differ in ways that change conclusions: `saas00` serves the manifest at
`/manifest.json` while Vercel serves `/manifest.webmanifest` (860 bytes), and on `saas00`
**`/sw.js` is the SPA catch-all** — byte-length-identical (2901) to a deliberately bogus
route, so it is HTML, not a worker. On `app.isola.epic.dm` `/sw.js` is a real 781-byte
worker that registers, activates and controls scope `/`. `[measured 2026-09-03]`

This already cost a launch blocker: UAT finding **B6/D7** — *"no service worker, therefore
the PWA is not installable"* — was measured against `saas00` and carried into
`dec-launch-verdict-the-plumbing-landed-the-product-did-not-2026-08-30` as an ads-on
blocker. See `ev-b6-was-measured-on-the-wrong-host-live-pwa-does-have-a-service-worker-2026-09-02`.
**Always name the host you measured, and check it against §3.1 first.**

---

## 6. Deploy paths

| App | How |
|---|---|
| **bff-v2** | Never build in `/opt/bff-v2` (CLAUDE.md §4 — a build there once overwrote live `.next`). Build in an isolated `git worktree`, hardlink `node_modules` (`cp -al`, **not** a symlink — Turbopack rejects symlinked `node_modules`), verify the route manifest, `mv` the old `.next` aside, swap, `pm2 restart`. |
| **isola-connect** | Push to `main` → GitHub Actions fires a Vercel Deploy Hook → production in ~11 s. Before 2026-09-02 the Vercel GitHub App took **40 minutes**; the hook workflow (`.github/workflows/vercel-production.yml`, PR #51) fixed that. `[measured 2026-09-02]` |

A `bff-v2-staging` process exists on deepseek (port 3006). It has its own DB and WhatsApp
credentials but **shares Magnus with production** and has no Chatwoot wiring — so it is
good for code/API correctness and not for conversational or provisioning tests.

---

## 7. Verification recipes — measure, don't assume

**Which build is production actually serving?**
```bash
curl -s "https://app.isola.epic.dm/build-id.json?_=$(date +%s)"
# compare against: gh pr view <N> --repo epicdm/isola-connect-3fb9b312 \
#                    --json mergeCommit -q .mergeCommit.oid
```

**Is a runtime setting actually live?**
```bash
ssh deepseek "stat -c '%y' /opt/bff-v2/data/runtime-settings.json"
ssh deepseek "pm2 jlist"   # compare pm_uptime for bff-v2-web against that mtime
```

**Where does a WhatsApp sign-in link actually land?**
Read `getSetting('ISOLA_SIGNIN_URL')`'s resolution (§3.1). Do **not** read `.env`.

**Does a domain point where you think?**
```bash
nslookup app.isola.epic.dm 8.8.8.8
vercel domains inspect app.isola.epic.dm --scope epiccommunicationsinc-1396s-projects
```

**"The customer sees the old UI"** — check in this order:
1. `build-id.json` on the host they actually opened (not the one you assume)
2. `ISOLA_SIGNIN_URL` — which app does their link even open?
3. only then suspect client cache

---

## 8. Known-open

- **CSP / clickjacking `[measured 2026-09-02]`** — the retired nginx hop (§4.1) was adding
  `Content-Security-Policy: frame-ancestors 'self' https://isola.epic.dm
  https://*.isola.epic.dm https://*.vercel.app`. Vercel sets **no CSP and no
  `X-Frame-Options`** on `app.isola.epic.dm` or `isola-connect.vercel.app`, so the PWA is
  now framable by any origin — on a surface showing the customer's number, balance and call
  history. Fix is a `headers` entry in `vercel.json`; **not applied**, because it is a
  security change to a live customer surface and belongs in its own reviewed PR.
- ~~**`ISOLA_SIGNIN_URL` → `app.isola.epic.dm`**~~ — **DONE.** Landed by
  2026-09-02 10:30 UTC and confirmed live `[measured 2026-09-03]`; see §3.1. The payment
  return-URL question in §5.5 moved with it and has **not** been separately re-verified —
  if a top-up return breaks, that is the first place to look.
- **`staging.isola.epic.dm`** — held by an unidentified project that is serving a live
  Next.js app. Must be released from that project (dashboard) before it can be bound to
  `isola-connect`'s `staging` branch. The branch exists and is pushed.
- **Vercel preview deploys are `BLOCKED`** — a git-author/account-linkage setting. Branch
  and PR previews do not build, which is also what blocks staging.
- **Chatwoot mirroring 401s** on every concierge message.
- **WhatsApp Flow onboarding suppressed** — a `blocked_tenant_scope` gate makes every fresh
  signup fall through three fallback layers to plain text. It works, but not as designed.
- **"Request a call"** — parked by owner decision. Prior art exists: `app/lib/call-link.ts`
  + `POST /api/lite/call-link/connect` are live but WhatsApp-bot-only. The scoped feature
  (multi-link management, caps, expiry, in-app UI) is new backend work, and the design's
  assumed `/c/$token` route collides with the existing companion-login route.

---

## Related

- `CLAUDE.md` §1 (authority map), §4 (production topology, protected numbers), §5 (repo)
- `docs/isola/PLATFORM-CONSOLIDATION-MIGRATION-MATRIX.md` — deepseek nginx vhost inventory
- Port: `dec-CC-DISPATCH-personal-line-onboarding-loop-closed-2026-09-01`,
  `dec-CC-DISPATCH-vercel-deploy-hook-secret-and-merge-51-2026-09-02`
