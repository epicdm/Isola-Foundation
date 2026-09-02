# Acrobits owner checklist — A-6 first

**Governing packet:** `xp-personal-line-cohort`
**Date:** 2026-08-12
**Status:** navigation steps and evidence requirements only. **No Acrobits configuration
has been entered, viewed or changed**, and none may be until the owner completes A-6.

> **Rules for every item below.**
> - **No secret screenshots.** Never capture an APNs key, FCM key, certificate, password,
>   API token or provisioning secret. Capture the *presence, name, and expiry* of a
>   credential — never its value.
> - **Read-only.** Do not click Save on any screen while gathering this, including
>   screens that appear unchanged. Some consoles persist on view.
> - **Record "not present" explicitly.** An absent field is an answer. A blank in this
>   checklist is not.
> - Access is `cloudsoftphone.com` with the **account-owner** login. Port
>   `r01-acrobits-evidence` records that this console is visible only to the account
>   owner, which is why no engineering lane can do this.

---

## A-6 — `InitialProvisioningUrl` (DO THIS FIRST)

**Why first:** it is the single dependency that decides whether the secure activation
design is a small delta or a redesign. Every other unknown affects cost, scope or
acceptance; this one affects whether the fix is buildable at all. Until it is answered,
new activation stays unavailable and the two registered devices cannot be rotated.

### Navigation

1. Sign in at `https://cloudsoftphone.com` as the **account owner**.
2. Open the account/provider for Cloud ID **`EPIC.VOICE.LITE`**.
3. Look for the provisioning configuration — typically under
   *Account → Provisioning*, *Settings → Provisioning*, or the app/bundle's own
   configuration page. Naming varies by tier, so check all three.

### Answer these seven, exactly

| # | Question | Evidence to capture |
|---|---|---|
| A-6.1 | Is there a configurable **provisioning URL** field at all? (`InitialProvisioningUrl`, "Provisioning URL", "Account provisioning", or similar) | The field's **exact label** and where it sits in the menu tree. Screenshot of the *setting page* with any value field blanked or cropped out |
| A-6.2 | Is it **currently set**? | Yes/No. If yes, the **hostname only** — not the full URL, not any token in it |
| A-6.3 | What **scheme/format** does Acrobits expect? | Quote the console's own help text or docs link verbatim. Specifically: does it fetch XML, JSON, or a proprietary format? Does it substitute variables into the URL, and if so which |
| A-6.4 | What **authentication** does the fetch support? | Whether Acrobits can send a header, a query parameter, basic auth, a client certificate, or nothing. **This decides how our one-time code travels** |
| A-6.5 | Is there a **test or sandbox** capability? | Whether a provisioning URL can be tested against a non-production account, a test Cloud ID, or a preview device without affecting live users |
| A-6.6 | Does changing it **affect the existing application**? | Whether the setting is per-account, per-bundle or per-app; whether it applies to already-installed apps on next launch or only to new installs; whether any live user re-provisions automatically |
| A-6.7 | What is the **rollback**? | Whether the prior value can be restored, whether an empty value is permitted, and what already-installed apps do if the URL becomes unreachable |

### The decision this produces

- **Configurable + supports an authenticated fetch (A-6.1 yes, A-6.4 non-empty)** →
  the secure design in `ACROBITS-PROVISIONING-AND-SECURITY-DESIGN.md` §3 proceeds broadly
  as written. Estimated 4 engineering days.
- **Configurable but unauthenticated fetch only** → the one-time code must carry all
  authority in the URL path, with single-use consumption doing the work
  authentication would have. Buildable, tighter, needs a threat re-review.
- **Not configurable on this tier** → the design changes materially. Options become a
  tier upgrade, a branded app build, or an operator-assisted provisioning model.
  **This is the outcome that must be known before any pilot date is set.**

> **Do not change the setting while answering.** A-6 is a read. If A-6.6 shows live users
> re-provision on change, an exploratory edit could strand the two registered devices —
> the exact outcome the rotation plan is sequenced to avoid.

---

## A-1 — Account tier, contract, renewal

*Navigation:* Account → Billing / Subscription / Plan.

