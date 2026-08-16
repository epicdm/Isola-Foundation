# `cdr_anomaly` — a sentinel check, specified for estate to land

**Status: SPECIFIED, NOT BUILT. Voice lane hands this to estate lane.**

`services/isola-sentinel/` is estate's component and had **+211 uncommitted lines
mid-flight** on 2026-08-16. One writer per tree — so this is a specification and a
drop-in module, not an edit to that tree. Nothing here has been added to
`sentinel.js`.

## Why this check exists

It is the **compensating control for a deferred rotation.** Two SIP peer secrets
were exposed on 2026-08-16 and the owner ruled that all compromised secrets rotate
in one sweep before go-live rather than piecemeal. That ruling is sound — rotating
mid-build makes every later failure ambiguous. But **a deferred risk is only managed
if something is watching it**, and toll fraud is automated and fast. The CDR is
where it shows.

Both exposed peers have **zero calls, ever** (verified with a known-good account in
the same query as a positive control). This watch is what notices if that changes.

## Data source — Magnus REST, not the database

Reuse-first: `POST {MAGNUS_URL}/mbilling/index.php/call/read`, HMAC-SHA512 signed,
exactly as `artifacts/isola/engines/magnus.ts` does it. **No DB credential, no
tunnel, and no second way of reading the CDR that could disagree with the first.**

Measured 2026-08-16 against the live API:

| fact | value | why it matters |
|---|---|---|
| `total` field | **DOES NOT EXIST** | keys are `rows, count, sum`. A check written against `total` would never fire. |
| `count` | **the match total** | constant at 862,868 across `limit=1` and `limit=25` while `rows` tracked the limit |
| base URL | needs the **`/mbilling`** suffix | bare host fails |
| negative control | `calledstation = ZZZZNOSUCH` → `count=0, rows=0` | this is what makes a zero a real zero rather than a broken filter |

### The scoping trap — read this before setting any threshold

The **unfiltered** read returns **862,868**. Every *explicit* filter returns
**914,586** — including semantically different always-true ones (`starttime gt
1970-01-01`, `lt 2030-01-01`, `id gt 0`, `sessiontime gt -1`).

**Filters do not narrow an 862,868 universe; they REPLACE a default scope that the
grid applies only when no filter is passed.** 914,586 is the true universe; 862,868
is a defaulted subset (Δ 51,718) whose window is invisible to us and **drifts over
time**.

> **RULE: always pass an explicit filter. Never baseline on the unfiltered count.**
> An undefined baseline is a threshold wearing a number, and it would have poisoned
> this check silently and permanently.

## Credential — read-only BY CONSTRUCTION

The Magnus REST key is **money-moving**: the same API exposes `refill/save`,
verified live 2026-07-11 to apply a signed delta with **no floor-at-zero and no
rejection of negatives**. It adjusts customer balances. That is a larger capability
than a write-capable GitHub PAT, which only pushes reviewable, revertible code.

So the constraint is not tidiness — **it is the entire safety case**:

1. The credential comes from the **secret store**, never a file on a host.
2. The module below **has no code path that can emit `save` or `refill`.** Not a
   flag, not a convention, not a runtime check — **the capability does not exist in
   the module.** `magnusCount()` hardcodes `action: 'read'` and accepts only a
   filter array. There is no parameter through which a caller could reach another
   action.
3. It is on the sweep register as **C-09**, so it rotates with everything else.

**This key is an INTERIM with a short life.** The end state is an Asterisk AMI
read-only user (`read = cdr,call`, `write =` empty), which removes a money-moving
credential from a monitoring service entirely. See `F-01` in the register — the
per-user permission-class mechanism is already proven to work on that box.

## The three signals

All are **count-only** — no rows are pulled, so no customer phone number ever
enters the sentinel or an alert.

| key | question | filter |
|---|---|---|
| `cdr_volume_spike` | far more calls in the last hour than normal for this hour | `starttime gt <now-1h>` |
| `cdr_foreign_destination` | calls to destinations outside the normal set | `starttime gt <now-1h>` AND `calledstation` **not** starting `1767` |
| `cdr_odd_hours` | calls during hours EPIC does not normally place them | `starttime` within the quiet window |

**Baselines must be measured, not assumed.** ~94% of all traffic is `1767`-prefixed
(814,082 of 862,868 on the defaulted scope), so a *foreign* destination is the
minority case and the sharper signal — but the exact band has to come from a
week of hourly counts taken **with explicit filters**, per the scoping rule above.
Do not ship a number that was guessed.

### SHIP THE CRUDE INTERIM FIRST — armed from hour one

**A week of baselining means the watch is not armed for a week. This check is the
compensating control for credentials we deliberately chose not to rotate. A
compensating control that starts compensating in seven days is not compensating.**

So land these two **first**. Both are computable from explicit-filter counts
*today*, with no baseline period, and both are replaced — not supplemented — once
the measured thresholds exist.

