// zz-acct2 PRODUCTION READ-ONLY cross-check of the accepted walk line (...5099, Magnus user 614). Runs INSIDE plsvc-prod-host03.
// READS ONLY: (A) plsvc's own concierge READ endpoints (line-status, balance, journey) via loopback with a minted assertion;
// (B) Magnus REST module/read (user, sip, offer, offerUse, offerCdr, call); (C) Odoo search_read on the AUTHORITATIVE host only.
// Credentials are read from the process env in-process and never printed. Digits masked to the last 4. No write/create/unlink anywhere.
// Side effect to declare: each concierge read endpoint writes its own pl_concierge_audit row (the same as any read by the concierge).
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';

const fileEnv = (() => { try { const m = {}; for (const l of readFileSync('/app/.env', 'utf8').split(/\r?\n/)) { const x = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (x) m[x[1]] = x[2].trim().replace(/^["']|["']$/g, ''); } return m; } catch { return {}; } })();
// The running service's OWN effective env is PID 1's (an entrypoint may export values a `docker exec` shell does not inherit):
// precedence = PID 1 environ, then this exec's env, then /app/.env (which Next loads WITHOUT overriding existing variables).
const pid1Env = (() => { try { const m = {}; for (const kv of readFileSync('/proc/1/environ', 'utf8').split('\0')) { const i = kv.indexOf('='); if (i > 0) m[kv.slice(0, i)] = kv.slice(i + 1); } return m; } catch { return {}; } })();
const E = (k) => pid1Env[k] ?? process.env[k] ?? fileEnv[k] ?? '';
const mask = (s) => String(s ?? '').replace(/(\d{3,})(\d{4})/g, '***$2');
const WA = process.argv[2];            // wa_id of the walk line owner (fixture 14158408440)
const MUSER = process.argv[3];         // Magnus user id (614)
const out = {};

// ---------- (A) plsvc concierge read endpoints ----------
{
  const kid = E('PL_ASSERTION_KID'), key = E('PL_ASSERTION_HMAC_KEY'), pnid = E('PL_CONCIERGE_PNID_ALLOWLIST').split(',')[0].trim();
  out.assertion_config = { kid_present: !!kid, key_present: key.length >= 32, pnid_present: !!pnid, port: E('PORT') || '3000' };
  const b64 = (b) => Buffer.from(b).toString('base64url');
  const post = async (ep) => {
    const rid = 'zzacct2-ro-' + crypto.randomBytes(6).toString('hex');
    const p = b64(JSON.stringify({ kid, wa_id: WA, pnid, rid, mid: 'zzacct2-' + crypto.randomBytes(4).toString('hex'), iat: Math.floor(Date.now() / 1000), nonce: b64(crypto.randomBytes(16)) }));
    const sig = crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update('v1.' + p, 'utf8').digest('base64url');
    const r = await fetch(`http://127.0.0.1:${E('PORT') || '3000'}/api/internal/pl-concierge/v1/${ep}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-isola-assertion': `v1.${p}.${sig}`, 'x-conversation-id': rid }, body: '{}' });
    const j = await r.json().catch(() => null);
    return { http: r.status, code: j?.code, data: j?.data ?? null };
  };
  if (process.argv[6] === 'noengine') out.engine = 'not re-run (already read; each endpoint read writes an audit row)';
  else if (kid && key.length >= 32 && pnid) {
    const ls = await post('account/line-status'), bal = await post('account/balance'), jr = await post('account/journey');
    out.engine = {
      line_status: { http: ls.http, code: ls.code, did: mask(ls.data?.did_pretty), registration: ls.data?.registration, listener_connected: ls.data?.listener_connected, softphone_activated: ls.data?.softphone_activated, first_call_done: ls.data?.first_call_done, plan: ls.data?.plan, plan_expires_at: ls.data?.plan_expires_at, next_step: ls.data?.next_step },
      balance: { http: bal.http, code: bal.code, known: bal.data?.known, kind: bal.data?.kind, plan: bal.data?.plan, minutes_included: bal.data?.minutes_included, minutes_remaining: bal.data?.minutes_remaining, wallet_xcd: bal.data?.wallet_xcd, expires_at: bal.data?.expires_at },
      journey: { http: jr.http, state: jr.data?.state, registration: jr.data?.facts?.registration, minutes_remaining: jr.data?.facts?.minutes_remaining, wallet_xcd: jr.data?.facts?.wallet_xcd },
    };
  } else out.engine = 'SKIPPED: assertion config not readable in this container';
}

// ---------- (B) Magnus REST reads ----------
const URLB = process.argv[5] || E('MAGNUS_URL') || 'https://voice00.epic.dm/mbilling', KEY = E('MAGNUS_API_KEY'), SEC = E('MAGNUS_API_SECRET');
out.magnus_host = (() => { try { return new URL(URLB).host; } catch { return '?'; } })();
const php = (s) => encodeURIComponent(String(s)).replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, '+');
async function mread(module, filterArr, limit = '100') {
  const mt = process.hrtime(); const nonce = mt[0].toString() + String(mt[1]).padStart(9, '0').slice(0, 6);
  const body = Object.entries({ module, action: 'read', nonce, page: '1', start: '0', limit, filter: JSON.stringify(filterArr) }).map(([k, v]) => php(k) + '=' + php(v)).join('&');
  try {
    const FORCE_IP = process.argv[7];
    if (FORCE_IP) {
      // same request, but the TCP connection is pinned to a given IP (SNI/Host stay the URL's host): tests which Magnus host answers
      const u = new URL(`${URLB}/index.php/${module}/read`);
      const resp = await new Promise((res, rej) => { const rq = https.request({ host: u.hostname, servername: u.hostname, port: 443, path: u.pathname, method: 'POST', lookup: (h, o, cb) => (o && o.all ? cb(null, [{ address: FORCE_IP, family: 4 }]) : cb(null, FORCE_IP, 4)), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Key: KEY, Sign: crypto.createHmac('sha512', SEC).update(body).digest('hex'), 'Content-Length': Buffer.byteLength(body) }, timeout: 15000 }, (x) => { let t = ''; x.on('data', (c) => { t += c; }); x.on('end', () => res({ status: x.statusCode, text: t })); }); rq.on('error', rej); rq.on('timeout', () => rq.destroy(new Error('timeout'))); rq.write(body); rq.end(); });
      let j = null; try { j = JSON.parse(resp.text); } catch {}
      (out.magnus_debug ??= []).length < 3 && out.magnus_debug.push({ module, forced_ip: FORCE_IP, http: resp.status, status: j?.status, message: String(j?.message ?? '').slice(0, 100), rows: Array.isArray(j?.rows) ? j.rows.length : null });
      return j?.rows ?? null;
    }
    const r = await fetch(`${URLB}/index.php/${module}/read`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Key: KEY, Sign: crypto.createHmac('sha512', SEC).update(body).digest('hex') }, body, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => null);
    (out.magnus_debug ??= []).length < 3 && out.magnus_debug.push({ module, http: r.status, keys: j ? Object.keys(j).slice(0, 8) : null, status: j?.status, message: String(j?.message ?? '').slice(0, 100), count: j?.count ?? j?.total, rows: Array.isArray(j?.rows) ? j.rows.length : null });
    return j?.rows ?? null;
  } catch (e) { out.magnus_error = String(e?.cause?.code || e?.message).slice(0, 80); return null; }
}
const eq = (field, value) => ({ type: 'numeric', field, value: String(value), comparison: 'eq' });
const only = (rows, f, v) => (rows ?? []).filter((x) => String(x[f]) === String(v));
if (KEY && SEC) {
  const user = only(await mread('user', [eq('id', MUSER)]), 'id', MUSER)[0];
  out.magnus_user = user ? { id: user.id, username: mask(user.username), active: user.active, credit: user.credit, id_offer: user.id_offer, id_plan: user.id_plan, creditlimit: user.creditlimit } : 'NO ROW';
  const sips = only(await mread('sip', [eq('id_user', MUSER)]), 'id_user', MUSER);
  out.magnus_sip = sips.map((s) => ({ name: s.name, lineStatus: s.lineStatus, host: s.host ? 'set' : '' }));
  const uses = only(await mread('offerUse', [eq('id_user', MUSER)]), 'id_user', MUSER);
  out.magnus_offerUse = uses.map((u) => ({ id_offer: u.id_offer, status: u.status, reservationdate: u.reservationdate, releasedate: u.releasedate }));
  const active = uses.filter((u) => String(u.status) === '1' && String(u.releasedate) === '0000-00-00 00:00:00');
  if (active.length === 1) {
    const oid = active[0].id_offer;
    const offer = only(await mread('offer', [eq('id', oid)]), 'id', oid)[0];
    out.magnus_offer = offer ? { id: offer.id, name: offer.name, packagetype: offer.packagetype, billingtype: offer.billingtype, freetimetocall_s: offer.freetimetocall } : 'NO ROW';
    const cdrs = only(only(await mread('offerCdr', [eq('id_user', MUSER)]), 'id_user', MUSER), 'id_offer', oid);
    out.magnus_offerCdr = { rows: cdrs.length, rows_detail: cdrs.map((c) => ({ date_consumption: c.date_consumption, used_secondes: c.used_secondes })) };
    // independent recomputation of "minutes left" using plsvc's documented cycle rule (billingtype 0 = monthly from DAY(reservationdate))
    try {
      const allowance = Number(offer.freetimetocall), bt = Number(offer.billingtype);
      const res = /^(\d{4})-(\d{2})-(\d{2})/.exec(active[0].reservationdate);
      const now = new Date(Date.now() - 5 * 3600e3); // Magnus wall clock (UTC-5), as in lite-line-balance.ts
      const today = { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() };
      let cycle = null;
      if (bt === 0) { let sd = Number(res[3]); const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); if (sd > dim(today.y, today.m)) sd = dim(today.y, today.m); if (sd <= 0) sd = 1; let y = today.y, m = today.m; if (sd > today.d) { m -= 1; if (m === 0) { m = 12; y -= 1; } } cycle = `${y}-${String(m).padStart(2, '0')}-${String(sd).padStart(2, '0')} 00:00:00`; }
      const used = cdrs.filter((c) => String(c.date_consumption) >= (cycle ?? '9999')).reduce((a, c) => a + Number(c.used_secondes || 0), 0);
      out.independent_minutes = { billingtype: bt, cycle_start: cycle, allowance_s: allowance, used_s: used, remaining_min: cycle ? Math.floor(Math.max(0, allowance - used) / 60) : 'n/a (weekly cycle not recomputed here)' };
    } catch (e) { out.independent_minutes = 'error ' + String(e.message).slice(0, 80); }
  } else out.magnus_offer = `active offerUse rows: ${active.length}`;
  const calls = only(await mread('call', [eq('id_user', MUSER)]), 'id_user', MUSER);
  out.magnus_pkg_cdr = { rows: calls.length, answered: calls.filter((c) => Number(c.sessiontime) > 0).length, calls: calls.slice(0, 6).map((c) => ({ starttime: c.starttime, calledstation: mask(c.calledstation), sessiontime: c.sessiontime, sessionbill: c.sessionbill })) };
  const ctl = await mread('did', [{ type: 'numeric', field: 'activated', value: '1', comparison: 'eq' }], '1');
  out.control_magnus_reads_work = Array.isArray(ctl) && ctl.length > 0;
} else out.magnus = 'SKIPPED: key/secret not present';

// ---------- (C) Odoo (authoritative host only) ----------
{
  const url = E('ODOO_URL'), db = E('ODOO_DB'), uid = Number(E('ODOO_UID')), key = E('ODOO_API_KEY');
  const host = (() => { try { return new URL(url).host; } catch { return ''; } })();
  out.odoo_host = host;
  const PARTNER = process.argv[4];
  if (host !== 'epic-communications-inc.odoo.com') out.odoo = 'STOP: not the authoritative Odoo (or env unreadable)';
  else {
    let n = 0;
    const call = async (model, method, args, kw = {}) => { const r = await fetch(url.replace(/\/+$/, '') + '/jsonrpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'call', id: ++n, params: { service: 'object', method: 'execute_kw', args: [db, uid, key, model, method, args, kw] } }) }); const j = await r.json(); if (j.error) throw new Error(`${model}.${method}: ${j.error.data?.message || j.error.message}`); return j.result; };
    let partnerIds = PARTNER ? [Number(PARTNER)] : [];
    if (!PARTNER) {
      // The account row carries no odooPartnerId: look the customer up by the walk number's last 7 digits (read-only search).
      try {
        const hits = await call('res.partner', 'search_read', [[['phone', 'ilike', '8408440']]], { fields: ['id'], limit: 5, context: { active_test: false } });
        partnerIds = hits.map((h) => h.id);
        out.odoo_lookup = `no odooPartnerId on the account; partners matching the number's last 7 digits: ${partnerIds.length}`;
      } catch (e) { out.odoo_lookup = 'search error: ' + String(e.message).slice(0, 120); }
    }
    for (const pid of partnerIds) { try {
      const PARTNER = pid;
      const pr = await call('res.partner', 'read', [[Number(PARTNER)]], { fields: ['id', 'name', 'active', 'currency_id', 'customer_rank'] });
      (out.odoo_partner ??= []).push(...pr.map((p) => ({ id: p.id, name_len: String(p.name || '').length, active: p.active, currency: p.currency_id ? p.currency_id[1] : null, customer_rank: p.customer_rank })));
      const mv = await call('account.move', 'search_read', [[['partner_id', '=', Number(PARTNER)], ['move_type', 'in', ['out_invoice', 'out_refund']]]], { fields: ['name', 'state', 'payment_state', 'currency_id', 'amount_total', 'amount_residual', 'invoice_date'], limit: 50, order: 'id desc' });
      const byCur = {};
      for (const m of mv) { const c = m.currency_id ? m.currency_id[1] : '?'; (byCur[c] ??= { n: 0, total: 0, residual: 0 }); byCur[c].n++; byCur[c].total += m.amount_total; byCur[c].residual += m.amount_residual; }
      (out.odoo_invoices ??= []).push({ count: mv.length, per_currency_never_summed_across: byCur, rows: mv.slice(0, 5).map((m) => ({ name: m.name, state: m.state, payment_state: m.payment_state, cur: m.currency_id ? m.currency_id[1] : null, total: m.amount_total, residual: m.amount_residual, date: m.invoice_date })) });
    } catch (e) { out.odoo = 'read error: ' + String(e.message).slice(0, 160); } }
    // control: the ledger is readable at all (any posted customer invoice exists)
    try { out.control_odoo_reads_work = (await call('account.move', 'search_count', [[['move_type', '=', 'out_invoice'], ['state', '=', 'posted']]])) > 0; } catch (e) { out.control_odoo_reads_work = 'error ' + String(e.message).slice(0, 80); }
  }
}
console.log(JSON.stringify(out, null, 1));
