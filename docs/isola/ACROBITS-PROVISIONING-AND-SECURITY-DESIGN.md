# Acrobits provisioning and security design

**Governing packet:** `xp-personal-line-cohort` (Port). Build tasks `personal-line-01-product-truth` · `-02-epic-assistant` · `-03-controlled-cohort` · `-04-wallet-ai-upgrade`. No competing execution packet exists or will be created.


**Status:** DISCOVERY OUTPUT + REMEDIATION DESIGN. Not implemented.
**Date:** 2026-08-12
**Scope:** how an Isola Personal member's SIP endpoint is configured, and how the SIP
secret is kept out of every surface a human or a log can read.

---

## 0. Headline

Two activation mechanisms exist in the estate. **The secure one is written and unused.
The insecure one is what ships.** Both put the same Magnus SIP secret behind them; they
differ entirely in who can read it.

| | Secure path (present, unused) | Shipping path |
|---|---|---|
| Scheme | `cloudsip:?_cmd=<https XML url>` | `csc:<user>:<pass>@EPIC.VOICE.LITE` |
| Secret in URL | **No** | **Yes** |
| One-time | Yes — `xmlFetched` flag, `consumeForXml()` | **No** |
| Possession proof | WhatsApp OTP to the line's own number | **Removed** ("OTP gate REMOVED (pivot)") |
| Where implemented | `bff-v2 app/lib/lite-activation.ts` (`cloudsipUri`, `consumeForXml`) | `getActivationCsc()` → `bff-v2 app/go/[code]/route.ts`; and independently in Foundation |

The brief's steps 5–7 — *"Acrobits calls the controlled InitialProvisioningUrl … the
backend resolves the authorized Voice seat and returns SIP configuration"* — describe
the **secure path exactly**. The work is to finish and adopt it, not to invent it.

---

## 1. Findings — credential exposure

### F-1 · P0 · Foundation returns and renders the SIP password

`artifacts/isola/app/api/consumer/voice/line/route.ts`

```ts
return NextResponse.json({
  ...
  sip_username: voiceLine.magnus_sip_username,
  sip_password: voiceLine.magnus_sip_password,   // ← plaintext, to the browser
  ...
});
```

`artifacts/isola/app/consumer/(app)/softphone/page.tsx` then, in the same page:

- renders it as visible text — `<InfoRow label="SIP password" value={line?.sip_password} />`;
- builds `csc:${sip_username}:${sip_password}@EPIC.VOICE.LITE` and sets it as an `href`;
- encodes that same string into a **QR image** via `QRCode.toDataURL`.

Consequences: the secret is in the JSON response body, in the DOM, in the rendered
page, in any browser/proxy/CDN log that captures response bodies, in a screenshot, and
in a QR code that anyone in the room can photograph. It is retrievable at any time by
anyone holding the session — there is no one-time property at all.

This directly contradicts the acceptance requirement *"logs and browser surfaces contain
no credentials"* and product requirement 7.

### F-2 · P0 · bff-v2 `/go/{code}` renders the secret on an unauthenticated public page

`app/lib/lite-activation.ts`:

```ts
export async function getActivationCsc(nonce) {
  ...
  return { csc: `csc:${la.sipUsername}:${la.sipPassword}@${CSC_CLOUD_ID}`, did: m.did }
}
```

`app/go/[code]/route.ts` puts that string straight into an `<a href="…">` in an HTML
page served with **no authentication**. The route's own header comment records the
regression honestly: *"OTP gate REMOVED (pivot): the WhatsApp conversation already
authenticates the number."*

Three separate weaknesses compound:

1. **No one-time consumption.** `getActivationCsc` never sets `xmlFetched`. That flag is
   only set by `consumeForXml()`, on the *other* path. Within the 30-minute nonce TTL the
   link is replayable an unlimited number of times, by anyone who obtains it.
2. **No possession proof.** The OTP that proved the requester held the line's own phone
   was removed. A forwarded WhatsApp message is now sufficient.
3. **Stale safety claim.** `app/api/lite/softphone-activation/route.ts` still documents
   *"The SIP password never appears in any URL — see lite-activation.ts for the design."*
   That statement was true of `cloudsipUri`; it is false of `getActivationCsc`. A future
   reader will trust it.

### F-3 · P1 · No credential rotation on re-activation or suspected exposure

Nothing rotates the Magnus SIP secret. `enforceSipSecret()` exists in
`artifacts/isola/lib/magnus-voice.ts` and is the primitive needed, but no caller rotates
on re-issue, on suspension, or on a reinstall. A credential that has been exposed once
stays valid for the life of the line.