| interim key | rule | why it works from hour one |
|---|---|---|
| `cdr_new_destination_prefix` | any call to a destination prefix **not seen in the last 30 days** | the 30-day set *is* the baseline, computed on each run. Toll fraud dials somewhere new. |
| `cdr_hour_exceeds_30d_max` | any hour whose count **exceeds the highest single hour in the last 30 days** | a record-breaking hour needs no threshold — the record is the threshold |

Both are self-calibrating: they compare now against the recent past rather than
against a number someone chose. **They will be noisy** — a first legitimate call to
a new country trips the first one, and a genuinely busy hour trips the second.
Accept that. **Crude and noisy beats seven days of nothing**, and the noise is
itself baseline data.

Implementation note: derive the 30-day prefix set and the 30-day hourly max with
the *same* `magnusCount` calls the real check will use — explicit filters only.
That way the interim exercises the identical code path, so replacing the rule later
changes a threshold, not the plumbing.

## The module

Drop in as `services/isola-sentinel/src/magnus-cdr.js`. Estate owns placement.

```js
'use strict';
// Magnus CDR reader for the sentinel. READ-ONLY BY CONSTRUCTION:
// `action` is hardcoded to 'read' and there is no parameter that can reach
// 'save' or 'refill'. The credential this uses can move money; the module
// must not be able to.
const crypto = require('node:crypto');

const phpUrlencode = (s) =>
  encodeURIComponent(s)
    .replace(/%20/g, '+')
    .replace(/!/g, '%21').replace(/~/g, '%7E').replace(/\*/g, '%2A')
    .replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');

/**
 * Return the COUNT of CDR rows matching `filters`. Never returns rows —
 * `limit: '1'` is fixed, and only `count` is read off the response.
 *
 * @param {{baseUrl:string, apiKey:string, apiSecret:string}} cfg
 * @param {Array<object>} filters  REQUIRED and non-empty. See the scoping rule:
 *   an unfiltered read returns a DIFFERENT, drifting universe.
 */
async function magnusCount(cfg, filters) {
  if (!Array.isArray(filters) || filters.length === 0) {
    throw new Error('magnusCount: an explicit filter is required — an unfiltered read returns a different, drifting scope');
  }
  const mt = process.hrtime();
  const nonce = mt[0].toString() + String(mt[1]).padStart(9, '0').slice(0, 6);
  const body = Object.entries({
    module: 'call',
    action: 'read',          // hardcoded. the only action this module can express.
    nonce,
    page: '1', start: '0', limit: '1',
    filter: JSON.stringify(filters),
  }).map(([k, v]) => phpUrlencode(k) + '=' + phpUrlencode(v)).join('&');

  const base = cfg.baseUrl.replace(/\/+$/, '') + (/mbilling$/.test(cfg.baseUrl) ? '' : '/mbilling');
  const res = await fetch(`${base}/index.php/call/read`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Key: cfg.apiKey,
      Sign: crypto.createHmac('sha512', cfg.apiSecret).update(body).digest('hex'),
    },
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('magnus http ' + res.status);
  const j = JSON.parse(await res.text());
  // `total` does not exist on this API. Reading it would yield undefined and the
  // check would never fire — the exact failure this module was written to avoid.
  if (typeof j.count !== 'number') throw new Error('magnus: count absent — API shape changed, treat as BLIND not healthy');
  return j.count;
}

const sinceFilter = (iso) => ({ type: 'date', field: 'starttime', value: iso, comparison: 'gt' });
const notLocalFilter = () => ({ type: 'string', field: 'calledstation', value: '1767', comparison: 'nst' });

module.exports = { magnusCount, sinceFilter, notLocalFilter };
```

**Note the failure mode on a shape change:** if `count` stops being a number the
module **throws** rather than returning 0. A monitoring check that silently reads
`undefined` as "no anomalies" is the false-clean class — treat it as **blind, not
healthy**, exactly as the sentinel already treats `ledger_unreachable`.

`nst` (not-starts-with) is **assumed and must be confirmed** against this Magnus
build before the foreign-destination signal is trusted. If it is unsupported, count
local with `st` and subtract from the windowed total — do not leave the signal
silently matching nothing.

## Fire it on purpose — before it is believed

A monitor nobody has fired is a monitor that reports success. Same discipline that
caught the SMTP2GO API-key format problem by sending a real alert and reading the
403.

1. **Prove the instrument can return non-zero**: run `magnusCount` with
   `sinceFilter('<24h ago>')`. Against ~700–1,300 calls/day this must be non-zero.
2. **Prove a zero is real**: run it with the `ZZZZNOSUCH` destination filter. Must
   return exactly 0. Without this, a zero from signal 2 is meaningless.
3. **Drive the alert path**: temporarily set the spike threshold below the current
   hourly count so the condition is genuinely true, confirm the email arrives, then
   restore and confirm `RECOVERED`.
4. **Prove the blind path**: point `baseUrl` at an unroutable host and confirm the
   check reports **blind**, not healthy.

Step 4 is the one most likely to be skipped and the one that matters most: it is
the difference between "no fraud detected" and "not looking".

## Open items

- `nst` comparison support — confirm or replace (above).
- Hourly baselines — measure a week, with explicit filters.
- The AMI read-only user (`F-01`) that retires the REST key from this service.
