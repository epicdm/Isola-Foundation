/**
 * bff.ts — "BFF Lite" payment-rails client (Foundation ↔ bff.epic.dm).
 *
 * WHAT THIS DOES
 *   Three server-to-server calls against the BFF Lite payment service:
 *     1. mirrorAccount()   — idempotent upsert of a Magnus voice account
 *                             (SIP creds + DID + owner phone) into the BFF's
 *                             own account table, so it can identify who is
 *                             paying without re-deriving Magnus state itself.
 *     2. getTopupOptions() — fetch the current bundle list + available
 *                             payment methods (card / NBD MoBanking).
 *     3. startTopup()      — kick off a top-up for one bundle via one method;
 *                             card returns a Fiserv-hosted checkout URL,
 *                             mobanking returns an NBD QR payload that
 *                             auto-credits via the BFF's own email-loop
 *                             confirmation (no manual support step needed,
 *                             unlike the retired static-QR stopgap).
 *
 * CONFIG REQUIRED — BffConfig
 *   { baseUrl, internalSecret }
 *     baseUrl        — e.g. https://bff.epic.dm (BFF_BASE_URL secret)
 *     internalSecret — sent as the `x-internal-secret` header on every call
 *                      (BFF_INTERNAL_SECRET secret). NEVER logged, NEVER
 *                      sent to the browser — only this module and its
 *                      Route-Handler callers ever see it.
 *
 * CAUTION
 *   - This module never sees a browser request directly. Callers (Route
 *     Handlers under app/api/consumer/wallet/topup/bff/*) are responsible
 *     for session-gating the request and injecting the signed-in
 *     consumer's own sipUsername/sipPassword server-side — those values,
 *     and the internal secret, must never reach client JS.
 *   - HTTP 200 is read as "the BFF accepted the call," not proof of a
 *     completed payment — `startTopup` for method=card only means "we got
 *     a checkout URL to hand the user," and method=mobanking only means
 *     "here is a QR to show," not that money has moved. Real settlement
 *     confirmation happens asynchronously on the BFF side.
 *   - sipPassword is sent over HTTPS to a server we trust (BFF Lite) as
 *     part of its own auth contract for the options/start endpoints; it is
 *     never logged here.
 *
 * CURRENCY CODES — two vocabularies, mapped at this module's boundary
 *   The BFF speaks ISO 4217 codes on the wire: "USD" (diaspora bundles) and
 *   "XCD" (local bundles) — confirmed live on BFF commit 5c2ef596. The rest
 *   of the Foundation app (UI toggle, wallet display, audit logs) speaks the
 *   display symbols "US$" / "EC$". This module is the ONLY place that
 *   should ever see a raw BFF currency code — every caller elsewhere in the
 *   app must only ever see "US$" / "EC$".
 *     inbound  (getTopupOptions): ISO code from the BFF  -> display symbol
 *     outbound (startTopup):      display symbol from us -> ISO code
 *   An unrecognized/missing inbound code defaults to "EC$" (never "US$") —
 *   the safe default is the currency that has always worked, so a future
 *   BFF response shape change degrades gracefully instead of accidentally
 *   minting USD charges.
 *
 * RETURN URL (card checkout)
 *   `startTopup` accepts an optional `returnUrl` (card method only) — the
 *   Foundation's OWN wallet screen, built by the caller from the CURRENT
 *   request's origin so the consumer's session cookie survives the round
 *   trip. This module only relays it on the wire as `returnUrl`; whether
 *   the Fiserv-hosted pay page actually redirects there after payment is
 *   entirely up to the BFF/pay-page side (a separate change) — sending it
 *   here is harmless even before that lands.
 */

export interface BffConfig {
  baseUrl: string;
  internalSecret: string;
}

export interface BffMirrorAccountInput {
  magnusUserId: string;
  sipUsername: string;
  sipPassword: string;
  did: string;
  ownerPhone: string;
}

export interface BffMirrorAccountResult {
  ok: boolean;
  created?: boolean;
  updated?: boolean;
  error?: string;
}

// Currency the consumer pays in via Fiserv card checkout. Fiserv accepts
// both — EC$ (XCD) and US$ (USD). This is the Foundation-wide DISPLAY
// vocabulary; the BFF's own ISO-code vocabulary never leaks past this file.
export type BffTopupCurrency = 'EC$' | 'US$';

