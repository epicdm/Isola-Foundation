/**
 * Browser-driven capture for acceptance checks 11 and 16.
 *
 * This file OBSERVES. It does not decide — every verdict comes from the pure
 * judges in `isola-browser-contract.ts`, so the regression suite can exercise
 * the decision logic without a browser and prove what cannot pass.
 *
 * Expectations are derived from the live authenticated API in the same run.
 * Nothing about the tenant, company, percentage, step set or blocked reasons is
 * hard-coded here; a literal would pass for one afternoon and then fail for the
 * wrong reason once real provisioning moves on.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findChromium, launchBrowser, type BrowserSession } from "./isola-browser";
import {
  judgeCheck11,
  judgeCheck16,
  requiredFields,
  type ApiSnapshot,
  type Check11Evidence,
  type Check16Evidence,
  type FieldObservation,
  type Outcome,
  type RouteObservation,
} from "./isola-browser-contract";

export {
  judgeCheck11,
  judgeCheck16,
  requiredFields,
  type ApiSnapshot,
  type Check11Evidence,
  type Check16Evidence,
  type FieldObservation,
  type Outcome,
  type RouteObservation,
};

/**
 * A refusal to act on something not declared synthetic.
 *
 * Distinct from an ordinary failure on purpose: the harness must not let its
 * generic catch turn a safety refusal into a routine prerequisite NOT RUN, and
 * must not echo the offending identifier. Callers correlate with `ref`.
 */
export class SyntheticGuardRefusal extends Error {
  readonly ref: string;
  readonly kind: "account" | "tenant";
  constructor(kind: "account" | "tenant") {
    // No identifier in the message. This string reaches logs and PR text.
    super(`refused: the supplied ${kind} is not in the declared synthetic ${kind} list`);
    this.name = "SyntheticGuardRefusal";
    this.kind = kind;
    this.ref = crypto.randomBytes(4).toString("hex");
  }
}

export interface BrowserArtifact {
  /** Absolute path OUTSIDE the repository. Never committed. */
  file: string;
  sha256: string;
  bytes: number;
  route: string;
  note: string;
}

export interface BrowserRunResult {
  check11: Outcome;
  check16: Outcome;
  artifacts: BrowserArtifact[];
  browser: string;
  check11Evidence: Check11Evidence | null;
  check16Evidence: Check16Evidence | null;
  guardRefusal?: { kind: "account" | "tenant"; ref: string };
}

export interface BrowserRunInput {
  portalApp: string;
  portalApi: string;
  credential?: { email: string; password: string };
  syntheticAccounts: string[];
  syntheticTenants: string[];
  tenantId: string;
  chromiumPath?: string | null;
  artifactDir?: string;
}

const NO_BROWSER =
  "NOT RUN — no Chromium binary found. Set ISOLA_CHROMIUM_PATH or install Playwright's Chromium; browser checks must never pass without one.";
const NO_CREDENTIAL =
  "NOT RUN — no synthetic portal credential supplied. Set ISOLA_CZ_EMAIL and ISOLA_CZ_PASSWORD.";

/**
 * The UI contract. Values must be rendered at these deterministic locations,
 * not merely appear somewhere on the page.
 */
export const UI_CONTRACT = {
  tenantId: '[data-testid="isola-tenant-id"]',
  companyName: '[data-testid="isola-company-name"]',
  progressPercent: '[data-testid="isola-progress-percent"]',
  completedOfTotal: '[data-testid="isola-completed-of-total"]',
  stepState: (key: string) => `[data-testid="isola-step-${key}-state"]`,
  stepBlockedReason: (key: string) => `[data-testid="isola-step-${key}-blocked-reason"]`,
  completionClaim: '[data-testid="isola-provisioning-complete"]',
} as const;

/** The company name a customer must see: trading name when set, else legal. */
export function expectedCompanyName(api: Pick<ApiSnapshot, "companyLegalName" | "companyTradingName">): string {
  return api.companyTradingName?.trim() ? api.companyTradingName : api.companyLegalName;
}