| Capture | Note |
|---|---|
| Plan or tier name | |
| Contract term and renewal date | |
| Notice period to cancel or downgrade | |
| Whether the account is in trial, standard or legacy status | Legacy plans often carry features newer tiers charge for — worth knowing before any upgrade |

## A-2 — Bundle identity and enabled features

*Navigation:* Applications / Bundles → the entry for `EPIC.VOICE.LITE`.

| Capture | Note |
|---|---|
| Bundle identifier and display name | |
| Full list of enabled features, as shown | Screenshot of the feature list is fine — it contains no secrets |
| Which features are add-ons vs. included | |
| Whether `EPIC.VOICE.LITE` is a **generic Cloud Softphone Cloud ID or a white-label app** | This answers A-4 as a side effect. Our code links to the *generic* store apps (`id567475545`, `cz.acrobits.softphone.cloudphone`), which suggests generic — confirm |

## A-3 — iOS / Android availability

*Navigation:* Applications → the bundle → platform/store status.

| Capture |
|---|
| Whether a branded build exists for iOS, Android, both or neither |
| Store listing status (draft, in review, published, removed) |
| Store URLs if published |
| Minimum OS versions |

## A-4 — Branding status

Largely answered by A-2. Additionally capture: whether branding assets are uploaded,
whether a build has ever been produced, and what the console says is required to produce
one.

## A-5 — Push configuration

*Navigation:* the bundle → Push / Notifications / Certificates.

| Capture | **Never capture** |
|---|---|
| Whether push is configured for iOS (APNs) and Android (FCM) | The `.p8` / `.p12` key or certificate file |
| Credential **type** (APNs key vs. certificate; FCM legacy key vs. HTTP v1 service account) | The key ID, team ID, or any token value |
| **Expiry date** of any certificate | The private key |
| Which bundle identifier the push credential is bound to | |
| Whether push is included in the plan or metered | |

> Acceptance proof #23 (inbound call wakes a backgrounded device) is **BLOCKED**, not
> failed, until A-5 shows push is configured. An expired APNs certificate is a common and
> silent cause of "the app only rings when open" — check the expiry even if it shows as
> configured.

## A-7 — Custom tabs / web views

*Navigation:* the bundle → Tabs / UI / Web views.

| Capture |
|---|
| Whether custom web tabs are supported on this tier |
| Maximum number of tabs |
| **Exactly which variables Acrobits substitutes into a tab URL** and their placeholder syntax |
| Whether tab URLs are stored in app config, and whether they appear in any log or diagnostic export |
| Whether a tab can be added without a new app build |

> The last two matter directly: the session-exchange design in
> `ISOLA-PERSONAL-FOUNDATION-CONSUMER-REALM-TRANSITION.md` §3 assumes a tab URL is
> persisted and may be logged, which is why it carries a single-use ticket and not a
> durable token. Confirm that assumption rather than inherit it.

## A-8 — Licensing and per-user charge

*Navigation:* Account → Billing / Usage.

| Capture | Note |
|---|---|
| **Per-active-user monthly charge** | The number that decides unit economics |
| **How "active" is defined and counted** | Registered device? Provisioned account? Any month with a call? These differ by an order of magnitude for a pilot cohort |
| Minimum seats or minimum monthly spend | |
| Current billed seat count and current invoice total | Compare against our 15-account inventory — a mismatch is itself a finding |
| Overage behaviour mid-month | |
| Whether branded-app build/maintenance fees are separate | |

> **No Personal Line price can be set until A-8 returns.** `personal-line-01-product-truth`
> requires reconciling a price conflict; the per-user endpoint cost is an input to that,
> not a detail of it.

---

## Returning the results

Record answers directly against these item numbers and attach to Port
`xp-personal-line-cohort` as evidence. Screenshots of *settings pages* are welcome;
screenshots showing *any credential value* are not — crop or blank them.

If any item cannot be answered because the console does not expose it, record
**"not exposed in console"** rather than leaving it blank, and note whether Acrobits
support would need to be asked. Several of these (A-6.3, A-6.4, A-6.5) may require an
Acrobits support ticket rather than a console read — that is a normal outcome and worth
knowing early, because it adds calendar time.
