// m-driver.mjs - runs INSIDE a relay container (isolated --internal network). Joint acceptance of relay rc10m vs the deployed rc10l: real relay code, the deployed adapter (796f0286),
// Uplink's REAL relay-context verifier, a stand-in Uplink engine with request-size refusal modes, a fake Chatwoot (delivery sink) and a canned PL service whose call counter is the audit-row analog.
// Expectations flip by LABEL: rc10l = the deployed relay (positive control that the OLD behaviour is a handoff); rc10m = the candidate.
import crypto from 'node:crypto'; import fs from 'node:fs';
const R = (p) => fs.readFileSync(p, 'utf8').trim(); const BOT = R('/relay/cw_bot_secret');
const WORLD = 'http://world-m:3000', ENGINE = 'http://engine-m:3000', PLSTUB = 'http://plstub-m:3300', K1 = 'http://127.0.0.1:3020';
const NEW = (process.env.LABEL || '').startsWith('rc10m');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (u, o) => { const r = await fetch(u, o); let b = {}; try { b = await r.json(); } catch {} return b; };
let pass = 0, fail = 0; const check = (id, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${d ? ' :: ' + d : ''}`); };
const sign = (raw, ts) => 'sha256=' + crypto.createHmac('sha256', BOT).update(`${ts}.`).update(raw).digest('hex');
const hook = async (p) => { const raw = JSON.stringify(p), ts = Math.floor(Date.now() / 1000); return j(K1 + '/v1/chatwoot/agent-bot', { method: 'POST', headers: { 'content-type': 'application/json', 'x-chatwoot-timestamp': String(ts), 'x-chatwoot-signature': sign(raw, ts) }, body: raw }); };
const stats = () => j(ENGINE + '/__stats'); const calls = async () => Number(await (await fetch(PLSTUB + '/__calls')).text());
const admin = (mode) => j(ENGINE + '/__admin', { method: 'POST', body: JSON.stringify({ mode }) });
const inbound = (wa, content) => j(WORLD + '/__inbound', { method: 'POST', body: JSON.stringify({ wa, content }) });
const setPending = (c) => j(`${WORLD}/api/v1/accounts/2/conversations/${c}/toggle_status`, { method: 'POST', body: JSON.stringify({ status: 'pending' }) });
let seq = NEW ? 17680005000 : 17680000100;   // disjoint customers per label so the two runs never share a conversation
async function turn(wa, content, { prime = null } = {}) {
  if (prime) await admin(prime);
  const p = await inbound(wa, content); const conv = p.conversation.id; await setPending(conv);
  const s0 = await stats(), c0 = await calls(); await hook(p); await sleep(6000);
  const s1 = await stats(), c1 = await calls(); const m = (await j(`${WORLD}/api/v1/accounts/2/conversations/${conv}/messages`)).payload || [];
  const pub = m.filter((x) => x.message_type === 1 && !x.private), priv = m.filter((x) => x.private);
  const upl = s1.conversations.filter((c) => String(c.chatwoot) === String(conv)).length;
  return { conv, pub, priv, handoff: priv.some((x) => /Relay handoff/.test(x.content)), teammate: pub.some((x) => /bring in a teammate/.test(x.content)), d: { accepted: s1.accepted - s0.accepted, size: (s1.sizeRefusals || 0) - (s0.sizeRefusals || 0), plCalls: c1 - c0, toolOk: s1.toolOk - s0.toolOk }, upl };
}
async function prepared(content = 'Hello, is my line working?') { const wa = String(seq++); const t = await turn(wa, content); return { wa, t }; }
(async () => {
  console.log(`=== relay under test: ${process.env.LABEL} (${NEW ? 'candidate' : 'deployed = positive control for the OLD handoff'}) ===`);
  // S0 sanity: an ordinary turn is answered
  const s0 = await prepared(); const b0 = s0.t.d.plCalls; check('S0 ordinary turn answered, no handoff (instrument sanity)', !s0.t.handoff && s0.t.pub.length === 1 && s0.t.d.accepted === 1, `pub=${s0.t.pub.length} accepted=${s0.t.d.accepted}`);
  // S1 size refusal before any tool ran
  { const { wa } = await prepared(); const t = await turn(wa, 'Is my phone connected?', { prime: 'size_next' });
    if (NEW) { check('S1 over-cap turn is ANSWERED via ONE rotation (no handoff, one reply, no teammate text)', !t.handoff && !t.teammate && t.pub.length === 2 && t.upl === 2, `handoff=${t.handoff} pub=${t.pub.length} uplink convs=${t.upl} size refusals=${t.d.size}`); check('S1 the rotated turn ran the read tool exactly like a normal turn (plsvc calls equal the baseline of an ordinary turn)', t.d.plCalls === b0, `plCalls=${t.d.plCalls} baseline=${b0}`);
      const t2 = await turn(wa, 'And how many minutes do I have?'); check('S1b the NEXT message continues in the NEW Uplink conversation (binding replaced only after acceptance): no third conversation', t2.upl === 2 && !t2.handoff, `uplink convs=${t2.upl}`); }
    else check('S1 (control) deployed relay HANDS OFF on the same refusal: private note + teammate text, no rotation', t.handoff && t.teammate && t.upl === 1, `handoff=${t.handoff} teammate=${t.teammate} uplink convs=${t.upl}`); }
  // S2 genuine non-size failure still hands off, no retry (both)
  { const { wa } = await prepared(); const t = await turn(wa, 'How long is the trial?', { prime: 'genuine503_next' }); check('S2 CONTROL genuine 503 (pilot unavailable) hands off, no retry', t.handoff && t.upl === 1, `handoff=${t.handoff} uplink convs=${t.upl} accepted=${t.d.accepted}`); }
  // S3 other degraded reason hands off, no retry (both)
  { const { wa } = await prepared(); const t = await turn(wa, 'Tell me about plans', { prime: 'llmnc_next' }); check('S3 CONTROL other degraded reason (llm_not_configured) hands off, no retry', t.handoff && t.upl === 1, `handoff=${t.handoff} uplink convs=${t.upl}`); }
  // S4 the rotated retry is ALSO refused
  { const { wa } = await prepared(); const t = await turn(wa, 'Is my phone connected?', { prime: 'size_always' }); await admin('normal');
    check(NEW ? 'S4 rotated retry also too large -> handed off ONCE (bounded: exactly two attempts, no loop)' : 'S4 (control) deployed relay: one attempt then handoff', t.handoff && t.d.size === (NEW ? 2 : 1), `handoff=${t.handoff} size refusals=${t.d.size}`); }
  // S5 guard: refusal AFTER a tool delivered a customer message (balance)
  { const base = await prepared(); const bt = await turn(base.wa, 'what is my balance'); const bn = bt.d.plCalls;       // baseline: an ordinary balance turn (journey + balance reads)
    const { wa } = await prepared(); const t = await turn(wa, 'what is my balance', { prime: 'size_after_tools' });
    const bal = t.pub.filter((x) => /minutes|balance|included/i.test(x.content)).length;
    check('S5 GUARD size refusal AFTER the balance message was delivered: NOT retried, handed off; exactly ONE balance message reached the customer (no duplicate)', t.handoff && t.upl === 1 && bal === 1, `handoff=${t.handoff} uplink convs=${t.upl} balance messages=${bal}`);
    check('S5b no side-effecting tool was re-run: plsvc call count for the refused turn equals an ordinary balance turn (the first attempt only)', t.d.plCalls === bn, `plCalls=${t.d.plCalls} baseline=${bn}`); }
  // S6 guard: bare "1" is never auto-retried
  { const { wa } = await prepared(); const t = await turn(wa, '1', { prime: 'size_next' }); check('S6 GUARD a bare "1" (offer confirmation) is never auto-retried: handed off, no second Uplink conversation', t.handoff && t.upl === 1, `handoff=${t.handoff} uplink convs=${t.upl}`); }
  // S7 the existing turn-limit rotation is unchanged
  { const wa = String(seq++); let last; for (let i = 1; i <= 6; i++) last = await turn(wa, `message number ${i}`); check('S7 CONTROL 6th message trips the 5-turn limit and rotates (unchanged), answered, no handoff', !last.handoff && last.upl === 2 && last.pub.length === 6, `handoff=${last.handoff} uplink convs=${last.upl} replies=${last.pub.length}`); }
  console.log(`\nSUMMARY ${process.env.LABEL}: ${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('DRIVER ERROR', e.message); process.exit(2); });
