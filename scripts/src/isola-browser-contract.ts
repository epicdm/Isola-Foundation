/**
 * The comparison contract for browser acceptance checks 11 and 16.
 *
 * Everything here is PURE. Capture lives in `isola-browser-acceptance.ts`;
 * judgement lives here. That split is what lets the regression suite prove the
 * property that actually matters — that no input shape yields PASS unless a
 * browser rendered the exact values the live API returned in the same run.
 *
 * Two rules shape the whole file:
 *
 *   1. Expectations are DERIVED, never literal. A hard-coded "17%" passes for
 *      one afternoon and then fails for the wrong reason. Every expected value
 *      comes from the authenticated API payload captured in this run.
 *   2. Evidence is per-field and per-route. A regex sweep over a concatenated
 *      page corpus cannot distinguish "the provisioning screen shows this step
 *      as BLOCKED" from "the word blocked appears somewhere in the app".
 */

/** One provisioning step as the API reports it. */
export interface ApiStep {
  key: string;
  state: string;
  blocked_reason?: string | null;
  external_ref?: string | null;
}

/** Live payloads read from the authenticated session. Expectations come from these. */
export interface ApiSnapshot {
  tenantId: string;
  companyLegalName: string;
  companyTradingName: string;
  progressPercent: number;
  completedSteps: number;
  totalSteps: number;
  blockedCount: number;
  steps: ApiStep[];
}

/**
 * One value the UI is required to display, and what the browser actually saw.
 *
 * `renderedText` is the visible text of the specific element the UI contract
 * points at — not the page, and not the DOM including hidden nodes.
 */
export interface FieldObservation {
  field: string;
  expected: string;
  /** Visible text found at the contracted location, or null when absent. */
  renderedText: string | null;
  /** Route the observation was made on. */
  route: string;
  /** False when the node exists but is not visible to a human. */
  visible: boolean;
}

export interface RouteObservation {
  route: string;
  landedUrl: string;
  /** Declared terminal state, not a guess from a timer. */
  uiState: "loaded" | "not-found" | "error" | "timeout";
  screenshot?: string;
}

export interface Check11Evidence {
  api: ApiSnapshot;
  observations: FieldObservation[];
  routes: RouteObservation[];
  /** A visible claim of completion/readiness, when one was found. */
  completionClaim: string | null;
}

export interface Outcome {
  status: "PASS" | "FAIL" | "NOT RUN";
  method: string;
  detail: string;
}

const normalise = (s: string) => s.replace(/\s+/g, " ").trim();

/** An observation counts only when the exact expected value is visibly rendered. */
export function fieldSatisfied(o: FieldObservation): boolean {
  if (!o.visible || o.renderedText === null) return false;
  return normalise(o.renderedText) === normalise(o.expected);
}

/** Every field the acceptance contract requires a customer to be able to see. */
export function requiredFields(api: ApiSnapshot): string[] {
  const fields = [
    "tenant_id",
    "company_name",
    "progress_percent",
    "completed_of_total",
  ];
  for (const step of api.steps) {
    fields.push(`step:${step.key}:state`);
    if (step.state === "BLOCKED") fields.push(`step:${step.key}:blocked_reason`);
  }
  return fields;
}

/**
 * Judge check 11 by exact comparison against the live API snapshot.
 *
 * Deliberately unforgiving: a single missing blocked reason, one stale
 * percentage, or one step absent from the screen is a FAIL. The customer-facing
 * claim is "the portal displays correct real IDs and status", and a partial
 * display is not that.
 */
export function judgeCheck11(evidence: Check11Evidence | null): Outcome {
  if (!evidence) {
    return { status: "NOT RUN", method: "", detail: "NOT RUN — no browser evidence was captured in this run." };
  }
  const { api, observations } = evidence;

  // A UI that claims readiness while the API still reports blocked steps is a
  // worse failure than one that shows nothing, so it is judged first.
  if (evidence.completionClaim && api.blockedCount > 0) {
    return {
      status: "FAIL",
      method: "exact comparison of rendered DOM against the live authenticated API",
      detail:
        `the UI visibly claims "${evidence.completionClaim}" while the API reports ` +
        `${api.blockedCount} blocked step(s) at ${api.progressPercent}%`,
    };
  }

  const byField = new Map(observations.map((o) => [o.field, o]));
  const required = requiredFields(api);

  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const field of required) {
    const o = byField.get(field);
    if (!o || o.renderedText === null || !o.visible) {
      missing.push(field);
      continue;
    }
    if (!fieldSatisfied(o)) {
      mismatched.push(`${field} (expected "${o.expected}", rendered "${normalise(o.renderedText)}")`);
    }
  }

  if (missing.length === 0 && mismatched.length === 0) {
    return {
      status: "PASS",
      method: "exact comparison of rendered DOM against the live authenticated API",
      detail:
        `all ${required.length} required values are visibly rendered and exactly match the API: ` +
        `tenant ${api.tenantId}, ${api.progressPercent}% (${api.completedSteps}/${api.totalSteps}), ` +
        `${api.steps.length} step(s) with state, ${api.blockedCount} blocked reason(s)`,
    };
  }

  const parts: string[] = [];
  if (missing.length) parts.push(`not rendered: ${missing.join(", ")}`);
  if (mismatched.length) parts.push(`rendered but wrong: ${mismatched.join("; ")}`);
  return {
    status: "FAIL",
    method: "exact comparison of rendered DOM against the live authenticated API",
    detail: parts.join(" · "),
  };
}

// ---------------------------------------------------------------------------
// Check 16
// ---------------------------------------------------------------------------

