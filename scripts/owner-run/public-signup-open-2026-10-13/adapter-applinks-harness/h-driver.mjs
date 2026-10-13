// h-driver.mjs - runs INSIDE the relay image on the isolated --internal network. Compares the DEPLOYED adapter (old) with the app-links candidate (new)
// across journey states, through the adapter's real MCP/HTTP surface with real relay-context + PL-assertion minting and the fake Chatwoot (world) as sink.
import fs from 'node:fs';
import { mintPlAssertion, mintRelayContext } from '/app/src/pl-concierge-assertion.js';
const R = (p) => fs.readFileSync(p, 'utf8').trim();
const PLK = R('/k/pl_key'), CTK = R('/k/ctx_key'), BEAR = R('/k/adapter_bearer');
const WORLD = 'http://world-n:3000';
const WS = '2a62ca68-5d6b-41bd-aea5-28a0aaba7fc8', AG = '28a55c69-ef04-416f-9c91-7d72e9e21345', SLUG = 'acceptance-workspace--personal-line-whatsapp-concierge', PNID = '1023804347491554';
const IOS = 'https://apps.apple.com/us/app/cloud-softphone/id567475545', AND = 'https://play.google.com/store/apps/details?id=cz.acrobits.softphone.cloudphone';
const j = async (u, o) => { const r = await fetch(u, o); let b = {}; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (id, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ' :: ' + detail : ''}`); };
const inbound = async (wa, content) => (await j(WORLD + '/__inbound', { method: 'POST', body: JSON.stringify({ wa, content }) })).body;
function ctx(o) {
  const now = Math.floor(Date.now() / 1000);
  const pl = mintPlAssertion({ key: PLK, kid: 'pl2', waId: o.wa, phoneNumberId: PNID, conversationId: String(o.conv), messageId: String(o.msg), nowSec: now });
  return mintRelayContext({ key: CTK, kid: 'ctx1', accountId: 2, inboxId: 11, workspaceId: WS, agentId: AG, agentSlug: SLUG, sessionId: 'accept-session', uplinkConversationId: null, chatwootConversationId: String(o.conv), chatwootMessageId: String(o.msg), message: o.message, originalMessage: null, plAssertion: pl, nowSec: now });
}
async function tool(base, token, name, args = {}) {
  const r = await j(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + BEAR }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { 'com.epic.uplink/relay-context-v1': token } } }) });
  return { isError: r.body?.result?.isError === true, text: r.body?.result?.content?.[0]?.text || JSON.stringify(r.body).slice(0, 300) };
}
let waSeq = 17670001000;
async function tap(base, content) {   // one customer message -> /v1/action auto -> the adapter's reply as stored in the fake Chatwoot
  const wa = String(waSeq++); const p = await inbound(wa, content);
  return { wa, p };
}
async function actionSeq(base, wa, steps) {
  const outs = [];
  for (const content of steps) {
    const p = await inbound(wa, content);
    const r = await j(base + '/v1/action', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + BEAR }, body: JSON.stringify({ action: 'auto', context: ctx({ wa, conv: p.conversation.id, msg: p.id, message: content }) }) });
    await sleep(400);
    const m = await j(`${WORLD}/api/v1/accounts/2/conversations/${p.conversation.id}/messages`);
    const last = (m.body.payload || []).filter((x) => x.message_type === 1 && !x.private).at(-1) || {};
    outs.push({ content, code: r.body.code, action: r.body.action, text: last.content || '', items: (last.content_attributes?.items || []).map((i) => i.title) });
  }
  return outs;
}
const STATES = [['active', 'ad-old-active', 'ad-new-active'], ['registered_no_call', 'ad-old-regnc', 'ad-new-regnc'], ['setup_not_activated', 'ad-old-setup', 'ad-new-setup'], ['no_line', 'ad-old-noline', 'ad-new-noline']];
const HAS_APP = new Set(['active', 'registered_no_call']);
(async () => {
  console.log('=== A. pl_guide facts (what the AGENT sees), old vs new, per journey state ===');
  for (const [state, oldH, newH] of STATES) for (const topic of ['calling_help', 'how_to_call', 'call_failed']) {
    const res = {};
    for (const [ver, host] of [['old', oldH], ['new', newH]]) {
      const wa = String(waSeq++); const content = 'Calling help'; const p = await inbound(wa, content);
      const t = await tool(`http://${host}:9101`, ctx({ wa, conv: p.conversation.id, msg: p.id, message: content }), 'pl_guide', { topic });
      let f = null; try { f = JSON.parse(t.text); } catch {}
      res[ver] = { t, f };
    }
    const o = res.old.f, n = res.new.f;
    const hasLine = state !== 'no_line';
    check(`A ${state}/${topic}: both adapters answered with facts (instrument sanity)`, !!o && !!n && !res.old.t.isError && !res.new.t.isError, res.new.t.text.slice(0, 80));
    if (!o || !n) continue;
    check(`A ${state}/${topic}: CONTROL old adapter has NO app fact`, o.app === undefined);
    if (hasLine) {
      const want = state === 'setup_not_activated';
      check(`A ${state}/${topic}: new facts.app present, install_needed=${want}`, n.app && n.app.install_needed === want && n.app.ios_url === IOS && n.app.android_url === AND && /ONLY when install_needed/.test(n.app.note), JSON.stringify(n.app || null).slice(0, 160));
      const rest = (x) => JSON.stringify({ ...x, app: undefined });
      check(`A ${state}/${topic}: nothing else in the facts changed (same as old)`, rest(o) === rest(n));
    } else check(`A ${state}/${topic}: no line -> no account-specific app fact (unchanged answer)`, n.app === undefined && JSON.stringify(o) === JSON.stringify(n));
  }
  console.log('=== B. deterministic menu path (taps) for states that offer Calling help ===');
  for (const [state, oldH, newH] of STATES.filter(([s]) => HAS_APP.has(s))) {
    const seqs = {};
    for (const [ver, host] of [['old', oldH], ['new', newH]]) seqs[ver] = await actionSeq(`http://${host}:9101`, String(waSeq++), ['menu', 'How it works', 'Calling help', 'Call Dominica', 'A call failed']);
    const o = seqs.old, n = seqs.new;
    check(`B ${state}: both paths ran every step (positive control: every step handled)`, [...o, ...n].every((s) => s.code === 'handled'), [...o, ...n].map((s) => s.code).join(','));
    const offered = n[1].items.includes('Calling help'); check(`B ${state}: the previous message offered 'Calling help' (tap resolvable)`, offered, n[1].items.join('|'));
    check(`B ${state}: OLD calling-help menu text is the deployed one`, o[2].text === 'Happy to help with calling. What do you need?', o[2].text.slice(0, 80));
    check(`B ${state}: NEW calling-help menu names the app, no links (app already set up)`, /Cloud Softphone/.test(n[2].text) && !n[2].text.includes('apps.apple') && !n[2].text.includes('play.google') && /What do you need\?/.test(n[2].text), n[2].text.replace(/\n/g, ' / ').slice(0, 150));
    check(`B ${state}: NEW 'Call Dominica' answer identical to deployed (no links when installed)`, o[3].text === n[3].text, n[3].text.slice(0, 60));
    check(`B ${state}: NEW 'A call failed' answer identical to deployed (connected)`, o[4].text === n[4].text, n[4].text.slice(0, 60));
  }
  console.log(`\nSUMMARY: ${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('DRIVER ERROR', e.message); process.exit(2); });
