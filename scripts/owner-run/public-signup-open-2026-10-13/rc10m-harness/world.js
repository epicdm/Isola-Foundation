// zz-world-sim.js - ISOLATED STAGING ONLY. One fake "world" that stands in for Chatwoot + the Uplink agent API (+ the Meta/WhatsApp edge by counting).
// Nothing here talks to anything real. It is the DELIVERY SINK: every customer-visible Chatwoot post (non-private outgoing message) is counted.
//   GET  /__sink                    counters
//   POST /__inbound {wa, content, wamid?}   appends a customer message to that customer's conversation, returns the Chatwoot-style webhook payload
//   POST /__reset                   clears posts only (customers and conversations stay)
// Uplink guard emulation (read from packages/crm/src/lib/api/guard.ts @ da08b734): a Bearer that starts with wst_ AND equals the staging token resolves; a
// non-wst_ bearer falls through to the legacy x-api-key mode and answers 401 {error:"Unauthorized"} (exactly what the owner's second token produced).
const http = require('http');
const GOOD_WST = process.env.WORLD_GOOD_WST;            // fake staging wst_ token (not a credential)
const ORG = '2a62ca68-5d6b-41bd-aea5-28a0aaba7fc8', AGENT = '28a55c69-ef04-416f-9c91-7d72e9e21345';
const now = () => Math.floor(Date.now() / 1000);
const contacts = new Map();            // wa -> {id, conv}
const convs = new Map();               // convId -> {id, contact_id, status, custom_attributes, messages[], team, assignee}
const posts = [];                      // customer-visible
const privates = [];
const uplink = new Map();              // uplink conversation id -> {sessionId, channelMeta, turns[]}
let mid = 9000, cid = 100, kid = 500, uid = 0, authCalls = { ok: 0, unauthorized: 0 };
const json = (rs, code, o) => { rs.writeHead(code, { 'content-type': 'application/json' }); rs.end(JSON.stringify(o)); };
const body = async (rq) => { let raw = ''; for await (const ch of rq) raw += ch; try { return JSON.parse(raw || '{}'); } catch { return {}; } };
function customer(wa) {
  if (!contacts.has(wa)) { const c = { id: ++kid, conv: ++cid, wa }; contacts.set(wa, c); convs.set(c.conv, { id: c.conv, contact_id: c.id, status: 'pending', custom_attributes: {}, messages: [], team: null, assignee: null }); }
  return contacts.get(wa);
}
const convView = (v) => ({ id: v.id, account_id: 2, inbox_id: 11, status: v.status, contact_id: v.contact_id, meta: { sender: { id: v.contact_id }, ...(v.assignee ? { assignee: { id: v.assignee } } : {}), ...(v.team ? { team: { id: v.team } } : {}) }, custom_attributes: v.custom_attributes });
http.createServer(async (rq, rs) => {
  const u = new URL(rq.url, 'http://x'), p = u.pathname;
  if (p === '/__sink') return json(rs, 200, { posts: posts.length, privates: privates.length, byConversation: posts.reduce((a, x) => { a[x.conv] = (a[x.conv] || 0) + 1; return a; }, {}), last: posts.slice(-4).map((x) => ({ conv: x.conv, len: x.len, text: x.text })), auth: authCalls });
  if (p === '/__reset') { posts.length = 0; privates.length = 0; return json(rs, 200, { ok: true }); }
  if (p === '/__inbound') {
    const b = await body(rq); const c = customer(String(b.wa)); const v = convs.get(c.conv);
    const m = { id: ++mid, content: b.content, message_type: 0, private: false, sender_type: 'Contact', sender: { type: 'contact', id: c.id }, source_id: b.wamid || ('wamid.STAGE' + Math.random().toString(36).slice(2, 14).toUpperCase()), created_at: now() };
    v.messages.push(m);
    return json(rs, 200, { event: 'message_created', id: m.id, content: m.content, message_type: 'incoming', private: false, source_id: m.source_id, sender: { id: c.id, name: 'Stage Customer' }, account: { id: 2 }, inbox: { id: 11 }, conversation: { id: v.id, status: v.status, meta: { sender: { id: c.id } } } });
  }
  // ---- Uplink (public turn + authenticated readback) ----
  let r;
  if (rq.method === 'POST' && (r = /^\/api\/v1\/public\/agent\/([^/]+)\/turn$/.exec(p))) {
    const b = await body(rq); const id = b.conversation_id || ('uplink-conv-' + (++uid));
    const st = uplink.get(id) || { sessionId: b.anonymous_session_id, channelMeta: b.channel_meta, turns: [] }; uplink.set(id, st);
    st.turns.push({ role: 'user', content: b.message }); st.turns.push({ role: 'assistant', content: 'Staging agent reply (canned).', toolCalls: [], toolResults: [] });
    return json(rs, 200, { message: 'Staging agent reply (canned).', conversation_id: id, conversation_capability: 'cap-' + id });
  }
  if (rq.method === 'POST' && p === '/api/v1/agents') {
    const b = await body(rq); const a = (rq.headers.authorization || '').trim(); const m = /^Bearer\s+(\S+)$/i.exec(a);
    const tok = m && m[1];
    if (!(tok && tok.startsWith('wst_') && tok === GOOD_WST)) { authCalls.unauthorized++; return json(rs, 401, { error: 'Unauthorized' }); }
    if (rq.headers['x-org-id'] && rq.headers['x-org-id'] !== ORG) return json(rs, 403, { error: "x-org-id header does not match the workspace bearer token's org." });
    authCalls.ok++;
    const st = uplink.get(b.conversation_id); if (!st) return json(rs, 404, { error: 'not_found' });
    return json(rs, 200, { conversation: { id: b.conversation_id, orgId: ORG, agentId: AGENT, anonymousSessionId: st.sessionId, channelMeta: st.channelMeta }, turns: st.turns });
  }
  // ---- Chatwoot ----
  const m = /^\/api\/v1\/accounts\/2(\/.*)$/.exec(p); if (!m) return json(rs, 404, { error: 'x' });
  const path = m[1]; const byId = (id) => [...contacts.values()].find((c) => c.id === Number(id));
  if (rq.method === 'GET' && path === '/contacts/search') { const c = contacts.get(u.searchParams.get('q')); return json(rs, 200, { payload: c ? [{ id: c.id }] : [] }); }
  if (rq.method === 'GET' && (r = /^\/contacts\/(\d+)\/conversations$/.exec(path))) { const c = byId(r[1]); return json(rs, 200, { payload: c ? [{ id: c.conv, inbox_id: 11, last_activity_at: now() }] : [] }); }
  if (rq.method === 'GET' && (r = /^\/contacts\/(\d+)$/.exec(path))) { const c = byId(r[1]); if (!c) return json(rs, 404, {}); const ib = { id: 11, channel_type: 'Channel::Whatsapp', provider: 'whatsapp_cloud' }; return json(rs, 200, { payload: { id: c.id, phone_number: '+' + c.wa, contact_inboxes: [{ inbox: ib, source_id: c.wa }, { inbox: ib, source_id: 'US.' + c.wa.slice(1, 9) }] } }); }
  if (rq.method === 'GET' && (r = /^\/conversations\/(\d+)\/messages$/.exec(path))) { const v = convs.get(Number(r[1])); return json(rs, 200, { payload: v ? v.messages : [] }); }
  if (rq.method === 'GET' && (r = /^\/conversations\/(\d+)$/.exec(path))) { const v = convs.get(Number(r[1])); return v ? json(rs, 200, convView(v)) : json(rs, 404, {}); }
  if (rq.method === 'POST' && (r = /^\/conversations\/(\d+)\/messages$/.exec(path))) {
    const v = convs.get(Number(r[1])); if (!v) return json(rs, 404, {}); const b = await body(rq);
    const msg = { id: ++mid, content: b.content, message_type: 1, private: b.private === true, content_attributes: b.content_attributes || {}, created_at: now() }; v.messages.push(msg);
    (b.private === true ? privates : posts).push({ conv: v.id, len: String(b.content || '').length, text: String(b.content || '').slice(0, 60) });
    return json(rs, 200, { id: msg.id });
  }
  if (rq.method === 'POST' && (r = /^\/conversations\/(\d+)\/custom_attributes$/.exec(path))) { const v = convs.get(Number(r[1])); const b = await body(rq); Object.assign(v.custom_attributes, b.custom_attributes || {}); return json(rs, 200, { custom_attributes: v.custom_attributes }); }
  if (rq.method === 'POST' && (r = /^\/conversations\/(\d+)\/toggle_status$/.exec(path))) { const v = convs.get(Number(r[1])); const b = await body(rq); v.status = b.status; return json(rs, 200, { payload: { current_status: v.status } }); }
  if (rq.method === 'POST' && (r = /^\/conversations\/(\d+)\/assignments$/.exec(path))) { const v = convs.get(Number(r[1])); const b = await body(rq); if (b.team_id) v.team = b.team_id; if (b.assignee_id) v.assignee = b.assignee_id; return json(rs, 200, {}); }
  return json(rs, 404, { error: 'not_in_fake', path });
}).listen(3000, () => console.log('world-sim listening 3000'));
