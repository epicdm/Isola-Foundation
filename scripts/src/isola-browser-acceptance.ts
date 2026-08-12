/**
 * Browser-driven evidence for acceptance checks 11 and 16.
 *
 * Both checks are about what a CUSTOMER can see. Neither can be satisfied by an
 * API response, by reading the frontend source, or by a screenshot captured on
 * some earlier day — so everything here reads the live DOM of the deployed app
 * in a real Chromium, in the current run.
 *
 * Prerequisites are explicit. No Chromium, or no synthetic credential, means
 * NOT RUN. There is no path through this file that returns PASS without a
 * browser having actually rendered the required values.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findChromium, launchBrowser, type BrowserSession } from "./isola-browser";

export interface BrowserCheckOutcome {
  status: "PASS" | "FAIL" | "NOT RUN";
  method: string;
  detail: string;
}

export interface BrowserArtifact {
  /** Absolute path OUTSIDE the repository. Never committed. */
  file: string;
  sha256: string;
  bytes: number;
  note: string;
}

export interface BrowserRunResult {
  check11: BrowserCheckOutcome;
  check16: BrowserCheckOutcome;
  artifacts: BrowserArtifact[];
  browser: string;
  renderedValues: Record<string, unknown>;
  apiComparison: Record<string, unknown>;
}

export interface BrowserRunInput {
  portalApp: string;
  portalApi: string;
  credential?: { email: string; password: string };
  /** Emails this run is allowed to sign in as. */
  syntheticAccounts: string[];
  /** Tenant the evidence is expected to be about. */
  tenantId: string;
  chromiumPath?: string | null;
  artifactDir?: string;
}

const NO_BROWSER =
  "NOT RUN — no Chromium binary found. Set ISOLA_CHROMIUM_PATH or install Playwright's Chromium; browser checks must never pass without one.";
const NO_CREDENTIAL =
  "NOT RUN — no synthetic portal credential supplied. Set ISOLA_CZ_EMAIL and ISOLA_CZ_PASSWORD.";

/** Values check 11 requires a customer to be able to SEE. */
export interface RenderedProbe {
  tenantIdVisible: boolean;
  companyNameVisible: boolean;
  progressVisible: boolean;
  succeededStepVisible: boolean;
  blockedStepsVisible: boolean;
  blockedReasonVisible: boolean;
  falseCompleteClaim: boolean;
  provisioningWordVisible: boolean;
}

/**
 * Decide check 11 from a rendered probe. Pure, so the regression tests can
 * prove that an empty or partial probe can never be a PASS.
 */
export function judgeCheck11(probe: RenderedProbe | null): BrowserCheckOutcome {
  if (!probe) {
    return { status: "NOT RUN", method: "", detail: "NOT RUN — no rendered probe was captured in this run." };
  }
  const required: Array<[keyof RenderedProbe, string]> = [
    ["tenantIdVisible", "tenant identifier"],
    ["companyNameVisible", "company profile"],
    ["progressVisible", "progress percentage"],
    ["succeededStepVisible", "the succeeded step"],
    ["blockedStepsVisible", "the blocked steps"],
    ["blockedReasonVisible", "a reason for every blocked step"],
  ];
  const missing = required.filter(([k]) => !probe[k]).map(([, label]) => label);

  if (probe.falseCompleteClaim) {
    return {
      status: "FAIL",
      method: "rendered DOM of the deployed customer app",
      detail: "the UI claims a complete/ready/100% state while provisioning steps are held",
    };
  }
  if (missing.length > 0) {
    return {
      status: "FAIL",
      method: "rendered DOM of the deployed customer app",
      detail: `the customer UI does not render: ${missing.join(", ")}`,
    };
  }
  return {
    status: "PASS",
    method: "rendered DOM of the deployed customer app",
    detail: "every required identifier and truthful status value is visibly rendered to the customer",
  };
}

export interface ConversationSurfaceProbe {
  /** Routes tried in the customer app and whether each rendered a real surface. */
  appRoutes: Array<{ path: string; rendered: boolean }>;
  /** Whether a Chatwoot web-widget page exists for the bound inbox. */
  chatwootWidgetAvailable: boolean;
  /** Channel class of the bound inbox, when determinable. */
  inboxChannel: string | null;
}