/** Maps a raw currency value straight off the BFF wire to our display vocabulary.
 * Accepts both the BFF's ISO codes ("USD"/"XCD") and, defensively, our own
 * display symbols in case a caller re-normalizes an already-mapped bundle.
 * Anything else (missing, null, unrecognized) defaults to 'EC$' — never
 * 'US$' — so an unexpected shape can never silently mint a USD charge. */
function normalizeInboundCurrency(raw: unknown): BffTopupCurrency {
  if (raw === 'USD' || raw === 'US$') return 'US$';
  if (raw === 'XCD' || raw === 'EC$') return 'EC$';
  return 'EC$';
}

/** Maps our display vocabulary back to the BFF's ISO code for outbound calls. */
function toOutboundCurrency(display: BffTopupCurrency): 'USD' | 'XCD' {
  return display === 'US$' ? 'USD' : 'XCD';
}

export interface BffTopupBundle {
  id: string;
  paidAmount: number; // amount the consumer pays, in `currency`
  creditAmount: number; // EC$ credited to the wallet (can exceed paidAmount — bonus bundles).
  // Always EC$ regardless of `currency` — this doubles as the USD→EC$
  // wallet-credit equivalent to show alongside a US$ bundle.
  minutes?: number;
  label?: string;
  // Display currency ('EC$' | 'US$'), already mapped from the BFF's raw
  // ISO code by getTopupOptions() below — callers outside this file never
  // see "USD"/"XCD" directly.
  currency?: BffTopupCurrency;
}

export type BffTopupMethodId = 'card' | 'mobanking' | string;

export interface BffTopupOptionsResult {
  ok: boolean;
  bundles: BffTopupBundle[];
  methods: BffTopupMethodId[];
  error?: string;
}

export interface BffStartTopupInput {
  username: string;
  password: string;
  bundleId: string;
  method: 'card' | 'mobanking';
  // Currency of the selected bundle, in our DISPLAY vocabulary (card only —
  // mobanking is always EC$). Sent alongside bundleId as a belt-and-
  // suspenders confirmation of what the consumer picked; the BFF is
  // expected to derive currency from bundleId itself, so this is optional
  // and safe to ignore if unsupported. Mapped to the BFF's ISO code before
  // it goes on the wire.
  currency?: BffTopupCurrency;
  // card-only: where the Fiserv-hosted checkout page should send the
  // consumer back to after paying or cancelling. Caller builds this from
  // the CURRENT request's own origin (so the session cookie round-trips
  // correctly) — this module just relays it on the wire as `returnUrl`.
  returnUrl?: string;
}

export interface BffStartTopupResult {
  ok: boolean;
  url?: string; // method=card — Fiserv-hosted checkout link
  qrUrl?: string; // method=mobanking — NBD MoBanking QR payload/image URL
  amountEc?: number; // method=mobanking — exact amount to pay
  note?: string; // method=mobanking — instructions to relay to the user
  error?: string;
}

function baseHeaders(config: BffConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-internal-secret': config.internalSecret,
  };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const raw = await res.text();
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return { _raw: raw.slice(0, 300) };
  }
}

