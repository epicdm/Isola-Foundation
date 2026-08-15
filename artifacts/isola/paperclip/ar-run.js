#!/usr/bin/env node
"use strict";
/**
 * EPIC Staff Operations Coordinator — the deterministic run.
 *
 * DESIGN: DETERMINISTIC-FIRST. The model is optional polish.
 * ----------------------------------------------------------
 * Everything the owner needs is computed here, from a read of the ledger:
 * the position per currency, the ranked action list, the one that matters,
 * the false-note flag, and the exclusions applied. That artefact is complete
 * and correct with NO model involvement whatsoever.
 *
 * A local model may add two or three sentences of framing over the table it is
 * handed. If it is slow, busy, deadlined or absent, WE PUBLISH ANYWAY and say
 * prose was skipped. The facts are never blocked on the polish.
 *
 * WHY: the shared Ollama serves live production (Epic Voice among others) on a
 * single-concurrency box, where a two-character reply measured 3m30s cold. A long
 * internal run to produce ten rows could degrade a live voice product. We yield.
 *
 * PUBLICATION IS OURS, NOT THE MODEL'S. This script holds the Paperclip
 * credential and publishes the verified artefact. The model's message is an
 * INPUT, subject to the traceability gate like any other input. The Paperclip
 * agent's own network allowlist excludes the Paperclip API, so the model has no
 * independent publication path. Do not add one.
 *
 * READ-ONLY ON ODOO: only search_read / search_count / read are ever called.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { verify, explain } = require("./numeric-traceability.js");

// ---------------------------------------------------------------------------
// Configuration — defaults, overridable from AGENTS.md so the owner stays in
// control of behaviour from inside Paperclip.
// ---------------------------------------------------------------------------

const DEFAULTS = {
  actionListLength: 10,
  spotCheckCount: 5,
  proseDeadlineMs: 60_000,        // start at 60s; tune from measured renders
  ollamaProbeMs: 5_000,           // if it cannot answer this fast, it is busy — yield
  ollamaModel: "qwen2.5:3b-instruct-q4_K_M",
  ollamaBaseUrl: "http://66.118.37.12:11434",
  skipProseWhenBusy: true,
};

const ENV = {
  odooUrl: process.env.ODOO_URL || "https://epic-communications-inc.odoo.com",
  odooDb: process.env.ODOO_DB || "epic-communications-inc",
  odooKeyFile: process.env.ODOO_API_KEY_FILE || "/paperclip/secrets/odoo-readonly.key",
  paperclipUrl: process.env.PAPERCLIP_BASE_URL || "https://isola-ai.saas00.epic.dm",
  paperclipKeyFile: process.env.PAPERCLIP_API_KEY_FILE || "/paperclip/secrets/paperclip-api.key",
  companyId: process.env.PAPERCLIP_COMPANY_ID || "3ed3869b-463c-4876-8e16-ddc058f06cd9",
  agentId: process.env.PAPERCLIP_AGENT_ID || "2b4cf82a-00d5-496b-877e-b5bc9201d52c",
  instructionsDir: process.env.AGENT_INSTRUCTIONS_DIR || "",
  lockFile: process.env.AR_LOCK_FILE || "/paperclip/run/ar-run.lock",
  dryRun: process.env.AR_DRY_RUN === "1",
};

/**
 * Read tunables from AGENTS.md. The owner edits the file in Paperclip; the next
 * run reflects it. Only an explicitly fenced block is parsed — prose is never
 * interpreted as configuration.
 *
 *     ```epic-config
 *     actionListLength: 10
 *     proseDeadlineMs: 60000
 *     ```
 */
function parseSettings(agentsMarkdown) {
  const settings = { ...DEFAULTS };
  if (!agentsMarkdown) return settings;
  const block = agentsMarkdown.match(/```epic-config\s*\n([\s\S]*?)```/);
  if (!block) return settings;
  for (const line of block[1].split("\n")) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (!(key in DEFAULTS)) continue; // unknown keys are ignored, never guessed at
    const def = DEFAULTS[key];
    let value = rawValue.replace(/^["']|["']$/g, "");
    if (typeof def === "number") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) settings[key] = n;
    } else if (typeof def === "boolean") {
      settings[key] = /^(true|yes|1)$/i.test(value);
    } else {
      settings[key] = value;
    }
  }
  return settings;
}

