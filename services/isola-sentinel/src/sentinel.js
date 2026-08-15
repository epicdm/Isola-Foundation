#!/usr/bin/env node
"use strict";
/**
 * isola-sentinel — the thing that tells a human when the estate stops answering.
 *
 * WHY THIS EXISTS, IN ONE SENTENCE
 * --------------------------------
 * The customer line has now died twice — eleven hours, then twenty-four — and both
 * times it was found by someone looking at something else.
 *
 * "Is the container up" was TRUE for every minute of both outages, so this service
 * deliberately does NOT lead with that. The first-class signal is the one that was
 * missing both times:
 *
 *     A DELIVERY WAS ACCEPTED AND NO REPLY WAS POSTED WITHIN N SECONDS.
 *
 * That is read from `delivery_ledger`, which is durable, authoritative and already
 * written by the gateway on the reply path — not inferred from logs. A delivery is
 * `reserved` the moment the gateway accepts a webhook and `completed` when Chatwoot
 * has the reply. Anything sitting between those two states past a threshold is a
 * customer who said something and heard nothing, whatever the health checks say.
 *
 * It also covers the second silent failure mode: an agent that is supposed to
 * produce something on a schedule and does not. The receivables agent fires at
 * 11:00 UTC on weekdays; absence of its output is itself the alert.
 *
 * DELIVERY IS EMAIL, via SMTP2GO — credentials that already exist and are proven on
 * this estate, no Meta asset involved, not customer traffic. An alert nobody
 * receives is the failure we are fixing, so an undeliverable alert is logged loudly
 * rather than swallowed.
 */
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const nodemailer = require("nodemailer");

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

const readFileOr = (envName, fallback = null) => {
  const p = process.env[envName];
  if (!p) return fallback;
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return fallback;
  }
};

const CFG = {
  intervalMs: Number(process.env.SENTINEL_INTERVAL_MS || 60_000),
  // A reply that has not landed in this long is a customer sitting in silence.
  stuckDeliveryMs: Number(process.env.SENTINEL_STUCK_DELIVERY_MS || 180_000),
  statePath: process.env.SENTINEL_STATE_PATH || "/data/sentinel-state.json",
  // Re-send a still-failing alert at most this often, so a long outage does not
  // become a mailbox full of identical mail nobody reads.
  renotifyMs: Number(process.env.SENTINEL_RENOTIFY_MS || 3_600_000),
  ledgerUrl: readFileOr("SENTINEL_LEDGER_URL_FILE", process.env.SENTINEL_LEDGER_URL),
  smtpHost: process.env.SENTINEL_SMTP_HOST || "",
  smtpPort: Number(process.env.SENTINEL_SMTP_PORT || 2525),
  smtpUser: process.env.SENTINEL_SMTP_USER || "",
  smtpPass: readFileOr("SENTINEL_SMTP_PASS_FILE", process.env.SENTINEL_SMTP_PASS),
  alertTo: (process.env.SENTINEL_ALERT_TO || "").split(",").map((s) => s.trim()).filter(Boolean),
  alertFrom: process.env.SENTINEL_ALERT_FROM || "isola-sentinel@epic.dm",
  paperclipBaseUrl: (process.env.PAPERCLIP_BASE_URL || "").replace(/\/+$/, ""),
  paperclipToken: readFileOr("PAPERCLIP_BOARD_TOKEN_FILE", process.env.PAPERCLIP_BOARD_TOKEN),
  paperclipCompanyId: process.env.PAPERCLIP_COMPANY_ID || "",
  // The receivables agent's schedule. Absence of output after this is an alert.
  arDueUtcHour: Number(process.env.SENTINEL_AR_DUE_UTC_HOUR || 11),
  arGraceMin: Number(process.env.SENTINEL_AR_GRACE_MIN || 20),
  dryRun: process.env.SENTINEL_DRY_RUN === "1",
};

/** HTTP liveness targets. Down here means "did not answer", not "process missing". */
const TARGETS = (() => {
  const raw = process.env.SENTINEL_HTTP_TARGETS;
  if (raw) {
    // name=url,name=url
    return raw.split(",").map((e) => {
      const [name, ...rest] = e.split("=");
      return { name: name.trim(), url: rest.join("=").trim() };
    }).filter((t) => t.name && t.url);
  }
  return [
    { name: "gateway", url: "http://isolagw_gateway:3000/healthz" },
    { name: "runtime", url: "http://isolart_runtime:3000/healthz" },
  ];
})();

const log = (level, event, fields = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: "isola-sentinel", event, ...fields }));