export async function mirrorAccount(
  config: BffConfig,
  input: BffMirrorAccountInput,
): Promise<BffMirrorAccountResult> {
  if (!config.baseUrl || !config.internalSecret) {
    return { ok: false, error: 'BFF not configured (BFF_BASE_URL / BFF_INTERNAL_SECRET missing).' };
  }

  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/api/lite/mirror-account`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: baseHeaders(config),
      body: JSON.stringify({
        magnusUserId: input.magnusUserId,
        sipUsername: input.sipUsername,
        sipPassword: input.sipPassword,
        did: input.did,
        ownerPhone: input.ownerPhone,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'network error';
    console.error('[bff] mirror-account network error:', detail);
    return { ok: false, error: `BFF unreachable: ${detail}` };
  }

  const body = await readJson(res);
  if (!res.ok) {
    const msg = typeof body.error === 'string' ? body.error : `BFF returned HTTP ${res.status}`;
    console.error('[bff] mirror-account rejected:', res.status, msg);
    return { ok: false, error: msg };
  }

  return {
    ok: true,
    created: body.created === true,
    updated: body.updated === true,
  };
}

export async function getTopupOptions(
  config: BffConfig,
  input: { username: string; password: string },
): Promise<BffTopupOptionsResult> {
  if (!config.baseUrl) {
    return { ok: false, bundles: [], methods: [], error: 'BFF not configured (BFF_BASE_URL missing).' };
  }

  const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/api/lite/topup/options`);
  url.searchParams.set('u', input.username);
  url.searchParams.set('k', input.password);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'x-internal-secret': config.internalSecret },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'network error';
    console.error('[bff] topup/options network error:', detail);
    return { ok: false, bundles: [], methods: [], error: `BFF unreachable: ${detail}` };
  }

  const body = await readJson(res);
  if (!res.ok) {
    const msg = typeof body.error === 'string' ? body.error : `BFF returned HTTP ${res.status}`;
    console.error('[bff] topup/options rejected:', res.status, msg);
    return { ok: false, bundles: [], methods: [], error: msg };
  }

  const rawBundles = Array.isArray(body.bundles) ? (body.bundles as Record<string, unknown>[]) : [];

  // Map the BFF's raw ISO currency codes ("USD"/"XCD") to our display
  // vocabulary ("US$"/"EC$") right here at the boundary — every caller
  // outside this module only ever sees the display vocabulary.
  const bundles: BffTopupBundle[] = rawBundles.map((b) => ({
    id: String(b.id ?? ''),
    paidAmount: typeof b.paidAmount === 'number' ? b.paidAmount : 0,
    creditAmount: typeof b.creditAmount === 'number' ? b.creditAmount : 0,
    minutes: typeof b.minutes === 'number' ? b.minutes : undefined,
    label: typeof b.label === 'string' ? b.label : undefined,
    currency: normalizeInboundCurrency(b.currency),
  }));

  return {
    ok: true,
    bundles,
    methods: Array.isArray(body.methods) ? (body.methods as BffTopupMethodId[]) : [],
  };
}

// ── Lite callback (wallet-metered "call without installing Acrobits") ───────
//
// CONFIRMED LIVE CONTRACT (bff.epic.dm, 2026-07-13) — not documented
// anywhere else, discovered by direct probing since this endpoint predates
// this integration:
//   POST /api/lite/callback
//     body: { sipUsername, sipPassword, fromNumber, toDominicaNumber }
//       - fromNumber: consumer's own registered ownerPhone, in E.164
//         ("+1767XXXXXXX") — Magnus rings THIS number first.
//       - toDominicaNumber: E.164 Dominica destination ("+1767XXXXXXX")
//         ONLY — see lib/dominica-phone.ts for why this is a hard external
//         constraint, not a choice made in this codebase.
//       - sipUsername/sipPassword: the consumer's own SIP creds. Sending
//         them is what the product spec calls the "authenticated" path
//         (vs. the anonymous free-promo flow that omits them) — the BFF
//         still applies its own per-caller daily rate limit even when
//         credentials are present, which is a distinct, expected safeguard
//         from the destination-country restriction above.
//     202 success: { status: "queued", callId, message }
//     422: { error: "toDominicaNumber must be a valid Dominica number (1-767-xxx-xxxx)" }
//     400: { error: "fromNumber is invalid" }
//     429: { error: "Daily limit reached for this number. Try again tomorrow." }
//     (insufficient wallet balance shape not yet observed live — this
//     module treats any other non-2xx response defensively, see
//     BffCallbackResult.kind below)
//
//   GET /api/lite/call-state/{callId}
//     Server-Sent Events stream (Content-Type: text/event-stream), NOT a
//     polling JSON endpoint. Each `data: {...}\n\n` frame is a JSON object
//     with at least an `event` field observed to include: "connected"
//     (stream itself established — not a call state), "ringing",
//     "answered", "hangup", "timeout". This module exposes the raw
//     fetch Response so the caller (a Route Handler) can pipe
//     `response.body` straight through to the browser — do not buffer it
//     here, that would defeat the whole point of a live stream.

export interface BffCallbackInput {
  sipUsername: string;
  sipPassword: string;
  fromNumber: string; // E.164, e.g. "+1767XXXXXXX"
  toDominicaNumber: string; // E.164 Dominica destination, e.g. "+1767XXXXXXX"
}

export type BffCallbackErrorKind =
  | 'bad_destination' // 422 — destination failed the BFF's own Dominica-format check
  | 'bad_from_number' // 400 — fromNumber missing/invalid
  | 'rate_limited' // 429 — daily cap for this caller/number
  | 'insufficient_balance' // inferred from response text mentioning balance/credit/funds
  | 'unreachable' // network error talking to the BFF
  | 'unknown'; // anything else non-2xx

