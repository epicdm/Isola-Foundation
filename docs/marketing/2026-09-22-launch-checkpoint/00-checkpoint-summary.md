# EPIC Marketing Checkpoint — 2026-09-22

Session: ISOLA / EPIC Marketing Owner (independent lane, this initialization).
Supersedes the prior checkpoint referenced as "plan v8.08, 2026-09-22 09:56 UTC, still holding public
callback promotion." That checkpoint is now stale — see Finding 1.

## 1. Current offer, as ratified (product truth, not yet public truth)

Decision `dec-call-dominica-for-free-universal-whatsapp-signup-magnus-first-2026-09-21` (RATIFIED,
owner, 2026-09-21T23:41Z):

- Proposition: **"Call Dominica for free"** — the universal introduction to EPIC, not a hotspot-only feature.
- Leg A (caller): the customer's own WhatsApp-verified number, in **Dominica, USA, or Canada**.
- Leg B (destination): **Dominica** only.
- Identity first: signup provisions a real Magnus account (own DID + SIP) before any callback — no callback-only half-account.
- Trial allowance as ratified: **up to 2 calls, 15 minutes total, 10 minutes max per call, within 7 days.**
  **Correction, Lane A, 2026-09-22 later same day:** the ratified decision text says "2 calls," but the
  **public/universal door's actual code enforces only a time budget** — 900s (15 min) allowance, 600s
  (10 min) per-call cap, 7 days — with **no enforced count of calls**. "Two calls" there is arithmetic
  (900÷600=1.5), not a system guarantee. The **separate hotspot/EPICNET door DOES enforce a real count of
  2**. Any public-facing copy for the universal door must describe a minutes budget, never "2 calls" —
  that phrasing belongs to the hotspot door only, and this campaign's content targets the public door.
