"use strict";
/**
 * Proof that the traceability gate catches what it claims to catch.
 * Deliberately dependency-free so it runs anywhere, including inside the
 * Paperclip container on host03.
 *
 *   node numeric-traceability.test.js
 */
const assert = require("node:assert");
const { verify, explain, normalise } = require("./numeric-traceability.js");

// The real shape of a query result, trimmed.
const FACTS = {
  asOf: "2026-08-14",
  position: [
    { currency: "XCD", invoices: 20, residual: 326116.99 },
    { currency: "USD", invoices: 2, residual: 971.17 },
  ],
  actions: [
    { invoice: "INV/2026/00037", customer: "NTRC - NATIONAL TELECOMMUNICATIONS REGUL", currency: "XCD", residual: 297917.37, daysOverdue: 14 },
    { invoice: "INV/2026/00012", customer: "Bullseye Pharmacy", currency: "XCD", residual: 6932.0, daysOverdue: 82 },
  ],
  excluded: { drafts: 242, inPayment: 13 },
};

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${e.message}`);
    fail++;
  }
}

console.log("numeric traceability gate\n");

test("a faithful report passes", () => {
  const out = [
    "XCD: 20 invoices, 326,116.99 owed. USD: 2 invoices, 971.17 owed.",
    "Worst: INV/2026/00037, NTRC - NATIONAL TELECOMMUNICATIONS REGUL, 297,917.37 XCD, 14 days overdue.",
    "Then INV/2026/00012, Bullseye Pharmacy, 6,932.00 XCD, 82 days overdue.",
    "242 drafts and 13 in_payment invoices were excluded.",
  ].join("\n");
  const r = verify(out, FACTS);
  assert.ok(r.ok, "expected pass, got: " + JSON.stringify(r.violations));
});

test("an invented total is caught — the characteristic small-model failure", () => {
  // 326116.99 + 971.17 = 327088.16. Plausible. Wrong. Never in the input.
  const out = "Total owed across all currencies: 327,088.16.";
  const r = verify(out, FACTS);
  assert.ok(!r.ok, "expected failure");
  assert.ok(r.violations.some((v) => v.kind === "untraceable_number" && v.token === "327,088.16"),
    "expected the fabricated total to be named");
});

test("a subtly wrong figure is caught (digit transposition)", () => {
  const r = verify("XCD owed: 326,161.99", FACTS); // 116 -> 161
  assert.ok(!r.ok);
  assert.strictEqual(r.violations[0].token, "326,161.99");
});

test("an invented invoice count is caught", () => {
  const r = verify("There are 27 overdue invoices.", FACTS);
  assert.ok(!r.ok);
  assert.strictEqual(r.violations[0].token, "27");
});

test("an invented day count is caught", () => {
  const r = verify("INV/2026/00012 is 91 days overdue.", FACTS);
  assert.ok(!r.ok);
  assert.ok(r.violations.some((v) => v.token === "91"));
});

test("a real figure carrying the WRONG currency is caught — observed from qwen2.5:3b", () => {
  // Verbatim failure mode, 2026-08-14: 297,917.37 is XCD. Digits perfectly traceable.
  const out = "The position in XCD is 326,116.99 with a residual of 297,917.37 USD.";
  const r = verify(out, FACTS);
  assert.ok(!r.ok, "expected failure");
  assert.ok(r.violations.some((v) => v.kind === "currency_mislabelled"),
    "expected the mislabelled currency to be named, got: " + JSON.stringify(r.violations));
});

test("the same figure with its correct currency passes", () => {
  assert.ok(verify("XCD 297,917.37 is owed on the largest invoice.", FACTS).ok);
  assert.ok(verify("USD 971.17 is owed.", FACTS).ok);
});

test("currency on the left or the right is both checked", () => {
  assert.ok(!verify("owed: USD 297,917.37", FACTS).ok, "prefix form");
  assert.ok(!verify("owed: 971.17 XCD", FACTS).ok, "suffix form");
});

test("explicit currency summing is refused even if both numbers are real", () => {
  const r = verify("Combined, XCD 326,116.99 and USD 971.17 are outstanding.", FACTS);
  assert.ok(!r.ok);
  assert.ok(r.violations.some((v) => v.kind === "currencies_summed"));
});

test("presenting drafts as owed is refused", () => {
  const r = verify("Including draft invoices, 242 are overdue.", FACTS);
  assert.ok(!r.ok);
  assert.ok(r.violations.some((v) => v.kind === "draft_presented_as_debt"));
});

test("formatting variants of a real number are accepted", () => {
  assert.ok(verify("326116.99 owed", FACTS).ok, "unformatted");
  assert.ok(verify("326,116.99 owed", FACTS).ok, "comma grouped");
  assert.ok(verify("6932 owed", FACTS).ok, "trailing zeros dropped");
  assert.ok(verify("6,932.00 owed", FACTS).ok, "two decimal places");
});

test("small list ordinals are allowed, but a formatted small number is not", () => {
  assert.ok(verify("1. First item\n2. Second item", FACTS).ok, "ordinals");
  assert.ok(!verify("owed 3.50", FACTS).ok, "a money-shaped small number must still be traceable");
});

test("dates in the input are traceable", () => {
  assert.ok(verify("As of 2026-08-14.", FACTS).ok);
});

test("a date reformatted by the model is still traceable — hyphens are not minus signs", () => {
  // Regression: "2026-07-31" once tokenised as 2026, -07, -31, so the input never
  // contributed "31" and the model writing "July 31, 2026" was rejected against its
  // own source data.
  const f = { ...FACTS, actions: [{ ...FACTS.actions[0], dueDate: "2026-07-31" }] };
  const r = verify("The largest is due July 31, 2026.", f);
  assert.ok(r.ok, "expected pass, got: " + JSON.stringify(r.violations));
});

test("explain() names the offending token and refuses publication", () => {
  const r = verify("Total: 327,088.16", FACTS);
  const msg = explain(r);
  assert.match(msg, /NOTHING WAS PUBLISHED/);
  assert.match(msg, /327,088\.16/);
});

test("normalise handles the money grain", () => {
  assert.strictEqual(normalise("326,116.99").two, "326116.99");
  assert.strictEqual(normalise("6932").two, "6932.00");
  assert.strictEqual(normalise("abc"), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