export interface BffCallbackResult {
  ok: boolean;
  callId?: string;
  message?: string;
  error?: string;
  errorKind?: BffCallbackErrorKind;
}

function classifyCallbackError(status: number, message: string): BffCallbackErrorKind {
  const m = message.toLowerCase();
  if (status === 429) return 'rate_limited';
  if (status === 400 && m.includes('fromnumber')) return 'bad_from_number';
  if (status === 422 || m.includes('dominica')) return 'bad_destination';
  if (m.includes('balance') || m.includes('insufficient') || m.includes('credit') || m.includes('funds')) {
    return 'insufficient_balance';
  }
  return 'unknown';
}

export async function startCallback(
  config: BffConfig,
  input: BffCallbackInput,
): Promise<BffCallbackResult> {
  if (!config.baseUrl) {
    return { ok: false, error: 'BFF not configured (BFF_BASE_URL missing).', errorKind: 'unreachable' };
  }

  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/api/lite/callback`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: baseHeaders(config),
      body: JSON.stringify({
        sipUsername: input.sipUsername,
        sipPassword: input.sipPassword,
        fromNumber: input.fromNumber,
        toDominicaNumber: input.toDominicaNumber,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'network error';
    console.error('[bff] callback network error:', detail);
    return { ok: false, error: `BFF unreachable: ${detail}`, errorKind: 'unreachable' };
  }

  const body = await readJson(res);
  if (!res.ok) {
    const msg = typeof body.error === 'string' ? body.error : `BFF returned HTTP ${res.status}`;
    console.error('[bff] callback rejected:', res.status, msg);
    return { ok: false, error: msg, errorKind: classifyCallbackError(res.status, msg) };
  }

  return {
    ok: true,
    callId: typeof body.callId === 'string' ? body.callId : undefined,
    message: typeof body.message === 'string' ? body.message : undefined,
  };
}

// ── Lite context (Customer 360 support panel) ───────────────────────────────
//
// GET /api/internal/lite/context?phone= — dec-CC-DISPATCH-app-support-phase-B-
// line-context-panel-2026-09-02. Composed entirely from existing bff-v2 reads
// (Magnus + the LiteAccount/LitePlanSubscription tables) — no new business
// logic on the bff-v2 side, and this client function adds none either: it is
// a straight relay of the wire shape proven live on bff-v2-staging 2026-09-06
// (known-good/ambiguous-refuse/no-cred/bad-cred/not-found, all differentiated).
//
// AMBIGUITY IS A REFUSAL, NOT A PICK. Unlike mirrorAccount/getTopupOptions
// above (keyed by a consumer's own SIP credentials, so there is only ever one
// account to find), this is keyed by a PHONE NUMBER on a SUPPORT AGENT'S
// screen — more than one LiteAccount sharing that number means bff-v2 itself
// refuses to guess (`{ found: true, ambiguous: true, count }`), and this
// client passes that refusal straight through rather than resolving it.

export interface LitePlanSummary {
  planId: string;
  expiresAt: string; // ISO 8601
  state: string; // e.g. 'active' | 'grace' | 'renewal_due' | 'expired' | 'cancelled'
  autoRenew: boolean;
}

export interface LiteRecentCallItem {
  kind: 'call';
  at: string; // ISO 8601
  label: string; // e.g. "Missed · +1767..."
}

export type LiteLineStatus = 'active' | 'blocked' | 'unknown' | 'not_provisioned';
export type LiteRoutingMode = 'app' | 'app_then_cell' | 'cell' | 'unknown';

export type LiteContextResult =
  | { ok: true; found: false }
  | { ok: true; found: true; ambiguous: true; count: number }
  | {
      ok: true;
      found: true;
      ambiguous: false;
      did: string | null;
      status: LiteLineStatus;
      balanceEc: number | null;
      routingMode: LiteRoutingMode;
      signupAt: string;
      plan: LitePlanSummary | null;
      recent: readonly LiteRecentCallItem[];
      recentActivityUnavailable: boolean;
    }
  | { ok: false; error: string };

/**
 * Server-to-server only — `phone` is never accepted from a browser request
 * without going through this same tenant/session-gated route handler layer
 * every other engines/* caller already requires (see the file header CAUTION).
 */
export async function getLiteContext(config: BffConfig, phone: string): Promise<LiteContextResult> {
  if (!config.baseUrl || !config.internalSecret) {
    return { ok: false, error: 'BFF not configured (BFF_BASE_URL / BFF_INTERNAL_SECRET missing).' };
  }

  const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/api/internal/lite/context`);
  url.searchParams.set('phone', phone);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'x-internal-secret': config.internalSecret },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'network error';
    console.error('[bff] lite/context network error:', detail);
    return { ok: false, error: `BFF unreachable: ${detail}` };
  }

  const body = await readJson(res);
  if (!res.ok) {
    const msg = typeof body.error === 'string' ? body.error : `BFF returned HTTP ${res.status}`;
    console.error('[bff] lite/context rejected:', res.status, msg);
    return { ok: false, error: msg };
  }

  if (body.found !== true) {
    return { ok: true, found: false };
  }
  if (body.ambiguous === true) {
    return { ok: true, found: true, ambiguous: true, count: typeof body.count === 'number' ? body.count : 0 };
  }

  const rawPlan = body.plan as Record<string, unknown> | null | undefined;
  const plan: LitePlanSummary | null =
    rawPlan && typeof rawPlan === 'object'
      ? {
          planId: String(rawPlan.planId ?? ''),
          expiresAt: String(rawPlan.expiresAt ?? ''),
          state: String(rawPlan.state ?? ''),
          autoRenew: rawPlan.autoRenew === true,
        }
      : null;

  const recent: LiteRecentCallItem[] = Array.isArray(body.recent)
    ? (body.recent as Record<string, unknown>[])
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({
          kind: 'call',
          at: String(c.at ?? ''),
          label: String(c.label ?? ''),
        }))
    : [];

  return {
    ok: true,
    found: true,
    ambiguous: false,
    did: typeof body.did === 'string' ? body.did : null,
    status: (['active', 'blocked', 'unknown', 'not_provisioned'] as const).includes(
      body.status as LiteLineStatus,
    )
      ? (body.status as LiteLineStatus)
      : 'unknown',
    balanceEc: typeof body.balanceEc === 'number' ? body.balanceEc : null,
    routingMode: (['app', 'app_then_cell', 'cell', 'unknown'] as const).includes(
      body.routingMode as LiteRoutingMode,
    )
      ? (body.routingMode as LiteRoutingMode)
      : 'unknown',
    signupAt: String(body.signupAt ?? ''),
    plan,
    recent,
    recentActivityUnavailable: body.recentActivityUnavailable === true,
  };
}