/**
 * What the runner OBSERVED about the Chatwoot side in this run.
 *
 * `null` means "not determined in this run" and must never be reported as a
 * fact. The previous implementation passed these as constants while the
 * produced text claimed the runner had seen a 404 — right conclusion, invented
 * evidence chain.
 */
export interface ChatwootObservation {
  widgetAvailable: boolean | null;
  inboxChannel: string | null;
  /** Exactly what was requested and what came back, when anything was. */
  probe: string | null;
}

/** A reply as it is visibly rendered in the customer's browser. */
export interface RenderedReply {
  /** Visible message text. */
  text: string;
  /** Visible sender label, as a customer would read it. */
  senderLabel: string;
  /** Visible sender classification derived from the surface, not inferred. */
  senderKind: "human" | "ai" | "unknown";
  /** Message identifier from the surface, when it exposes one. */
  messageRef: string | null;
}

export interface Check16Evidence {
  /** Candidate customer conversation routes and whether a real surface rendered. */
  appRoutes: Array<{ route: string; landedUrl: string; uiState: RouteObservation["uiState"] }>;
  chatwoot: ChatwootObservation;
  /** True only when a genuinely pre-authorized operator surface was available. */
  operatorSessionAvailable: boolean;
  /** How that operator session was authorized, for the record. */
  operatorSessionDescription: string | null;
  /** Set when this run actually submitted a reply through that operator surface. */
  replyAttempt: {
    conversationRef: string;
    /** Run-unique marker embedded in the reply so a stale message cannot match. */
    runMarker: string;
    submittedAt: string;
  } | null;
  /** Replies visibly rendered in the CUSTOMER's browser after the attempt. */
  renderedReplies: RenderedReply[];
  /** Conversation the customer surface was showing, for staleness checking. */
  observedConversationRef: string | null;
}

/**
 * Judge check 16.
 *
 * A PASS requires the entire chain: a rendered customer surface, an
 * already-authorized operator session, a reply submitted in THIS run, and
 * exactly one visibly-human copy of that exact reply in the customer's browser.
 * Anything less is NOT RUN (nothing was exercised) or FAIL (it was, and it
 * did not hold).
 */
export function judgeCheck16(evidence: Check16Evidence | null): Outcome {
  if (!evidence) {
    return { status: "NOT RUN", method: "", detail: "NOT RUN — no browser evidence was captured in this run." };
  }

  const rendered = evidence.appRoutes.filter((r) => r.uiState === "loaded");
  const widgetKnownAvailable = evidence.chatwoot.widgetAvailable === true;

  if (rendered.length === 0 && !widgetKnownAvailable) {
    const tried = evidence.appRoutes.map((r) => `${r.route} -> ${r.uiState}`).join(", ");
    // Say only what was observed. When the Chatwoot side was not probed in this
    // run, say that plainly rather than restating a previously-known constant.
    const chatwootNote =
      evidence.chatwoot.probe ??
      (evidence.chatwoot.widgetAvailable === null
        ? "the Chatwoot widget surface was not probed in this run, so no claim is made about it"
        : "no Chatwoot widget is available");
    return {
      status: "NOT RUN",
      method: "",
      detail:
        "NOT RUN — no customer-facing conversation interface rendered, so there is nowhere for a human reply to arrive. " +
        `Candidate routes: ${tried}. ${chatwootNote}. ` +
        "Absent rather than broken, so this is NOT RUN, not FAIL; and no substitute path may stand in for it.",
    };
  }

  if (!evidence.operatorSessionAvailable) {
    return {
      status: "NOT RUN",
      method: "",
      detail:
        "NOT RUN — a customer conversation surface rendered, but no already-authorized operator session exists to send a human reply from. " +
        "Creating or retrieving a credential to force this check is prohibited.",
    };
  }

  if (!evidence.replyAttempt) {
    return {
      status: "NOT RUN",
      method: "",
      detail: "NOT RUN — surface and operator session are available, but no reply was submitted in this run.",
    };
  }

  const { runMarker, conversationRef } = evidence.replyAttempt;

  // Staleness: the customer must be looking at the conversation we replied to.
  if (evidence.observedConversationRef !== conversationRef) {
    return {
      status: "FAIL",
      method: "rendered DOM of the customer conversation surface",
      detail:
        `the customer surface was showing conversation ${evidence.observedConversationRef ?? "unknown"} ` +
        `but the reply was sent to ${conversationRef}; evidence from a different conversation cannot count`,
    };
  }

  const matches = evidence.renderedReplies.filter((r) => r.text.includes(runMarker));

  if (matches.length === 0) {
    return {
      status: "FAIL",
      method: "rendered DOM of the customer conversation surface",
      detail: `a human reply was submitted in this run but no message carrying its run marker is visible to the customer`,
    };
  }
  if (matches.length > 1) {
    return {
      status: "FAIL",
      method: "rendered DOM of the customer conversation surface",
      detail: `the reply is visible ${matches.length} times; a single human reply must appear exactly once`,
    };
  }

  const only = matches[0];
  if (only.senderKind !== "human") {
    return {
      status: "FAIL",
      method: "rendered DOM of the customer conversation surface",
      detail:
        `the reply is visible but the customer sees it attributed as "${only.senderLabel}" (${only.senderKind}); ` +
        "a human reply must be visibly distinguishable from an AI reply",
    };
  }

  return {
    status: "PASS",
    method: "rendered DOM of the customer conversation surface",
    detail:
      `exactly one human reply carrying this run's marker is visible to the customer in conversation ${conversationRef}, ` +
      `attributed to "${only.senderLabel}"` +
      (only.messageRef ? ` (message ${only.messageRef})` : ""),
  };
}