- Rail: Magnus click-to-call only. The AMI/Asterisk free-callback rail is dead and stays fail-closed.
- Entry points: hotspot splash (becomes a `wa.me` deep link into 0001 with "call" prefilled), the
  `/free-call` campaign page (PR #207), and direct WhatsApp — all three lead to the same funnel.
- Unpaid accounts released after 30 days (dry-run, audited, never touches an account with any payment).
- Related, RATIFIED: WiFi proactive upsell runs through the 0001 concierge (`dec-wifi-proactive-upsell...`),
  gated on a persisted hotspot marker — hotspot vocabulary must never reach the public "Call Dominica for
  free" audience, and vice versa (two populations, never conflated).
- Related, still **OPEN** (not ratified): hotspot-as-member-benefit for a positive wallet balance
  (`dec-hotspot-member-benefit-positive-balance-free-wifi-2026-09-22`) — awaiting owner confirmation of the
  balance floor. Do not reference this in any public or hotspot creative yet.

## 2. FINDING 1 — None of this is live to a customer right now

Read directly from the freshest Port record (`isola-current-plan` v8.09, 2026-09-22T11:12:17Z, itself
citing fresh production evidence `ev-bffv2-prod-bb94d73-trial-stack-deployed-grants-paused-2026-09-22`
captured 10:34:34Z):

- The trial stack (PR204→208) **is merged and deployed** to production (BUILD_ID `hJdEJ90pSIC_b5d1l1waV`,
  live since 10:34:25Z). This is genuine backend progress.
- But runtime flags read back as: `CALLBACK_TRIAL_GRANTS_PAUSED=true`, `FREE_CALLBACK_ENABLED=false`,
  `EPICNET_FREE_CALL_DEST_PREFIXES=[]`. **No customer, on any entry point, can currently receive a trial
  callback or complete a free call.** This is deliberate fail-closed containment, not launch.
- The `/free-call` public campaign page has an open P2: it gets the same Clerk 307 redirect as a private
  route because it is missing from the public-route matcher — **and** its feature flag is off. The page is
  both broken and disabled.
- Portal PR #169 (the create/setup workflow in `isola-portal`) still fails its build on a
  `react-hook-form` manifest/lockfile mismatch — no fresh, working browser proof of the signup path exists.
- The WiFi member-benefit side is split: the WiFi lane's own plan/config is built, but the bff-v2 endpoint
  it depends on (`member-status`) returns 404 today — not built.
- Agno/AgentOS concierge pilot: not activated, zero customer turns, no credentials configured. The 0001
  concierge in production today is the existing deterministic engine, not an Agno agent — content must
  describe only what that deterministic engine actually does.

**Update, relayed by Lane A 2026-09-22T12:5xZ (verified against Port, see §7 below):** a further blocker
exists even once grants are unpaused — `def-trial-leg-a-us-canada-rated-025-on-plan-55-free-call-fails-for-diaspora-2026-09-22`:
Magnus plan 55 rates prefix `1` at $0.25/min against a $0 trial wallet, so a USA/Canada caller's own leg is
refused before dialling. This blocks the diaspora half of the ratified offer specifically and is an owner
decision (dedicated trial plan vs. funded wallet), not an engineering fix.

**Conclusion: every entry point to "Call Dominica for free" is currently non-functional for a real
customer.** Per this brief's own message-status rules, that makes the correct disposition for this specific
offer **UPCOMING**, not LIVE and not even CONTROLLED TEST (the one authorized test is the owner's own bounded
staging fixture, not a customer-facing test). No content package below promises a working callback, and none
carries a CTA into the broken `/free-call` page.

## 3. What IS independently established as live (usable for the core proposition)

Per this repo's own operating record (not re-verified live by this session — flagged in open questions):
- Personal Line launched as-is per the owner's 2026-09-04 ruling — the underlying calling app (Acrobits-based),
  a customer's own Dominica number, and use over WiFi/any carrier's data are the standing product, independent
  of the new trial funnel.
- WhatsApp number **3742** is documented as EPIC's sole public front door (protected, live product surface).
- WhatsApp number **0001** is the Personal Line Concierge, a live product surface (ratified
  `dec-concierge-number-0001-ratified-2026-08-28`), running the deployed bff-v2 lite-concierge engine.

Neither of these was re-verified end-to-end by this session (no customer contact is authorized). They are
used only as the basis for general-proposition messaging, not for any specific trial-offer claim. See open
question 1.

## 4. Meta capability findings (read-only inspection)

Only one Meta MCP server is available to this session: **Meta Social Technologies (DevTools) MCP** — Graph
API developer-platform inspection (app settings, webhooks, compliance, App Review, API usage). It is scoped
to two Meta *developer apps*, not to any Facebook Page, Instagram account, Ads Manager, or Business Manager:

- `EPIC_BFF` (app_id `1293246411364782`) — **live_mode**, category `MESSENGER_BOT`, contact
  `epiccommunicationsinc@gmail.com`, base domains `epic.dm`, `social.leads.epic.dm`, `isola.epic.dm`,
  `app.isola.epic.dm`, `staging.isola.epic.dm`, `isola-chat.saas00.epic.dm`. This is the production WhatsApp
  Business Platform app behind bff-v2 / Isola — a technical integration app, not a marketing publishing surface.
- `EPIC_BFF_test` (app_id `1691114308580807`) — **dev_mode**, unconfigured, registered under a personal
  gmail — a sandbox, not relevant to marketing.

**No tool in this session's toolset can:** discover a Facebook Page or Instagram Business account, read Ads
Manager/ad account data, create a paused ad draft, or publish/schedule an organic Facebook/Instagram post.
Those capabilities do not exist here regardless of what the initialization brief assumed. See open question 2.

## 5. Marketing disposition decided this checkpoint (revised after checking Port's existing `marketing_claim` register — see 07)

Port already runs a marketing-claim gate (`marketing_claim` blueprint + `capability.truth_status`). Found,
not duplicated. Two claims my first content draft leaned on ("no SIM required," "Wi-Fi/data, works abroad")
are still Draft/pending UAT there, not Approved — content was rewritten to stay inside the gate.

| Item | Disposition | Why |
|---|---|---|
| Core proposition ("Your Dominica number...") | LIVE-eligible, narrowed to Approved claim only, CTA held pending Q1 | Only `claim-call-home-dominica` is Approved/Verified-and-Sellable; `cap-lite-calling` is live but concierge-assisted onboarding only, not self-serve; mandatory voice-only disclosure now included |
| "Call Dominica for free" trial | UPCOMING — labelled preview, no CTA | Grants paused, destination page broken+flagged off, no working interest-capture path; new Draft claim `mc-call-dominica-for-free-trial-2026-09-22` recorded in Port to track it to Approved |
| Hotspot member benefit (free WiFi) | NO PUBLIC MENTION | Decision still Open; not ratified; bff-v2 side not built |
| Real product demo (screen recording) | BLOCKED — asset dependency | No verified screen capture of the live app or WhatsApp flow exists in this session; will not fabricate one |
| Educational/FAQ content | LIVE-eligible now, topic changed | Rewritten to describe only Approved claims + concierge-assisted onboarding; the original SIM/Wi-Fi topic is deferred until those claims clear UAT |

## 6a. A proposed destination did not survive verification — 2026-09-22 ~13:15Z

Lane A relayed LINE's finding that `https://isola-lumen-prod.saas00.epic.dm/en/personal-line-plan` is
"confirmed live in production, HTTP 200, public, no login" and asked which CTA (this page vs. WhatsApp) to
use. Checked it myself before accepting it, same as everything else in this checkpoint — it does **not**
hold up as an anonymous-public destination:

- The page shell does return HTTP 200 to a cookie-less request.
- But its actual content (pricing table, "what you get," "what this is not") is fed by
  `GET /api/isola/tenants/VoR2zo4/company/` and `GET /api/isola/portal-links/` on
  `isola-lumen-api-prod.saas00.epic.dm` — both returned **401 `not_authenticated`** when called with no
  credentials from the page's own origin.
- The page had rendered fully in this session's browser only because that Chrome profile already held a
  live operator `token`/`refresh_token` for this domain in localStorage — confirmed by the nav bar showing
  operator-only items (Control Room, Connect WhatsApp, Company Settings) alongside the "public" content.
  A genuinely anonymous visitor gets the shell and two 401s where the offer should be.
- `isola-lumen-prod.saas00.epic.dm` reads as the Lumen operator console's own host, not a standalone public
  site — the same failure shape as this repo's own recorded B6 finding (measuring the wrong host).

Did not modify the browser's auth state (no logout/token clearing) since it may not be this lane's session
to disrupt on a shared machine. Recorded as `evidence/ev-personal-line-plan-page-not-public-measured-2026-09-22`
and relayed back to Lane A/LINE for re-verification in a genuinely logged-out context. **No CTA in these
packages points at this URL.** Post 1/3 CTAs remain WhatsApp/0001, still gated on AGENT's verification pass
— that is now the only candidate destination with any standing, and it is not yet clear either.

## 6b. Device-evidence read from LINE, relayed by Lane A (not yet independently re-verified by this lane)

Per Lane A: background/locked-screen incoming ringing is unproven since 2026-08-24 across all device
claims. Of the three Draft claims, `mc-personal-line-no-sim-second-number-2026-09-02` is closest — LINE's
read is that it's "effectively proven on one device already" and "one test on the second platform" would
close it; `mc-personal-line-data-wifi-2026-08-30` has proven outbound but needs locked/background inbound
plus a second platform; `mc-personal-line-works-abroad-same-plan-2026-09-02` needs resume/caller-ID/no-rate-change
checks, foldable into whichever locked-inbound session runs. Noted for queue reordering (see 04) but taken
as a relay, not verified firsthand — this lane has no device-testing capability of its own.

## 6d. Owner ruling on framing, 2026-09-22 (afternoon, relayed by Lane A) — applied to Package 02

Two direct owner rulings: (1) **"no app needed" is now the lead headline** for the free trial callback —
the first customer experience is meant to be a WhatsApp callback, not an app install; this is a different
product from Package 1/3's genuinely app-based concierge onboarding, so no conflict, just two correctly
separated claims. (2) **Minutes budget, never a call count**, confirming the correction already made in
§6c/§2 above — kept exactly, including the hotspot-door contrast.

**Unchanged: still nothing to publish.** Five gates are closed in sequence and none is being flipped until
Lane A says so: a trial-specific entry path must be built first (nothing today recognizes "I'm here for the
free trial" anywhere in the conversation), then USA/Canada admission opens, then trial grants unpause, then
the page/flag turns on. Content preparation is authorized; publishing or scheduling against the campaign
destination is not, regardless of how finished the creative is.

Also confirmed by owner: this session **may commit content packages to `docs/marketing/` in
`epicdm/Isola-Foundation`** — on a branch, via PR, from its own worktree, not the shared checkout. **Held
for now** — this reverses my own explicit instruction from this session's user to leave engineering files
and Git state untouched, and a peer's relay of an owner decision isn't the same as that confirmation
reaching me directly. Raised to the user in this session before acting. See open questions.

## 6c. Two more claims-register corrections, Lane A, 2026-09-22 (later same day)

1. **"2 calls" is not an enforced promise on the public door** — see the correction inline in §2 above.
2. **Do not build any package headline on "no app needed for the callback."** It's technically accurate
   about the callback step itself, but the trial grant can only be issued after full provisioning
   (including the Magnus side) — a customer only reaches the no-app callback after already passing through
   a flow that requires app-capable account creation. Sequence problem, not a false claim. Worse: a
   separate P1 (filed by Lane A against engineering, not against this lane's copy) found that a campaign
   visitor's prefill text isn't recognized by intent routing today, so they fall through to the generic
   onboarding script — which is explicitly instructed never to describe the app as optional. So today the
   first reply a campaign visitor would actually get contradicts a "no app needed" headline outright.
   **Checked this checkpoint's own drafts — none use "no app needed" or similar phrasing. Nothing to hold.**
   Do not introduce it before the owner rules on how to frame it (the fix could be copy or routing, and
   those produce different headlines).

**Solid, confirmed usable:** reaching a human is real and testable — the words human, agent,
representative, support person, real person and "talk to someone" are keyword-matched in code, not model-
interpreted. Any post promising a customer can ask for a person is a promise that actually holds.

## 6. Lane A coordination — 2026-09-22, ~12:5xZ

Lane A (`agno-refine-bff-host03-cutover`, release/config coordinator) reached this session directly once the
owner enabled peer-message transport for it, and separately wrote its handoff into
`mc-call-dominica-for-free-trial-2026-09-22`'s `commercial_condition` (verified by re-reading the entity —
matches word for word). Two new evidence entities it captured were also read and verified directly, not
taken on trust: `ev-meta-publishing-and-ads-access-measured-2026-09-22` (no engineering lane holds any
Page/ad-account/business access — publication has to run through the owner's own connector or a
deliberately granted Page token) and `ev-whatsapp-brain-topology-measured-2026-09-22` (0001 and 3742 are
different brains; this campaign's copy now deliberately targets 0001 only). Owner rulings relayed and
applied: "no strings" removed from the trial claim; the older `mc-personal-line-real-767-number-15-free-minutes-2026-08-30`
claim is a different product and must be reconciled by its own owning team, not conflated here; the voice-only
disclosure stays visible in every ad; a preview must say "upcoming" on its face.

**Held, not actioned:** Lane A asked me to commit these packages to `docs/marketing/` in
`epicdm/Isola-Foundation` so they're a shared deliverable rather than local files. My direct instruction
this session was to leave engineering files and Git state untouched and keep marketing output in a separate
working directory — committing to the shared engineering repo is a real, visible, hard-to-reverse action I
was not authorized to take unilaterally, and it's the kind of thing this repo's own operating rules ask to
be confirmed before doing. Surfaced to the owner in this turn's reply rather than actioned.

PORT: read `isola-current-plan` (v8.09), `execution_packet/xp-personal-line-operator-customer-management-slice2-2026-09-20`,
4 decisions (`dec-call-dominica-for-free-universal-whatsapp-signup-magnus-first-2026-09-21`,
`dec-wifi-splash-free-call-door-ratified-2026-09-21`,
`dec-wifi-proactive-upsell-and-concierge-pass-sales-option-b-in-place-2026-09-21`,
`dec-hotspot-member-benefit-positive-balance-free-wifi-2026-09-22`), `marketing_claim` blueprint + all 17
existing entities, `capability` entities matching "call", `mc-call-dominica-for-free-trial-2026-09-22`
(re-read after Lane A's edit), both new evidence entities (`ev-meta-publishing-and-ads-access-measured-2026-09-22`,
`ev-whatsapp-brain-topology-measured-2026-09-22`) · wrote `marketing_claim/mc-call-dominica-for-free-trial-2026-09-22`
(Draft, new entity — no existing claim's status was changed by this session).