/**
 * Opens the BFF's SSE call-state stream and returns the raw Response for
 * the caller to pipe through as-is. Deliberately does NOT parse/buffer the
 * body — that would turn a live stream into a single snapshot.
 */
export async function openCallStateStream(config: BffConfig, callId: string): Promise<Response> {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/api/lite/call-state/${encodeURIComponent(callId)}`;
  return fetch(endpoint, {
    method: 'GET',
    headers: { 'x-internal-secret': config.internalSecret },
    // No timeout here — this is a long-lived stream by design.
  });
}

export async function startTopup(
  config: BffConfig,
  input: BffStartTopupInput,
): Promise<BffStartTopupResult> {
  if (!config.baseUrl) {
    return { ok: false, error: 'BFF not configured (BFF_BASE_URL missing).' };
  }

  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/api/lite/topup/start`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: baseHeaders(config),
      body: JSON.stringify({
        username: input.username,
        password: input.password,
        bundleId: input.bundleId,
        method: input.method,
        // Map our display vocabulary back to the BFF's ISO code on the way
        // out — the BFF is expected to derive currency from bundleId
        // itself, so this is a belt-and-suspenders confirmation only.
        ...(input.currency ? { currency: toOutboundCurrency(input.currency) } : {}),
        // card-only — where Fiserv should send the consumer back to after
        // paying/cancelling. Harmless to send even before the pay page
        // honors it.
        ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'network error';
    console.error('[bff] topup/start network error:', detail);
    return { ok: false, error: `BFF unreachable: ${detail}` };
  }

  const body = await readJson(res);
  if (!res.ok) {
    const msg = typeof body.error === 'string' ? body.error : `BFF returned HTTP ${res.status}`;
    console.error('[bff] topup/start rejected:', res.status, msg);
    return { ok: false, error: msg };
  }

  return {
    ok: true,
    url: typeof body.url === 'string' ? body.url : undefined,
    qrUrl: typeof body.qrUrl === 'string' ? body.qrUrl : undefined,
    amountEc: typeof body.amountEc === 'number' ? body.amountEc : undefined,
    note: typeof body.note === 'string' ? body.note : undefined,
  };
}
