"use strict";
/**
 * Numeric traceability gate for the EPIC Staff Operations Coordinator.
 *
 * WHY THIS EXISTS
 * ---------------
 * The model on this path is qwen2.5 (1.5b-3b) running locally. It is adequate for
 * turning a table it was handed into readable guidance, and it is NOT adequate for
 * judgement over raw data. Its characteristic failure is confident, plausible
 * arithmetic — a total that looks right and is not.
 *
 * So the model is never trusted to produce a number. This module verifies, after
 * generation, that every figure in the rendered output was present in the input the
 * model was given. A single unsourced figure fails the run; nothing is published.
 *
 * This is a check, not a prompt. It does not ask the model to behave.
 */

/**
 * Currency/amount/count/day tokens, e.g. "326,116.99", "22".
 *
 * DELIBERATELY UNSIGNED. An earlier version accepted a leading "-", which made
 * "2026-07-31" tokenise as 2026, -07, -31 — so a date in the input contributed
 * "-31" and a date in the output produced "31", and the gate rejected its own
 * source data. A gate that false-positives is worse than one blind to sign: it
 * would silently reject every covering note forever, and the feature would look
 * "safe" while being dead.
 *
 * The cost is that a sign flip on a money value is not detected. That is
 * acceptable here — every residual in this report is positive, and the figures
 * that matter are produced deterministically, not by the model.
 */
const NUMERIC_TOKEN = /\d[\d,]*(?:\.\d+)?/g;

/**
 * A LIST ORDINAL is structural, not factual: "1." at the start of a line numbers an
 * item, it does not assert a quantity.
 *
 * This used to be a blanket allowlist of 0-10 anywhere in the text, which was an
 * unconditional bypass — "3 customers need calls" or "10 overdue invoices" passed
 * untouched even with those numbers absent from the input. Position is what makes a
 * number structural, so match position, not value.
 */
const LIST_ORDINAL = /^[ \t]*(\d{1,2})[.)]\s/gm;

/**
 * Compact and worded quantities. The input handed to the model is always plain
 * decimal, so if the model writes "5k", "1e6" or "one million" it has restated a
 * figure in a form we cannot trace — and in "5k" the "5" would previously also be
 * swallowed by the ordinal allowlist. Refuse them outright.
 */
const COMPACT_NUMERAL = /\b\d+(?:\.\d+)?\s*[kKmMbB]\b|\b\d+(?:\.\d+)?[eE][+-]?\d+\b/;
// Scale words are always a quantity. Small number-words are only a quantity when they
// count something — "one million owed" and "three invoices" are figures, but "the one
// that matters" is ordinary prose and must NOT trip the gate. A gate that fires on
// normal English would silently disable the covering note forever.
const SCALE_WORD = /\b(?:hundred|thousand|million|billion)\b/i;
const COUNTING_WORD = new RegExp(
  "\\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\\s+" +
    "(?:invoices?|customers?|clients?|accounts?|days?|weeks?|months?|dollars?|XCD|USD)\\b",
  "i"
);

/** Normalise a numeric token so "326,116.99", "326116.99" and "326116.990" agree. */
function normalise(token) {
  const bare = String(token).replace(/,/g, "").replace(/^[+-]/, "");
  if (!/^\d+(\.\d+)?$/.test(bare)) return null;
  const n = Number(bare);
  if (!Number.isFinite(n)) return null;
  // Compare on value, not spelling: 2 decimal places is the money grain we report in.
  return {
    exact: bare,
    two: n.toFixed(2),
    int: Number.isInteger(n) ? String(n) : null,
  };
}

/**
 * Every numeric value legitimately available to the model, derived from the SAME
 * structure that was serialised into its prompt.
 *
 * @param {object} facts - the deterministic query result
 * @returns {Set<string>} normalised values that may appear in output
 */
function allowedValuesFrom(facts) {
  const allowed = new Set();
  const add = (v) => {
    const n = normalise(v);
    if (!n) return;
    allowed.add(n.exact);
    allowed.add(n.two);
    if (n.int) allowed.add(n.int);
  };

  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === "number") return add(node);
    if (typeof node === "string") {
      // Strings can carry numbers too (dates, pre-formatted money).
      const m = node.match(NUMERIC_TOKEN);
      if (m) m.forEach(add);
      return;
    }
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === "object") return Object.values(node).forEach(walk);
  };
  walk(facts);
  return allowed;
}

/**
 * Money values mapped to the currency (or currencies) they legitimately belong to.
 *
 * Traceable digits are not enough. Measured 2026-08-14: qwen2.5:3b wrote
 * "326,116.99 with a residual of 297,917.37 USD" — both figures real, and 297,917.37
 * is an XCD amount. A number carrying the wrong currency label is a false statement
 * about money, so the pairing is checked, not just the value.
 */
function currencyPairsFrom(facts) {
  const pairs = new Map(); // normalised value -> Set(currency)
  const add = (value, currency) => {
    const n = normalise(value);
    if (!n || !currency) return;
    for (const form of [n.exact, n.two, n.int].filter(Boolean)) {
      if (!pairs.has(form)) pairs.set(form, new Set());
      pairs.get(form).add(String(currency).toUpperCase());
    }
  };
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const cur = node.currency || node.cur;
    if (cur) {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === "number" && /residual|amount|owed|total/i.test(k)) add(v, cur);
      }
    }
    Object.values(node).forEach(walk);
  };
  walk(facts);
  return pairs;
}

