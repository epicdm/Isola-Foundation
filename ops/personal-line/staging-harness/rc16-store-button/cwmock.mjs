// rc16g host03 STAGING ONLY - disposable, STATEFUL stand-in for the Chatwoot API subset the PL adapter reads (contacts/search,
// contacts/<id>, contacts/<id>/conversations, conversations/<id>, conversations/<id>/messages GET+POST). One synthetic customer per
// wa_id (contact id = last 6 digits, conversation id = contact id + 100000), inbox 11 / account 2. The harness controls ownership,
// the customer's last inbound and failures over HTTP; every request is counted. No real customer, no network egress.
//   POST /__state {wa, status?, inboundAgoS? (null = no customer message), outgoingOnly?, failMessages?, failConversation?, noContact?, delayMs?, inboundText?}
//   GET  /__calls     POST /__reset
import http from 'node:http'
import crypto from 'node:crypto'
const INBOX = 11
const S = new Map()   // wa -> state
const calls = []
const st = (wa) => { if (!S.has(wa)) S.set(wa, { status: 'pending', inboundAgoS: 3600, outgoingOnly: false, failMessages: false, failConversation: false, noContact: false, delayMs: 0, inboundText: 'hi', posts: [], inboundId: 5000 + (Number(wa.slice(-4)) || 0), inboundSetAt: Date.now() }); return S.get(wa) }
const cid = (wa) => Number(wa.slice(-6)), vid = (wa) => cid(wa) + 100000
const waOfContact = (id) => [...S.keys()].find((w) => cid(w) === id)
const waOfConv = (id) => [...S.keys()].find((w) => vid(w) === id)
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => { raw += c })
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x'), p = url.pathname
    if (p === '/__calls') return send(res, 200, { total: calls.length, calls: calls.slice(-200) })
    if (p === '/__reset') { calls.length = 0; S.clear(); return send(res, 200, { ok: true }) }
    if (p === '/__state' && req.method === 'POST') {
      const b = JSON.parse(raw || '{}'); if (!/^\d{8,15}$/.test(String(b.wa))) return send(res, 400, { error: 'wa' })
      const s = st(String(b.wa))
      for (const k of ['status', 'inboundAgoS', 'outgoingOnly', 'failMessages', 'failConversation', 'noContact', 'delayMs', 'inboundText']) if (k in b) s[k] = b[k]
      if ('inboundAgoS' in b || 'inboundText' in b) s.inboundSetAt = Date.now()
      return send(res, 200, { ok: true, state: { ...s, posts: s.posts.length } })
    }
    if (p === '/__posts') { const wa = url.searchParams.get('wa'); return send(res, 200, { posts: (S.get(wa)?.posts ?? []).map((x) => ({ private: x.private, content: String(x.content).slice(0, 80) })) }) }
    const m = p.match(/^\/api\/v1\/accounts\/2(\/.*)$/)
    if (!m) return send(res, 404, { error: 'cwmock: not found' })
    if (!req.headers.api_access_token) return send(res, 401, { error: 'no token' })
    const path = m[1]
    const nowS = Math.floor(Date.now() / 1000)
    calls.push({ t: nowS, m: req.method, path: path.replace(/(\d{3})\d{3}\b/g, '$1***').slice(0, 80) })
    let mm
    if ((mm = path.match(/^\/contacts\/search$/))) {
      const q = url.searchParams.get('q') ?? ''; const s = S.get(q)
      return send(res, 200, { payload: s && !s.noContact ? [{ id: cid(q) }] : [] })
    }
    if ((mm = path.match(/^\/contacts\/(\d+)\/conversations$/))) { const wa = waOfContact(Number(mm[1])); if (!wa) return send(res, 404, {}); return send(res, 200, { payload: [{ id: vid(wa), inbox_id: INBOX, last_activity_at: nowS }] }) }
    if ((mm = path.match(/^\/contacts\/(\d+)$/))) { const wa = waOfContact(Number(mm[1])); if (!wa) return send(res, 404, {}); return send(res, 200, { payload: { id: cid(wa), phone_number: '+' + wa, contact_inboxes: [{ inbox: { id: INBOX }, source_id: wa }] } }) }
    if ((mm = path.match(/^\/conversations\/(\d+)\/messages$/))) {
      const wa = waOfConv(Number(mm[1])); if (!wa) return send(res, 404, {}); const s = st(wa)
      if (req.method === 'POST') { const b = JSON.parse(raw || '{}'); s.posts.push(b); return send(res, 200, { id: 9000 + s.posts.length }) }
      if (s.delayMs) await sleep(s.delayMs)
      if (s.failMessages) return send(res, 500, { error: 'cwmock: injected failure' })
      const list = []
      if (!s.outgoingOnly && s.inboundAgoS !== null) list.push({ id: s.inboundId, message_type: 0, private: false, sender_type: 'Contact', source_id: 'wamid.RC16G' + crypto.createHash('sha1').update(wa + s.inboundId).digest('hex').slice(0, 16), content: s.inboundText, created_at: nowS - s.inboundAgoS })
      list.push({ id: s.inboundId + 1, message_type: 1, private: false, sender_type: 'User', content: 'agent/bot reply', created_at: nowS - 5 })
      return send(res, 200, { payload: list })
    }
    if ((mm = path.match(/^\/conversations\/(\d+)$/))) {
      const wa = waOfConv(Number(mm[1])); if (!wa) return send(res, 404, {}); const s = st(wa)
      if (s.delayMs) await sleep(s.delayMs)
      if (s.failConversation) return send(res, 500, { error: 'cwmock: injected failure' })
      return send(res, 200, { id: vid(wa), inbox_id: INBOX, status: s.status, contact_id: cid(wa), meta: { sender: { id: cid(wa) } } })
    }
    return send(res, 404, { error: 'cwmock: unsupported ' + path })
  })
}).listen(9300, '0.0.0.0', () => console.log('cwmock listening 9300'))