/** Prose guidance handed to the model. Never used for figures. */
function parseProseGuidance(soulMarkdown) {
  if (!soulMarkdown) return "";
  const voice = soulMarkdown.match(/##\s*Voice\s*\n([\s\S]*?)(?=\n##\s|\s*$)/i);
  return (voice ? voice[1] : soulMarkdown).trim().slice(0, 2000);
}

// ---------------------------------------------------------------------------
// Odoo — read-only
// ---------------------------------------------------------------------------

function readKey(file) {
  return fs.readFileSync(file, "utf8").trim();
}

async function odoo(model, method, payload, key) {
  const res = await fetch(`${ENV.odooUrl}/json/2/${model}/${method}`, {
    method: "POST",
    headers: {
      Authorization: "bearer " + key,
      "X-Odoo-Database": ENV.odooDb,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Odoo ${model}.${method} -> HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

const READ_ONLY_METHODS = new Set(["search_read", "search_count", "read", "fields_get"]);

/** Gather every figure the report needs. Deterministic. */
async function gatherFacts(key, today, settings) {
  for (const m of ["search_read", "search_count", "read"]) {
    if (!READ_ONLY_METHODS.has(m)) throw new Error("non-read method in the query path");
  }

  const overdue = await odoo("account.move", "search_read", {
    domain: [
      ["move_type", "=", "out_invoice"],
      ["state", "=", "posted"],
      ["payment_state", "in", ["not_paid", "partial"]],
      ["invoice_date_due", "<", today],
    ],
    fields: ["name", "partner_id", "currency_id", "amount_residual", "invoice_date_due", "payment_state"],
  }, key);

  const daysOverdue = (due) => Math.floor((new Date(today) - new Date(due)) / 86_400_000);

  const rows = overdue.map((r) => ({
    id: r.id,
    invoice: r.name,
    customer: Array.isArray(r.partner_id) ? r.partner_id[1] : String(r.partner_id),
    currency: Array.isArray(r.currency_id) ? r.currency_id[1] : String(r.currency_id),
    residual: Number((r.amount_residual || 0).toFixed(2)),
    daysOverdue: daysOverdue(r.invoice_date_due),
    paymentState: r.payment_state,
    dueDate: r.invoice_date_due,
  }));

  // Position per currency. NEVER summed across currencies.
  const byCurrency = {};
  for (const r of rows) {
    (byCurrency[r.currency] ||= { currency: r.currency, invoices: 0, residual: 0 });
    byCurrency[r.currency].invoices++;
    byCurrency[r.currency].residual += r.residual;
  }
  const position = Object.values(byCurrency)
    .map((p) => ({ ...p, residual: Number(p.residual.toFixed(2)) }))
    .sort((a, b) => b.residual - a.residual);

  // Ranking: amount owed weighted by how long it has been owed. Arithmetic.
  const ranked = [...rows]
    .sort((a, b) => b.residual * b.daysOverdue - a.residual * a.daysOverdue)
    .slice(0, settings.actionListLength);

  // Spot-check: re-read individually and compare against the aggregate.
  const spotIds = ranked.slice(0, settings.spotCheckCount).map((r) => r.id);
  const reread = spotIds.length
    ? await odoo("account.move", "read", { ids: spotIds, fields: ["name", "payment_state", "amount_residual", "state", "move_type"] }, key)
    : [];
  const rereadById = Object.fromEntries(reread.map((r) => [r.id, r]));
  const spotChecks = ranked.slice(0, settings.spotCheckCount).map((r) => {
    const f = rereadById[r.id];
    const matches = Boolean(f)
      && Math.abs((f.amount_residual || 0) - r.residual) < 0.005
      && f.payment_state === r.paymentState
      && f.state === "posted"
      && f.move_type === "out_invoice";
    return {
      invoice: r.invoice,
      aggregate: r.residual,
      reread: f ? Number((f.amount_residual || 0).toFixed(2)) : null,
      state: f ? `${f.state}/${f.payment_state}` : "MISSING",
      matches,
    };
  });

  // Exclusions, stated so nobody has to trust that they were applied.
  const drafts = await odoo("account.move", "search_count", { domain: [["move_type", "=", "out_invoice"], ["state", "=", "draft"]] }, key);
  const inPayment = await odoo("account.move", "search_count", {
    domain: [["move_type", "=", "out_invoice"], ["state", "=", "posted"], ["payment_state", "=", "in_payment"]],
  }, key);

  // The note trail contradicting the ledger. A count and a list. Never a person.
  const notes = await odoo("mail.message", "search_read", {
    domain: [["model", "=", "account.move"], ["body", "ilike", "marked as paid"]],
    fields: ["res_id"],
  }, key);
  const claimedPaid = new Set(notes.map((n) => n.res_id));
  const contradicted = rows.filter((r) => claimedPaid.has(r.id)).map((r) => r.invoice);

  return {
    asOf: today,
    position,
    ranked,
    spotChecks,
    spotChecksAllMatch: spotChecks.every((s) => s.matches),
    excluded: { drafts, inPayment },
    noteTrail: {
      invoicesCarryingPaidNote: claimedPaid.size,
      stillOwedDespiteNote: contradicted.length,
      invoices: contradicted,
      overdueTotal: rows.length,
    },
  };
}

// ---------------------------------------------------------------------------
// The artefact — complete without any model
// ---------------------------------------------------------------------------

const money = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function buildArtefact(facts, prose, proseNote) {
  const L = [];
  L.push(`**As of ${facts.asOf}.** Figures read from \`epic-communications-inc.odoo.com\`. Currencies are not summed.`);
  L.push("");

  if (prose) {
    L.push(prose.trim());
    L.push("");
  }

  L.push("## The position");
  L.push("");
  L.push("| currency | invoices | owed |");
  L.push("|---|---:|---:|");
  for (const p of facts.position) L.push(`| ${p.currency} | ${p.invoices} | ${money(p.residual)} |`);
  L.push("");

  if (facts.ranked.length) {
    const top = facts.ranked[0];
    const share = facts.position.find((p) => p.currency === top.currency);
    L.push("## The one that matters");
    L.push("");
    L.push(`**${top.invoice} — ${top.customer} — ${top.currency} ${money(top.residual)}, ${top.daysOverdue} days overdue.**`);
    if (share && share.residual > 0) {
      const pct = Math.round((top.residual / share.residual) * 100);
      L.push("");
      L.push(`That is ${pct}% of everything owed in ${top.currency}. Collect it and the rest is housekeeping.`);
    }
    L.push("");
  }

  L.push("## Action list");
  L.push("");
  L.push("Ranked by amount owed weighted by days overdue.");
  L.push("");
  L.push("| # | invoice | customer | cur | owed | days |");
  L.push("|---:|---|---|---|---:|---:|");
  facts.ranked.forEach((r, i) => {
    L.push(`| ${i + 1} | ${r.invoice} | ${r.customer} | ${r.currency} | ${money(r.residual)} | ${r.daysOverdue} |`);
  });
  L.push("");

  L.push("## Spot-check");
  L.push("");
  L.push("Each re-read individually by id and compared against the aggregate.");
  L.push("");
  L.push("| invoice | aggregate said | re-read says | state | match |");
  L.push("|---|---:|---:|---|---|");
  for (const s of facts.spotChecks) {
    L.push(`| ${s.invoice} | ${money(s.aggregate)} | ${s.reread === null ? "MISSING" : money(s.reread)} | ${s.state} | ${s.matches ? "yes" : "NO"} |`);
  }
  L.push("");
  L.push(facts.spotChecksAllMatch
    ? "All spot-checks reconcile."
    : "**A spot-check failed to reconcile. Treat every figure above as suspect.**");
  L.push("");

  const nt = facts.noteTrail;
  if (nt.stillOwedDespiteNote > 0) {
    const pct = Math.round((nt.stillOwedDespiteNote / nt.overdueTotal) * 100);
    L.push("## The note trail disagrees with the ledger");
    L.push("");
    L.push(`**${nt.stillOwedDespiteNote} of the ${nt.overdueTotal} overdue invoices carry a "marked as paid" note and are still owed** — ${pct}% of the book.`);
    L.push("");
    L.push("Anyone reading the chatter would conclude this money had arrived. It has not.");
    L.push("The cause is a defective automation rule, not a member of staff: Odoo attributes an");
    L.push("automation's write to whichever credential triggered it, so the named author is");
    L.push("routinely not the cause. No name is attached to this finding.");
    L.push("");
    L.push("Affected: " + nt.invoices.join(", "));
    L.push("");
  }

  L.push("## What was excluded, and what was not checked");
  L.push("");
  L.push(`- **${facts.excluded.drafts} draft invoices excluded.** A draft has not been sent; nobody has been billed. Drafts are not debts.`);
  L.push(`- **${facts.excluded.inPayment} \`in_payment\` invoices excluded.** Registered but unreconciled — the money is not confirmed.`);
  L.push("- Only `payment_state` and `amount_residual` were trusted. The note trail was not treated as fact.");
  L.push("- No credit decision, payment arrangement or customer contact is implied. This is a recommendation to the owner.");
  L.push("");
  L.push("---");
  L.push("");
  L.push(proseNote || "_Covering note written by the local model and verified against the ledger read._");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// The model — optional, deadlined, yielding
// ---------------------------------------------------------------------------

/** Is the shared Ollama responsive right now? If not, we do not queue behind it. */
async function ollamaResponsive(settings) {
  try {
    const res = await fetch(`${settings.ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(settings.ollamaProbeMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ask for two or three sentences of framing. Returns null on ANY problem —
 * busy, slow, deadlined, absent, or gate failure. Never throws into the caller.
 */
async function tryProse(facts, guidance, settings) {
  if (settings.skipProseWhenBusy && !(await ollamaResponsive(settings))) {
    return { prose: null, note: "_Covering note skipped: the shared Ollama did not answer within " +
      `${settings.ollamaProbeMs / 1000}s and serves live production. The figures above are unaffected._` };
  }

  // Hand the model the SMALLEST set of facts that can carry a covering sentence.
  //
  // The note-trail counts are deliberately withheld. Measured 2026-08-14: given them,
  // qwen2.5:3b wrote "there are still 18 invoices owed out of a total of 22" — every
  // number traceable, and the claim false (18 is the count carrying a false PAID NOTE,
  // not the count owed). The traceability gate passes that, because the gate checks
  // provenance of figures, NOT the semantics of the sentence around them. There is no
  // cheap check for that class, so we remove the opportunity instead: the deterministic
  // section already states the note-trail finding exactly, and states it better.
  const modelFacts = { position: facts.position, top: facts.ranked[0] || null };
  const table = JSON.stringify(modelFacts);

  const system = [
    "You write two or three sentences of framing for a receivables report.",
    "YOU MUST NOT PRODUCE ANY NUMBER THAT IS NOT PRESENT VERBATIM IN THE DATA YOU ARE GIVEN.",
    "Do not calculate. Do not total. Do not combine currencies. Do not name any person as",
    "responsible for anything. If you are unsure, write less.",
    guidance ? "Voice guidance:\n" + guidance : "",
  ].filter(Boolean).join("\n");

  const started = Date.now();
  let text;
  try {
    const res = await fetch(`${settings.ollamaBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.ollamaModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: "Data:\n" + table + "\n\nWrite the framing sentences only." },
        ],
        max_tokens: 220,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(settings.proseDeadlineMs),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    text = ((j.choices || [])[0] || {}).message?.content || "";
  } catch (e) {
    const waited = Math.round((Date.now() - started) / 1000);
    return { prose: null, note: `_Covering note skipped after ${waited}s (${e.name === "TimeoutError" ? "deadline" : e.message}). ` +
      "Not retried: the shared Ollama serves live production. The figures above are unaffected._" };
  }

  // The model's message is an INPUT, and it goes through the gate like any other.
  //
  // Gate against EXACTLY what the model was handed — not against everything that
  // happens to be true. Measured 2026-08-14: given only {XCD: 20, USD: 2}, the model
  // wrote "22 invoices". It had summed them. Verifying against the full facts let it
  // through, because 22 legitimately exists elsewhere (noteTrail.overdueTotal). A
  // derived figure that coincides with some other real number is still a derived
  // figure, and the model must never derive.
  const gate = verify(text, modelFacts);
  if (!gate.ok) {
    console.error(explain(gate));
    // Publication still proceeds — the facts are never blocked on the polish, and the
    // rejected prose is discarded rather than published. But a run where the guard
    // fired must NOT look clean to monitoring, so it is flagged and the process exits
    // non-zero at the end (systemd will mark the unit failed while the owner still
    // gets his list).
    return { gateFailed: true, prose: null, note: "_Covering note was generated and then **rejected by the numeric traceability check** " +
      "(it contained a figure not present in the ledger read). It was discarded, not published. The figures above are computed, not generated._" };
  }
  const took = Math.round((Date.now() - started) / 1000);
  return { prose: text.trim(), note: `_Covering note written by the local model in ${took}s and verified against the ledger read._` };
}

// ---------------------------------------------------------------------------
// Publication — ours, not the model's
// ---------------------------------------------------------------------------

async function publish(title, body, pcKey) {
  const res = await fetch(`${ENV.paperclipUrl}/api/companies/${ENV.companyId}/issues`, {
    method: "POST",
    headers: { Authorization: "Bearer " + pcKey, "Content-Type": "application/json" },
    body: JSON.stringify({ title, description: body, assigneeAgentId: ENV.agentId, status: "todo", priority: "high" }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Paperclip publish -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/**
 * THE KILL SWITCH.
 *
 * The owner's lever is the agent's pause button in Paperclip, so the deterministic
 * runner must honour it — otherwise pausing would stop a codex run that no longer
 * happens and leave the real work running, which is a kill switch that only appears
 * to work. Fail CLOSED: if the agent's status cannot be read, do not run.
 */
async function agentAllowsRun(pcKey) {
  let res;
  try {
    res = await fetch(`${ENV.paperclipUrl}/api/agents/${ENV.agentId}`, {
      headers: { Authorization: "Bearer " + pcKey }, signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return { allowed: false, why: `cannot reach Paperclip to check the kill switch (${e.message}); refusing to run` };
  }
  if (!res.ok) return { allowed: false, why: `Paperclip returned HTTP ${res.status} for the agent; refusing to run` };
  const agent = await res.json();
  if (agent.status === "paused") {
    return { allowed: false, why: `agent is PAUSED in Paperclip${agent.pauseReason ? ` (${agent.pauseReason})` : ""}; not running` };
  }
  return { allowed: true, why: `agent status is ${agent.status}` };
}

/**
 * FAILS CLOSED. If we cannot establish that today's issue does NOT exist, we must
 * assume it does. Returning false on a timeout or a transient 5xx would publish a
 * duplicate in exactly the failure mode where listing is broken but creating still
 * works — and "exactly one output per day" is a promise, not a preference. A missed
 * day is recoverable; two contradictory action lists in the owner's inbox are not.
 */
async function alreadyPublishedToday(title, pcKey) {
  try {
    const res = await fetch(`${ENV.paperclipUrl}/api/companies/${ENV.companyId}/issues`, {
      headers: { Authorization: "Bearer " + pcKey }, signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error(`cannot verify today's issue (HTTP ${res.status}); assuming it exists and skipping`);
      return true;
    }
    const issues = await res.json();
    return (issues || []).some((i) => i.title === title);
  } catch (e) {
    console.error(`cannot verify today's issue (${e.message}); assuming it exists and skipping`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Semaphore of 1 — from our side only
// ---------------------------------------------------------------------------

async function withLock(file, fn) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  let handle;
  try {
    handle = await fsp.open(file, "wx");
  } catch (e) {
    if (e.code === "EEXIST") {
      const age = Date.now() - (await fsp.stat(file)).mtimeMs;
      if (age < 30 * 60_000) throw new Error("another run holds the lock (age " + Math.round(age / 1000) + "s); skipping");
      await fsp.unlink(file); // stale
      handle = await fsp.open(file, "wx");
    } else throw e;
  }
  try {
    await handle.writeFile(String(process.pid));
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await fsp.unlink(file).catch(() => {});
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const dow = new Date(today).getUTCDay();

  const instrDir = ENV.instructionsDir;
  const readIf = (f) => { try { return fs.readFileSync(path.join(instrDir, f), "utf8"); } catch { return ""; } };
  const settings = parseSettings(instrDir ? readIf("AGENTS.md") : "");
  const guidance = parseProseGuidance(instrDir ? readIf("SOUL.md") : "");

  if (dow === 0 || dow === 6) {
    console.log(`weekend (${today}); nothing to do`);
    return;
  }

  const title = `AR action list — ${today}`;
  const pcKey = readKey(ENV.paperclipKeyFile);

  const gate = await agentAllowsRun(pcKey);
  console.log(`kill switch: ${gate.why}`);
  if (!gate.allowed) return;

  if (!ENV.dryRun && (await alreadyPublishedToday(title, pcKey))) {
    console.log(`"${title}" already exists; exactly one output per day. Nothing to do.`);
    return;
  }

  const odooKey = readKey(ENV.odooKeyFile);
  const facts = await gatherFacts(odooKey, today, settings);
  const { prose, note, gateFailed } = await tryProse(facts, guidance, settings);
  const body = buildArtefact(facts, prose, note);

  if (ENV.dryRun) {
    console.log(body);
    console.log("\n--- DRY RUN: nothing published ---");
    return { gateFailed };
  }
  const issue = await publish(title, body, pcKey);
  console.log(`published ${issue.identifier || issue.id}`);
  return { gateFailed };
}

if (require.main === module) {
  withLock(ENV.lockFile, main).then((r) => {
    if (r && r.gateFailed) {
      console.error("TRACEABILITY GATE FIRED: the model produced an untraceable figure.");
      console.error("The figures published are computed, not generated, and the prose was");
      console.error("discarded — but this run is marked failed so it is not read as clean.");
      process.exit(3);
    }
  }).catch((e) => {
    console.error("RUN FAILED:", e.message);
    console.error("Nothing was published. Next action: re-read the error above; if Odoo is");
    console.error("unreachable, restore access before the next weekday run.");
    process.exit(1);
  });
}

module.exports = { parseSettings, buildArtefact, gatherFacts, DEFAULTS };