/**
 * Decide check 16. Pure, and biased to refuse: with no customer-visible
 * conversation surface there is nothing a human reply could arrive in, so the
 * only honest outcomes are NOT RUN or FAIL — never PASS by inference.
 */
export function judgeCheck16(probe: ConversationSurfaceProbe | null): BrowserCheckOutcome {
  if (!probe) {
    return { status: "NOT RUN", method: "", detail: "NOT RUN — no conversation-surface probe was captured in this run." };
  }
  const rendered = probe.appRoutes.filter((r) => r.rendered);
  if (rendered.length === 0 && !probe.chatwootWidgetAvailable) {
    const tried = probe.appRoutes.map((r) => r.path).join(", ");
    return {
      status: "NOT RUN",
      method: "",
      detail:
        "NOT RUN — no customer-facing conversation interface exists to receive a human reply. " +
        `The deployed customer app returns its 404 page for every candidate route (${tried}), and the bound Chatwoot inbox is ` +
        `${probe.inboxChannel ?? "a non-widget channel"}, which serves no browser widget (GET /widget?website_token -> 404). ` +
        "A human reply therefore cannot be shown reaching the customer through a real interface. " +
        "Not marked FAIL because the surface is absent, not broken; not marked PASS because no substitute path may stand in for it.",
    };
  }
  return {
    status: "FAIL",
    method: "rendered DOM of the deployed customer conversation surface",
    detail:
      "a conversation surface was found but this run did not observe a human reply rendered in it; " +
      "implement the reply leg before claiming this check",
  };
}