/** Names the model is permitted to write — customers present in the input. */
function allowedNamesFrom(facts) {
  const names = new Set();
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === "string" && /partner|customer|name|invoice/i.test(k)) names.add(v.trim());
        else walk(v);
      }
    }
  };
  walk(facts);
  return names;
}

/**
 * Verify a rendered report against the facts it was generated from.
 *
 * @param {string} output - what the model produced
 * @param {object} facts  - the deterministic query result handed to the model
 * @returns {{ok: boolean, violations: Array<{kind: string, token: string, context: string}>}}
 */
function verify(output, facts) {
  const allowed = allowedValuesFrom(facts);
  const violations = [];
  const text = String(output || "");

  // 0. Positions of genuine list ordinals — exempt by POSITION, never by value.
  const ordinalAt = new Set();
  for (const m of text.matchAll(LIST_ORDINAL)) {
    ordinalAt.add((m.index || 0) + m[0].indexOf(m[1]));
  }

  // 1. NUMBERS. Every numeric token must be traceable to the input.
  for (const match of text.matchAll(NUMERIC_TOKEN)) {
    const raw = match[0];
    const n = normalise(raw);
    if (!n) continue;
    if (ordinalAt.has(match.index || 0)) continue;
    const traceable = allowed.has(n.exact) || allowed.has(n.two) || (n.int && allowed.has(n.int));
    if (!traceable) {
      const at = match.index || 0;
      violations.push({
        kind: "untraceable_number",
        token: raw,
        context: text.slice(Math.max(0, at - 40), at + raw.length + 40).replace(/\s+/g, " ").trim(),
      });
    }
  }

  // 2. CURRENCY MISLABELLING. A real figure carrying the wrong currency is a false
  // statement about money, and the digits alone look perfectly traceable.
  const pairs = currencyPairsFrom(facts);
  const PAIR = /(?:(XCD|USD)\s*)?(\d[\d,]*(?:\.\d+)?)(?:\s*(XCD|USD))?/gi;
  for (const m of text.matchAll(PAIR)) {
    const currency = (m[1] || m[3] || "").toUpperCase();
    if (!currency) continue;
    const n = normalise(m[2]);
    if (!n) continue;
    const known = pairs.get(n.exact) || pairs.get(n.two) || (n.int && pairs.get(n.int));
    if (known && !known.has(currency)) {
      violations.push({
        kind: "currency_mislabelled",
        token: `${m[2]} ${currency}`,
        context: `${m[2]} belongs to ${[...known].join("/")}, not ${currency}`,
      });
    }
  }

  // 3. CURRENCY SUMMING. A combined total is forbidden outright, however it arises.
  // NOTE: the gap must allow '.' — money values contain one, and excluding it made
  // this rule silently unable to match "XCD 326,116.99 and USD 971.17".
  if (/\b(?:total|combined|altogether|overall|sum(?:med)?)\b[^\n]{0,60}\b(?:XCD|USD)\b[^\n]{0,60}\b(?:XCD|USD)\b/i.test(text)) {
    violations.push({ kind: "currencies_summed", token: "-", context: "output appears to combine XCD and USD" });
  }

  // 4. COMPACT / WORDED QUANTITIES. Untraceable by construction — the input is always
  // plain decimal, so any of these is the model restating a figure in its own words.
  const compact = text.match(COMPACT_NUMERAL);
  if (compact) {
    violations.push({ kind: "compact_numeral", token: compact[0].trim(), context: "compact form cannot be traced to a decimal input figure" });
  }
  const worded = text.match(SCALE_WORD) || text.match(COUNTING_WORD);
  if (worded) {
    violations.push({ kind: "worded_numeral", token: worded[0].trim(), context: "a quantity written as a word cannot be traced to the input" });
  }

  // 5. DRAFT LEAKAGE. Drafts are not debts and must never be presented as owed.
  if (/\bdraft\b[^.\n]{0,60}\b(?:owed|overdue|receivable|outstanding)\b/i.test(text)) {
    violations.push({ kind: "draft_presented_as_debt", token: "-", context: "output ties 'draft' to money owed" });
  }

  return { ok: violations.length === 0, violations };
}

/** Render a refusal a human can act on. Used when the gate fails. */
function explain(result) {
  if (result.ok) return "";
  const lines = [
    "RUN FAILED THE NUMERIC TRACEABILITY CHECK — NOTHING WAS PUBLISHED.",
    "",
    "The model produced content that is not traceable to the ledger read it was given.",
    "This is a defect, not a rough edge: the report may contain invented figures.",
    "",
  ];
  for (const v of result.violations) {
    lines.push(`  [${v.kind}] ${v.token !== "-" ? `"${v.token}" ` : ""}— ${v.context}`);
  }
  lines.push("", "Next action: re-run. If it recurs, the model is too small for the rendering task;");
  lines.push("report it rather than lowering the check.");
  return lines.join("\n");
}

module.exports = { verify, explain, allowedValuesFrom, allowedNamesFrom, currencyPairsFrom, normalise, NUMERIC_TOKEN, LIST_ORDINAL };