function hashFile(file: string) {
  const buf = fs.readFileSync(file);
  return { sha256: crypto.createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
}

/**
 * Read the visible text at a selector.
 *
 * Visibility is checked in the page: a node hidden by `display:none`,
 * `visibility:hidden`, zero opacity or zero size does not count as shown to a
 * customer, and neither does text present only in the DOM.
 */
const VISIBLE_TEXT_FN = `
  function __isolaVisibleText(sel) {
    const el = document.querySelector(sel);
    if (!el) return { found: false, visible: false, text: null };
    const style = window.getComputedStyle(el);
    const rects = el.getClientRects();
    const visible =
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) !== 0 &&
      rects.length > 0 &&
      el.offsetParent !== null;
    return { found: true, visible, text: el.textContent };
  }
`;

/**
 * Wait for a genuinely terminal UI state.
 *
 * This is a single-page app: the shell (nav, header) paints before the route's
 * own content resolves. Classifying on the first non-empty body therefore reads
 * "loaded" for a route that is about to render its 404 — which is exactly the
 * wrong answer, and it silently turns an absent screen into a present one.
 *
 * So settle on STABILITY: the visible text must stop changing for two
 * consecutive polls, with the document complete and nothing marked busy, before
 * the state is classified. That is still an observed condition rather than a
 * fixed sleep, but it does not race the router.
 */
async function waitForTerminalState(b: BrowserSession, timeoutMs = 25000): Promise<RouteObservation["uiState"]> {
  const deadline = Date.now() + timeoutMs;
  let previous: string | null = null;
  let stableFor = 0;

  while (Date.now() < deadline) {
    const snap = await b
      .evaluate<{ ready: boolean; busy: boolean; text: string }>(`(() => ({
        ready: document.readyState === 'complete',
        busy: Boolean(document.querySelector('[aria-busy="true"], [data-testid="loading"]')),
        text: document.body ? (document.body.innerText || '') : '',
      }))()`)
      .catch(() => null);

    if (snap && snap.ready && !snap.busy && snap.text.trim().length > 0) {
      stableFor = snap.text === previous ? stableFor + 1 : 0;
      previous = snap.text;
      if (stableFor >= 1) {
        if (/PAGE NOT FOUND|PAGE_MISSING|ERROR_CODE:\s*404/i.test(snap.text)) return "not-found";
        const hasErrorMarker = await b
          .evaluate<boolean>(`Boolean(document.querySelector('[data-testid="isola-app-error"]'))`)
          .catch(() => false);
        return hasErrorMarker ? "error" : "loaded";
      }
    } else {
      stableFor = 0;
      if (snap) previous = snap.text;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return "timeout";
}

async function signInThroughUi(b: BrowserSession, app: string, email: string, password: string): Promise<boolean> {
  await b.goto(`${app}/en/auth/login`);
  await waitForTerminalState(b);
  const submitted = await b.evaluate<string>(`(() => {
    const set = (el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const e = document.querySelector('input[type="email"], input[name="email"]');
    const p = document.querySelector('input[type="password"], input[name="password"]');
    if (!e || !p) return 'no-form';
    set(e, ${JSON.stringify(email)});
    set(p, ${JSON.stringify(password)});
    const form = e.closest('form');
    if (!form) return 'no-form-element';
    form.requestSubmit();
    return 'submitted';
  })()`);
  if (submitted !== "submitted") return false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (!(await b.currentUrl()).includes("/auth/login")) return true;
  }
  return false;
}

/** Fetch JSON from inside the authenticated app origin, with session cookies. */
async function apiGet(b: BrowserSession, url: string): Promise<{ status: number; body: any }> {
  return b.evaluate(`(async () => {
    try {
      const res = await fetch(${JSON.stringify(url)}, { credentials: 'include', headers: { accept: 'application/json' } });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch (err) {
      return { status: 0, body: null };
    }
  })()`);
}

export async function runBrowserChecks(input: BrowserRunInput): Promise<BrowserRunResult> {
  const notRun = (detail: string): BrowserRunResult => ({
    check11: { status: "NOT RUN", method: "", detail },
    check16: { status: "NOT RUN", method: "", detail },
    artifacts: [],
    browser: "none",
    check11Evidence: null,
    check16Evidence: null,
  });

  // ---- Safety guards. Both run BEFORE any browser process is spawned. -----
  if (input.credential) {
    const address = input.credential.email.trim().toLowerCase();
    if (!input.syntheticAccounts.map((a) => a.toLowerCase()).includes(address)) {
      throw new SyntheticGuardRefusal("account");
    }
  }
  if (!input.syntheticTenants.includes(input.tenantId)) {
    throw new SyntheticGuardRefusal("tenant");
  }

  if (!input.credential) return notRun(NO_CREDENTIAL);
  // `undefined` means "discover one"; an explicit `null` means "discovery
  // already ran and found nothing", which callers and tests rely on to model
  // the no-browser case without launching anything.
  const chromium = input.chromiumPath === undefined ? findChromium() : input.chromiumPath;
  if (!chromium) return notRun(NO_BROWSER);

  const artifactDir = input.artifactDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "isola-browser-evidence-"));
  fs.mkdirSync(artifactDir, { recursive: true });

  const b = await launchBrowser({ chromiumPath: chromium });
  const artifacts: BrowserArtifact[] = [];
  let shotIndex = 0;

  /** Screenshot the page as it is NOW, tagged with the route it actually shows. */
  const shot = async (route: string, note: string) => {
    shotIndex += 1;
    const safe = route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";
    const file = path.join(artifactDir, `${String(shotIndex).padStart(2, "0")}-${safe}.png`);
    await b.screenshot(file);
    artifacts.push({ file, ...hashFile(file), route, note });
  };

  try {
    const browser = await b.evaluate<string>("navigator.userAgent");

    if (!(await signInThroughUi(b, input.portalApp, input.credential.email, input.credential.password))) {
      return { ...notRun("NOT RUN — could not reach an authenticated state through the real login form."), browser };
    }

    // ---- Expectations come from the live API, in this session. ------------
    const tenants = await apiGet(b, `${input.portalApi}/api/isola/tenants/`);
    const company = await apiGet(b, `${input.portalApi}/api/isola/tenants/${input.tenantId}/company/`);
    const provisioning = await apiGet(b, `${input.portalApi}/api/isola/tenants/${input.tenantId}/provisioning/`);

    if (provisioning.status !== 200 || !provisioning.body) {
      return {
        ...notRun(
          `NOT RUN — could not read the provisioning contract from the authenticated session ` +
            `(tenants ${tenants.status}, company ${company.status}, provisioning ${provisioning.status}); ` +
            "there is nothing to compare rendered values against.",
        ),
        browser,
      };
    }

    const p = provisioning.body;
    const api: ApiSnapshot = {
      tenantId: p.tenant_id ?? input.tenantId,
      companyLegalName: company.body?.legal_name ?? "",
      companyTradingName: company.body?.trading_name ?? "",
      progressPercent: p.progress_percent,
      completedSteps: p.completed_steps,
      totalSteps: p.total_steps,
      blockedCount: p.blocked_count,
      steps: (p.steps ?? []).map((s: any) => ({
        key: s.key,
        state: s.state,
        blocked_reason: s.blocked_reason ?? null,
        external_ref: s.external_ref ?? null,
      })),
    };

    // ---- Walk the customer routes, capturing each one as it is shown. -----
    const tenantGlobalId = Buffer.from(`TenantType:${api.tenantId}`).toString("base64");
    const candidateRoutes = [
      `/en/${tenantGlobalId}/provisioning`,
      `/en/${tenantGlobalId}/company`,
      `/en/${tenantGlobalId}`,
      "/en",
    ];

    const routes: RouteObservation[] = [];
    const observations: FieldObservation[] = [];
    let completionClaim: string | null = null;

    for (const route of candidateRoutes) {
      await b.goto(`${input.portalApp}${route}`, { waitMs: 0 });
      const uiState = await waitForTerminalState(b);
      const landedUrl = await b.currentUrl();
      // Captured HERE, before navigating anywhere else, so the image always
      // shows the route its metadata names.
      await shot(route, `Route ${route} in terminal state "${uiState}"`);
      routes.push({ route, landedUrl, uiState, screenshot: artifacts[artifacts.length - 1].file });

      if (uiState !== "loaded") continue;

      const wanted: Array<{ field: string; selector: string; expected: string }> = [
        { field: "tenant_id", selector: UI_CONTRACT.tenantId, expected: api.tenantId },
        { field: "company_name", selector: UI_CONTRACT.companyName, expected: expectedCompanyName(api) },
        { field: "progress_percent", selector: UI_CONTRACT.progressPercent, expected: `${api.progressPercent}%` },
        {
          field: "completed_of_total",
          selector: UI_CONTRACT.completedOfTotal,
          expected: `${api.completedSteps}/${api.totalSteps}`,
        },
      ];
      for (const step of api.steps) {
        wanted.push({
          field: `step:${step.key}:state`,
          selector: UI_CONTRACT.stepState(step.key),
          expected: step.state,
        });
        if (step.state === "BLOCKED") {
          wanted.push({
            field: `step:${step.key}:blocked_reason`,
            selector: UI_CONTRACT.stepBlockedReason(step.key),
            expected: step.blocked_reason ?? "",
          });
        }
      }

      const found = await b.evaluate<Record<string, { found: boolean; visible: boolean; text: string | null }>>(
        `(() => { ${VISIBLE_TEXT_FN}
          const out = {};
          const spec = ${JSON.stringify(wanted.map((w) => [w.field, w.selector]))};
          for (const [field, sel] of spec) out[field] = __isolaVisibleText(sel);
          return out;
        })()`,
      );

      for (const w of wanted) {
        const r = found[w.field];
        // Record only the best observation per field across routes: a value
        // rendered correctly on any customer-reachable screen counts once.
        const existing = observations.find((o) => o.field === w.field);
        const candidate: FieldObservation = {
          field: w.field,
          expected: w.expected,
          renderedText: r?.found ? r.text : null,
          route,
          visible: Boolean(r?.visible),
        };
        if (!existing) observations.push(candidate);
        else if (!existing.visible && candidate.visible) Object.assign(existing, candidate);
      }

      if (completionClaim === null) {
        completionClaim = await b.evaluate<string | null>(`(() => { ${VISIBLE_TEXT_FN}
          const marker = __isolaVisibleText(${JSON.stringify(UI_CONTRACT.completionClaim)});
          if (marker.found && marker.visible) return (marker.text || '').trim();
          const t = document.body.innerText || '';
          const m = t.match(/\\b100\\s*%|\\ball set\\b|\\bready to go\\b|provisioning complete/i);
          return m ? m[0] : null;
        })()`);
      }
    }

    const check11Evidence: Check11Evidence = { api, observations, routes, completionClaim };

    // ---- Check 16: is there any customer conversation surface? -----------
    const convRoutes = [
      `/en/${tenantGlobalId}/conversations`,
      `/en/${tenantGlobalId}/inbox`,
      `/en/${tenantGlobalId}/chat`,
      `/en/${tenantGlobalId}/support`,
      `/en/${tenantGlobalId}/messages`,
    ];
    const appRoutes: Check16Evidence["appRoutes"] = [];
    for (const route of convRoutes) {
      await b.goto(`${input.portalApp}${route}`, { waitMs: 0 });
      const uiState = await waitForTerminalState(b);
      appRoutes.push({ route, landedUrl: await b.currentUrl(), uiState });
      if (route === convRoutes[0]) await shot(route, `Conversation route ${route} in terminal state "${uiState}"`);
    }

    const check16Evidence: Check16Evidence = {
      appRoutes,
      // Not probed in this run. Determining the inbox channel needs an inbox
      // identifier this harness deliberately does not carry, so these stay
      // unknown rather than being asserted from a previously-known constant.
      chatwoot: { widgetAvailable: null, inboxChannel: null, probe: null },
      operatorSessionAvailable: false,
      operatorSessionDescription: null,
      replyAttempt: null,
      renderedReplies: [],
      observedConversationRef: null,
    };

    return {
      check11: judgeCheck11(check11Evidence),
      check16: judgeCheck16(check16Evidence),
      artifacts,
      browser,
      check11Evidence,
      check16Evidence,
    };
  } finally {
    await b.close();
  }
}