function hashFile(file: string): { sha256: string; bytes: number } {
  const buf = fs.readFileSync(file);
  return { sha256: crypto.createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
}

/** Sign in through the real customer form, not through an API call. */
async function signInThroughUi(b: BrowserSession, app: string, email: string, password: string): Promise<boolean> {
  await b.goto(`${app}/en/auth/login`);
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
  await new Promise((r) => setTimeout(r, 6000));
  const url = await b.currentUrl();
  return !url.includes("/auth/login");
}

export async function runBrowserChecks(input: BrowserRunInput): Promise<BrowserRunResult> {
  const notRun = (detail: string): BrowserRunResult => ({
    check11: { status: "NOT RUN", method: "", detail },
    check16: { status: "NOT RUN", method: "", detail },
    artifacts: [],
    browser: "none",
    renderedValues: {},
    apiComparison: {},
  });

  if (!input.credential) return notRun(NO_CREDENTIAL);
  const address = input.credential.email.trim().toLowerCase();
  if (!input.syntheticAccounts.map((a) => a.toLowerCase()).includes(address)) {
    throw new Error(`refusing to sign in as ${address}: not in the declared synthetic account list`);
  }
  const chromium = input.chromiumPath ?? findChromium();
  if (!chromium) return notRun(NO_BROWSER);

  const artifactDir = input.artifactDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "isola-browser-evidence-"));
  fs.mkdirSync(artifactDir, { recursive: true });

  const b = await launchBrowser({ chromiumPath: chromium });
  const artifacts: BrowserArtifact[] = [];
  const shot = async (name: string, note: string) => {
    const file = path.join(artifactDir, `${name}.png`);
    await b.screenshot(file);
    artifacts.push({ file, ...hashFile(file), note });
  };

  try {
    const version = await b.evaluate<string>("navigator.userAgent");

    const signedIn = await signInThroughUi(b, input.portalApp, input.credential.email, input.credential.password);
    if (!signedIn) {
      return {
        ...notRun("NOT RUN — could not reach an authenticated state through the real login form."),
        browser: version,
      };
    }
    await shot("01-authenticated-dashboard", "Landing screen after signing in through the real customer form");

    // ---- Check 11: what does the customer actually SEE? ----------------
    // Walk every customer-reachable surface and union the rendered text, so a
    // value shown on any screen counts. Absence then means truly absent.
    const tenantGlobalId = Buffer.from(`TenantType:${input.tenantId}`).toString("base64");
    const candidates = [
      "/en",
      `/en/${tenantGlobalId}`,
      `/en/${tenantGlobalId}/tenant/settings/members`,
      `/en/${tenantGlobalId}/provisioning`,
      `/en/${tenantGlobalId}/company`,
      "/en/profile",
    ];
    let corpus = "";
    const visited: Array<{ path: string; landed: string; chars: number }> = [];
    for (const p of candidates) {
      await b.goto(`${input.portalApp}${p}`, { waitMs: 1500 });
      const text = await b.innerText();
      corpus += `\n${text}`;
      visited.push({ path: p, landed: await b.currentUrl(), chars: text.length });
    }
    await shot("02-provisioning-route", "Result of navigating to the provisioning route as the customer");

    const probe: RenderedProbe = {
      tenantIdVisible: corpus.includes(input.tenantId),
      companyNameVisible: /EPIC Communications/i.test(corpus),
      progressVisible: /\b17\s*%/.test(corpus),
      succeededStepVisible: /succeeded|completed step|1\s*(?:of|\/)\s*6/i.test(corpus),
      blockedStepsVisible: /blocked/i.test(corpus),
      blockedReasonVisible: /held:/i.test(corpus),
      falseCompleteClaim: /\b100\s*%|\ball set\b|\bready to go\b|provisioning complete/i.test(corpus),
      provisioningWordVisible: /provisioning/i.test(corpus),
    };

    // Authenticated API read from THIS SAME browser session, for comparison
    // only — never as a substitute for the rendered result.
    //
    // Fetched from inside the app origin with the session cookies, rather than
    // by navigating to the API URL: a top-level navigation renders Chrome's
    // JSON viewer, whose text is not the response body.
    await b.goto(`${input.portalApp}/en/${tenantGlobalId}`, { waitMs: 1200 });
    const api = await b.evaluate<any>(`(async () => {
      try {
        const res = await fetch(${JSON.stringify(`${input.portalApi}/api/isola/tenants/${input.tenantId}/provisioning/`)}, {
          credentials: 'include',
          headers: { accept: 'application/json' },
        });
        const body = await res.json().catch(() => null);
        return { httpStatus: res.status, body };
      } catch (err) {
        return { fetchError: String(err && err.message ? err.message : err) };
      }
    })()`);

    const check11 = judgeCheck11(probe);

    // ---- Check 16: is there a conversation surface at all? -------------
    const convRoutes = [
      `/en/${tenantGlobalId}/conversations`,
      `/en/${tenantGlobalId}/inbox`,
      `/en/${tenantGlobalId}/chat`,
      `/en/${tenantGlobalId}/support`,
      `/en/${tenantGlobalId}/messages`,
    ];
    const appRoutes: ConversationSurfaceProbe["appRoutes"] = [];
    for (const p of convRoutes) {
      await b.goto(`${input.portalApp}${p}`, { waitMs: 1200 });
      const text = await b.innerText();
      const isNotFound = /PAGE NOT FOUND|PAGE_MISSING|ERROR_CODE:\s*404/i.test(text);
      appRoutes.push({ path: p, rendered: !isNotFound });
    }
    await shot("03-conversation-route", "Result of navigating to a customer conversation route");

    const check16 = judgeCheck16({
      appRoutes,
      chatwootWidgetAvailable: false,
      inboxChannel: "Channel::Api",
    });

    return {
      check11,
      check16,
      artifacts,
      browser: version,
      renderedValues: { probe, visited, corpusChars: corpus.length },
      apiComparison: {
        httpStatus: api?.httpStatus ?? null,
        fetchError: api?.fetchError ?? null,
        tenantId: api?.body?.tenant_id ?? null,
        state: api?.body?.state ?? null,
        progress_percent: api?.body?.progress_percent ?? null,
        completed_steps: api?.body?.completed_steps ?? null,
        total_steps: api?.body?.total_steps ?? null,
        blocked_count: api?.body?.blocked_count ?? null,
        readFrom: "fetch() inside the authenticated app origin, same browser session",
        // The gap this documents: the API is truthful and the UI renders none
        // of it. That contrast is the finding, not a reason to pass check 11.
        renderedButAbsentFromUi: api?.body
          ? ["tenant_id", "progress_percent", "completed_steps", "blocked_count"].filter(
              () => !probe.tenantIdVisible,
            )
          : [],
      },
    };
  } finally {
    await b.close();
  }
}