### F-4 · P2 · Operator/agent leg cannot recover credentials at all

Port `bt-voice-provision-sippass-gap` (Ready, P1): the *tenant/agent* provisioning route
writes `didSipUser` and `didSipServer` but never `didSipPass`. That is the opposite
failure to F-1 — the consumer leg over-exposes, the agent leg loses the secret entirely.
Both are symptoms of the same missing thing: **a single, governed credential broker.**

---

## 2. Findings — the Acrobits substrate

| Fact | Source | Confidence |
|---|---|---|
| Cloud ID `EPIC.VOICE.LITE` maps to `voice.epic.dm` | Port `bt-acrobits-readiness-probe`, Eric-confirmed 2026-07-03 | High |
| `voice.epic.dm` = `voice00.epic.dm` = `157.245.83.64`, same A record | dig, recorded in the same task | High |
| Asterisk listens 5060 UDP/TCP and 5061 TCP on that host | `ss -tlnp/-ulnp`, 2026-07-02 | High |
| No SRV records for `_sip._udp/_tcp/_sips._tcp voice00.epic.dm`; the `csc:` path consumes no DNS/SRV, so absence is not a blocker | same | High |
| Manual (non-`csc:`) setup requires explicit `voice00.epic.dm:5060 UDP` | same | High |
| The app referenced everywhere is the **generic** Cloud Softphone (`id567475545`, `cz.acrobits.softphone.cloudphone`) — **not a branded Isola app** | `lite-activation.ts`, `softphone-activation/route.ts`, Foundation softphone page | High |
| A white-label Acrobits app is a **fast-follow, never built** | Port `bt-acrobits-softphone-light-isola` | High |
| The 2026-06-17 proven call slice used **Groundwire**, not Cloud Softphone | Port `bt-acrobits-softphone-light-isola` | High |
| Cloud Softphone `csc:` **registration is unconfirmed** — the closing device test is recorded as never run | Port `bt-acrobits-readiness-probe` "REMAINING UNKNOWN (2)"; `bt-acrobits-softphone-registration-retest` (Backlog) | High |

### Not inspectable from this lane — owner or Acrobits required

The Acrobits Cloud Softphone provisioning portal is visible **only to the account
owner** (recorded in Port `r01-acrobits-evidence`). This lane holds no Acrobits
credential, and none is present in the repositories. The following are therefore
**UNKNOWN**, and every one of them is on the critical path:

| # | Unknown | Blocks |
|---|---|---|
| A-1 | Cloud Softphone account tier, contract and renewal | Commercial readiness |
| A-2 | Bundle identity and enabled feature set | Custom web tabs, push, provisioning |
| A-3 | iOS/Android availability and store status of any branded build | Pilot distribution |
| A-4 | Branding status (is `EPIC.VOICE.LITE` a generic Cloud ID or a white-label app?) | D-4 in the product contract |
| A-5 | **Push configuration** — APNs cert/key, FCM key, expiry | Acceptance #7 (background call) |
| A-6 | **Provisioning configuration** — whether `InitialProvisioningUrl` is set, and to what | The entire secure activation design |
| A-7 | Custom tabs / web-view capability and URL-variable substitution rules | The Assistant/Balance/Account tabs |
| A-8 | Licensing model and **per-user charge** | Unit economics; cohort size |

> **A-6 is the single most valuable unknown.** If `InitialProvisioningUrl` is
> configurable on this account, the secure design below is a small delta. If it is not,
> the design changes materially and the estimate moves.

---

## 3. Target design

### 3.1 Principle

> The SIP secret exists in exactly two places: MagnusBilling, and one server-side
> credential broker. It is emitted exactly once, to Acrobits, over TLS, in response to a
> single-use token, and never to a browser.

### 3.2 Flow

```
  Portal / app                 Isola backend                Acrobits            Magnus
       │                             │                          │                  │
  1.   ├── POST /activation ────────►│                          │                  │
       │   (session + entitlement)   │                          │                  │
       │                             ├── resolve Voice seat ───────────────────────►│
       │                             │◄── seat, sip user ───────────────────────────┤
       │                             │  mint one-use code, TTL 15 min               │
  2.   │◄── https://go.epiccomm.dm/s/{opaque-code} ─┤          │                  │
       │                             │                          │                  │
  3.   ├── GET /s/{code} ───────────►│  validate: exists, unexpired, unconsumed     │
       │◄── branded page ────────────┤  (page contains NO credential)               │
       │                             │                          │                  │
  4.   ├── tap ─────────────────────────────────────────────────►│ (csc handoff,   │
       │        visible fallback: "Open Cloud Softphone" + manual instructions)     │
       │                             │                          │                  │
  5.   │                             │◄── GET InitialProvisioningUrl?k={code} ──────┤
  6.   │                             ├── verify seat + consume code                 │
       │                             ├── retrieve/rotate secret ───────────────────►│
  7.   │                             ├── SIP config XML ───────►│                  │
       │                             │   (single use; code now dead)                │
```