// ---------------------------------------------------------------------------
// alert state — so we notify on transition, not on every tick
// ---------------------------------------------------------------------------

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(CFG.statePath, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(CFG.statePath), { recursive: true });
    fs.writeFileSync(CFG.statePath, JSON.stringify(state));
  } catch (e) {
    log("error", "state_write_failed", { detail: e.message });
  }
}

// ---------------------------------------------------------------------------
// checks — each returns {key, ok, summary, detail}
// ---------------------------------------------------------------------------

/**
 * THE SIGNAL THAT WAS MISSING BOTH TIMES.
 * A row that is `reserved`/`in_progress` past the threshold is an accepted
 * delivery with no reply posted.
 */
async function checkStuckDeliveries() {
  const key = "stuck_delivery";
  if (!CFG.ledgerUrl) return { key, ok: true, summary: "ledger not configured", skipped: true };
  const client = new Client({ connectionString: CFG.ledgerUrl, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const { rows } = await client.query(
      `SELECT count(*)::int AS stuck,
              coalesce(max(extract(epoch from (now() - created_at)))::int, 0) AS oldest_s,
              min(conversation_id) AS a_conversation
         FROM delivery_ledger
        WHERE action_type = 'delivery'
          AND delivery_state IN ('reserved','in_progress')
          AND created_at < now() - ($1 || ' milliseconds')::interval`,
      [String(CFG.stuckDeliveryMs)],
    );
    const r = rows[0];
    if (r.stuck > 0) {
      return {
        key,
        ok: false,
        summary: `${r.stuck} accepted deliver${r.stuck === 1 ? "y" : "ies"} with no reply posted (oldest ${r.oldest_s}s)`,
        detail:
          `A customer message was accepted and nothing was sent back.\n` +
          `Oldest waiting: ${r.oldest_s}s. Example conversation: ${r.a_conversation ?? "n/a"}.\n\n` +
          `This is the signal that was absent during both previous outages: every\n` +
          `container was up and healthy while customers got silence.`,
      };
    }
    return { key, ok: true, summary: "no stuck deliveries" };
  } catch (e) {
    return { key: "ledger_unreachable", ok: false, summary: `delivery ledger unreachable: ${e.message}`,
      detail: "The sentinel cannot read delivery_ledger, so it CANNOT see a stalled reply. Treat as blind, not healthy." };
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkHttp(target) {
  const key = `down_${target.name}`;
  try {
    const res = await fetch(target.url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      return { key, ok: false, summary: `${target.name} answered HTTP ${res.status}`, detail: `GET ${target.url}` };
    }
    return { key, ok: true, summary: `${target.name} ok` };
  } catch (e) {
    return { key, ok: false, summary: `${target.name} did not answer (${e.name})`, detail: `GET ${target.url}` };
  }
}

/**
 * Expected-output-absent for the receivables agent. Silence from a scheduled job
 * is indistinguishable from success unless someone checks for the artefact.
 */
async function checkReceivablesOutput() {
  const key = "ar_run_missing";
  if (!CFG.paperclipBaseUrl || !CFG.paperclipToken || !CFG.paperclipCompanyId) {
    return { key, ok: true, summary: "paperclip not configured", skipped: true };
  }
  const now = new Date();
  const dow = now.getUTCDay();
  if (dow === 0 || dow === 6) return { key, ok: true, summary: "weekend; no run expected" };
  const dueMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), CFG.arDueUtcHour, 0, 0)
    + CFG.arGraceMin * 60_000;
  if (now.getTime() < dueMs) return { key, ok: true, summary: "not due yet today" };

  const today = now.toISOString().slice(0, 10);
  const title = `AR action list — ${today}`;
  try {
    const res = await fetch(`${CFG.paperclipBaseUrl}/api/companies/${CFG.paperclipCompanyId}/issues`, {
      headers: { Authorization: "Bearer " + CFG.paperclipToken },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { key, ok: false, summary: `cannot check for the AR action list (HTTP ${res.status})` };
    const issues = await res.json();
    const found = (issues || []).some((i) => i.title === title);
    if (found) return { key, ok: true, summary: "AR action list published" };
    return {
      key,
      ok: false,
      summary: `the receivables action list for ${today} was not published`,
      detail:
        `Expected a Paperclip issue titled "${title}" by ${CFG.arDueUtcHour}:${String(CFG.arGraceMin).padStart(2, "0")} UTC.\n` +
        `Check: journalctl -u isola-ar-run.service -n 50 (on host03).\n` +
        `Exit 3 there means the traceability gate fired — the figures published are\n` +
        `still computed, not generated. Exit 1 means nothing was published.`,
    };
  } catch (e) {
    return { key, ok: false, summary: `cannot check for the AR action list (${e.message})` };
  }
}

// ---------------------------------------------------------------------------
// delivery
// ---------------------------------------------------------------------------

/**
 * SMTP, not the SMTP2GO HTTP API.
 *
 * The value stored as SMTP2GO_API_KEY on this estate is 12 characters and is an
 * SMTP *password* — the HTTP API rejects it outright ("wasn't in the correct format
 * 'api-[A-Za-z0-9]{32}'"). Discovered by trying to send a real alert and reading the
 * 403, which is exactly why an alerting channel has to be fired on purpose before it
 * is believed.
 */
async function sendEmail(subject, body) {
  if (CFG.dryRun) {
    log("warn", "alert_dry_run", { subject, body: body.slice(0, 200) });
    return true;
  }
  if (!CFG.smtpHost || !CFG.smtpUser || !CFG.smtpPass || CFG.alertTo.length === 0) {
    log("error", "alert_undeliverable", {
      subject,
      reason: "SMTP host/user/pass or SENTINEL_ALERT_TO missing — the alert had nowhere to go",
    });
    return false;
  }
  try {
    const transport = nodemailer.createTransport({
      host: CFG.smtpHost,
      port: CFG.smtpPort,
      secure: CFG.smtpPort === 465,
      auth: { user: CFG.smtpUser, pass: CFG.smtpPass },
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 20_000,
    });
    const info = await transport.sendMail({
      from: CFG.alertFrom,
      to: CFG.alertTo.join(","),
      subject,
      text: body,
    });
    log("info", "alert_sent", { subject, to: CFG.alertTo.length, accepted: (info.accepted || []).length });
    return (info.accepted || []).length > 0;
  } catch (e) {
    log("error", "alert_send_failed", { subject, detail: e.message });
    return false;
  }
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

async function runOnce() {
  const results = [];
  results.push(await checkStuckDeliveries());
  results.push(await checkReceivablesOutput());
  for (const t of TARGETS) results.push(await checkHttp(t));

  const state = loadState();
  const now = Date.now();

  for (const r of results) {
    if (r.skipped) continue;
    const prev = state[r.key] || { ok: true, since: now, lastNotified: 0 };

    if (!r.ok) {
      const isNew = prev.ok;
      const stale = now - (prev.lastNotified || 0) > CFG.renotifyMs;
      if (isNew || stale) {
        const downFor = isNew ? 0 : Math.round((now - prev.since) / 1000);
        const subject = `[isola] ${isNew ? "" : "STILL "}${r.summary}`;
        const body =
          `${r.summary}\n\n${r.detail || ""}\n\n` +
          (isNew ? "" : `Failing for ${downFor}s.\n`) +
          `host03 · ${new Date().toISOString()}\n` +
          `This is isola-sentinel. It checks that replies actually get sent, not just that containers are up.`;
        const sent = await sendEmail(subject, body);
        state[r.key] = { ok: false, since: isNew ? now : prev.since, lastNotified: sent ? now : prev.lastNotified };
      } else {
        state[r.key] = { ...prev, ok: false };
      }
      log("error", "check_failed", { check: r.key, summary: r.summary });
    } else {
      if (!prev.ok) {
        const downFor = Math.round((now - prev.since) / 1000);
        await sendEmail(`[isola] RECOVERED — ${r.key}`, `${r.key} is healthy again after ${downFor}s.\n\n${r.summary}\nhost03 · ${new Date().toISOString()}`);
        log("info", "check_recovered", { check: r.key, downForS: downFor });
      }
      state[r.key] = { ok: true, since: prev.ok ? prev.since : now, lastNotified: 0 };
    }
  }
  saveState(state);
  const failing = results.filter((r) => !r.ok && !r.skipped).map((r) => r.key);
  log("info", "sweep", { checks: results.length, failing: failing.length, failingKeys: failing });
}

async function main() {
  log("info", "boot", {
    intervalMs: CFG.intervalMs,
    stuckDeliveryMs: CFG.stuckDeliveryMs,
    targets: TARGETS.map((t) => t.name),
    ledgerConfigured: Boolean(CFG.ledgerUrl),
    smtpConfigured: Boolean(CFG.smtpHost && CFG.smtpUser && CFG.smtpPass),
    alertRecipients: CFG.alertTo.length,
    dryRun: CFG.dryRun,
  });
  if (process.argv.includes("--once")) {
    await runOnce();
    return;
  }
  for (;;) {
    await runOnce().catch((e) => log("error", "sweep_failed", { detail: e.message }));
    await new Promise((r) => setTimeout(r, CFG.intervalMs));
  }
}

main().catch((e) => {
  log("error", "fatal", { detail: e.message });
  process.exit(1);
});