### 3.3 Rules

1. **`{opaque-code}` is not the credential and not derived from it.** ≥128 bits of
   `crypto.randomBytes`. Stored hashed. The existing nonce (`randomBytes(16)` hex,
   validated `/^[a-f0-9]{16,64}$/`) is adequate entropy; what is missing is the
   consumption and hashing.
2. **One-time is enforced at the credential emission, not at the page.** The branded page
   may be opened repeatedly — it holds nothing. The XML fetch consumes. This is exactly
   what `consumeForXml()` already does; adopt it.
3. **TTL 15 minutes**, shorter than today's 30.
4. **Possession proof is restored** for out-of-band delivery (WhatsApp/SMS link). For an
   in-session activation from an authenticated consumer session, the session *is* the
   proof and a second OTP is friction without benefit. Two entry points, two rules,
   both stated.
5. **Rotate on every emission.** `enforceSipSecret()` sets a fresh Magnus secret at
   step 6. A reinstall therefore invalidates the previous device — which is the correct
   behaviour, and is what makes "reinstall recovery" a governed operation rather than a
   credential re-read.
6. **The response is `Cache-Control: no-store`, and the secret is never logged.** Add an
   explicit redaction assertion to the test suite; do not rely on discipline.
7. **Fallback is visible, and credential-free.** If the `csc:` handoff does not fire, the
   page offers "resend" and a support path — **not** a manual credential display. Manual
   SIP entry, if it must exist at all, is an operator-assisted flow with its own audit
   trail, not a customer self-service screen.
8. **The branded host `go.epiccomm.dm` must be a distinct origin** from the app, with no
   session cookie scope over it (today's `consumer_sid` is `domain=.epic.dm`, which
   would cover `*.epic.dm` — `epiccomm.dm` is correctly outside that).

### 3.4 Remediation of the shipping surfaces

| Surface | Action |
|---|---|
| `GET /api/consumer/voice/line` | **Remove `sip_password` from the response.** Add `activation_state` instead. Breaking change to the softphone page — intentional. |
| `app/consumer/(app)/softphone/page.tsx` | Remove the InfoRow, the `csc:` href and the QR of the credential. Replace with "Set up calling" → mints an activation code → branded page. Second-device setup mints a second code; it does not re-render a secret. |
| `bff-v2 getActivationCsc()` | Retire in favour of `cloudsipUri()` + `consumeForXml()`, **or** make it consume and set `xmlFetched`, and stop rendering it into HTML. Retiring is preferred. |
| `bff-v2 app/go/[code]/route.ts` | Stop emitting the credential into the page. Campaign-link branch is unaffected. |
| `softphone-activation/route.ts` header comment | Correct or delete the false safety claim. |
| Everything above | Add a test that greps the rendered response and the log stream for the secret and fails if found. |

### 3.5 What this does not change

Magnus remains authoritative. `magnus-voice.ts` (28 operations: `createMagnusUser`,
`createSipAccount`, `enforceSipSecret`, `drawAvailableDid`, `claimDid`,
`createDidDestinationToSip`, `setDidDestinationRoute`, `createCallerId`,
`patchUserPrefixLocal`, …) is the right client and needs no redesign for this work. The
delta is a broker in front of it and the removal of three read paths.

---

## 4. Residual risk the design does not close

- **The Magnus admin credential is cross-account capable.** `bt-magnus-tenant-isolation-mitigation`
  (Ready) and `bt-magnus-assert-ownership-slice` (In Progress) exist for this. The
  ownership-assertion slice is written — `feat/magnus-assert-ownership` @ `29d9490e`,
  15 tests, PM-reviewed APPROVE-WITH-NITS — and has **never been pushed, merged or
  deployed**. Two-user isolation acceptance depends on it landing.
- **`callerid/save` has no ownership check** — cross-account reassignment succeeds
  silently at the Magnus API. The Isola app layer is the only real boundary.
- **No suspension model** anywhere; see the gap matrix.
