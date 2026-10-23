// mock-ext.mjs v2 (+rc13: bot messages keep content_type/content_attributes so input_select buttons and tap readback are real) - disposable, STATEFUL stand-in for the PL concierge service's external integrations on host03 staging:
//   Magnus billing REST (form POST /mbilling/index.php/<module>/<action>, Key/Sign headers, filter JSON, {rows,count}), AMI peer listener,
//   Lumen seat-bind. Synthetic only; no real telecom, no real customer. Every call is counted and logged (module/action/decoded non-secret fields).
// Control endpoints: GET /__calls, POST /__reset (clears the call log only), POST /__state (dump counts), POST /__fail?next=<module/action>&mode=500|timeout|after_commit
import http from 'node:http'
const calls = []
const tables = { user: [], sip: [], did: [], diddestination: [], offer: [], offerUse: [], callerid: [], refill: [], plan: [] }
const seq = {}
const nextId = (t) => (seq[t] = (seq[t] ?? 100) + 1)
// catalogue the staging lite_plans rows point at (freetimetocall is SECONDS; minutes = seconds/60)
const OFFER_MIN = { 7001: 60, 7002: 200, 7003: 600, 7004: 1000, 7005: 1500 }
for (const [id, min] of Object.entries(OFFER_MIN)) tables.offer.push({ id: Number(id), freetimetocall: String(min * 60), name: 'offer' + id })
const cwdb = { conversations: [], contacts: [], messages: [] }
const failures = []   // {key, mode}
const SECRET_FIELDS = /pass|secret|key|sign/i
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
function matches(row, f) {
  const a = String(row[f.field] ?? ''), b = String(f.value)
  if (f.comparison === 'ct') return a.includes(b)
  if (f.comparison === 'st') return a.startsWith(b)
  return a === b
}
http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname
    if (p === '/__calls') return send(res, 200, { total: calls.length, calls: calls.slice(-300) })
    if (p === '/__reset') { calls.length = 0; return send(res, 200, { ok: true }) }
    if (p === '/__health') return send(res, 200, { ok: true })
    if (p === '/__state') return send(res, 200, Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])))
    if (p === '/__fail') { failures.push({ key: url.searchParams.get('next'), mode: url.searchParams.get('mode') || '500' }); return send(res, 200, { queued: failures.length }) }

    // ── Chatwoot API stand-in (account 2): seeded by the harness; shapes follow the Chatwoot application API (conversation show, messages list, contact show)
    if (p === '/__cw_seed') { const j = JSON.parse(raw || '{}'); for (const k of ['conversations', 'contacts', 'messages']) for (const x of j[k] || []) { const T = cwdb[k]; const i = T.findIndex((y) => String(y.id) === String(x.id)); if (i >= 0) T[i] = x; else T.push(x) } return send(res, 200, { ok: true, counts: Object.fromEntries(Object.entries(cwdb).map(([k, v]) => [k, v.length])) }) }
    const cm = p.match(/^\/chatwoot\/api\/v1\/accounts\/(\d+)\/(conversations|contacts)\/(\d+)(?:\/(messages|custom_attributes|toggle_status|assignments))?$/)
    if (cm) {
      const [, acct, coll, id, sub] = cm
      calls.push({ t: Date.now(), kind: 'chatwoot', method: req.method, path: p.replace(/\/\d+/g, '/:id') })
      if (!req.headers['api_access_token']) return send(res, 401, { error: 'unauthorized' })
      const body = raw ? JSON.parse(raw) : {}
      if (coll === 'conversations') {
        const c = cwdb.conversations.find((x) => String(x.id) === id); if (!c) return send(res, 404, { error: 'not found' })
        c.meta = c.meta || {}; c.custom_attributes = c.custom_attributes || {}
        const view = () => {
          const ct = cwdb.contacts.find((x) => String(x.id) === String(c.contactId))
          return { id: Number(c.id), account_id: Number(acct), inbox_id: Number(c.inbox_id), status: c.status || 'pending', custom_attributes: c.custom_attributes,
            meta: { sender: ct ? { id: Number(ct.id), name: ct.name || 'Synthetic', phone_number: ct.phone_number || null } : null, ...(c.meta.assignee ? { assignee: c.meta.assignee } : {}), ...(c.meta.team ? { team: c.meta.team } : {}) } }
        }
        if (req.method === 'GET' && !sub) return send(res, 200, view())
        if (req.method === 'GET' && sub === 'messages') return send(res, 200, { meta: {}, payload: cwdb.messages.filter((m) => String(m.conversation_id) === id) })
        if (req.method === 'POST' && sub === 'custom_attributes') { c.custom_attributes = body.merge ? { ...c.custom_attributes, ...(body.custom_attributes || {}) } : (body.custom_attributes || {}); return send(res, 200, { custom_attributes: c.custom_attributes }) }
        if (req.method === 'POST' && sub === 'messages') {
          const m = { id: (cwdb.nextMsgId = (cwdb.nextMsgId ?? 900000) + 1), conversation_id: Number(id), content: String(body.content ?? ''), message_type: body.message_type === 'outgoing' ? 1 : 0, private: body.private === true, sender_type: 'AgentBot', status: 'sent', source_id: null, created_at: Math.floor(Date.now() / 1000), content_type: body.content_type || 'text', content_attributes: body.content_attributes || {} }
          cwdb.messages.push(m); return send(res, 200, m)
        }
        if (req.method === 'POST' && sub === 'toggle_status') { c.status = body.status; return send(res, 200, { payload: { success: true, current_status: c.status } }) }
        if (req.method === 'POST' && sub === 'assignments') { if (body.assignee_id) c.meta.assignee = { id: Number(body.assignee_id) }; if (body.team_id) c.meta.team = { id: Number(body.team_id) }; return send(res, 200, view()) }
        return send(res, 404, { error: 'unsupported' })
      }
      const ct = cwdb.contacts.find((x) => String(x.id) === id); if (!ct) return send(res, 404, { error: 'not found' })
      return send(res, 200, { payload: { ...ct, id: Number(ct.id), contact_inboxes: (ct.contact_inboxes || []).map((ci) => ({ source_id: ci.source_id, inbox: { id: Number(ci.inbox?.id ?? ci.inbox_id), channel_type: ci.inbox?.channel_type || 'Channel::Whatsapp', provider: ci.inbox?.provider || 'whatsapp_cloud' } })) } })
    }
    if (p === '/__cw_incoming') {   // a real customer message: id comes from the SAME counter as bot replies, so ordering is real; source_id is a WhatsApp-style message id
      const j = JSON.parse(raw || '{}')
      const id = (cwdb.nextMsgId = (cwdb.nextMsgId ?? 900000) + 1)
      const m = { id, conversation_id: Number(j.conversation_id), content: String(j.content ?? ''), message_type: 0, private: false, sender_type: 'Contact', status: 'delivered', source_id: 'wamid.E2E' + id + Math.random().toString(36).slice(2, 10).toUpperCase(), created_at: Math.floor(Date.now() / 1000) }
      cwdb.messages.push(m); return send(res, 200, m)
    }
    if (p === '/__cw_status') { const j = JSON.parse(raw || '{}'); const c = cwdb.conversations.find((x) => String(x.id) === String(j.id)); if (c) { c.status = j.status; if (j.status === 'pending') c.meta = {} } return send(res, 200, { ok: !!c }) }
    if (p === '/__cw_messages') { const j = JSON.parse(raw || '{}'); return send(res, 200, { messages: cwdb.messages.filter((m) => String(m.conversation_id) === String(j.conversation_id)).map((m) => ({ id: m.id, message_type: m.message_type, private: m.private, sender_type: m.sender_type, content: m.content, status: m.status, items: (m.content_attributes?.items ?? []).map((i) => i.title) })) }) }
    if (p === '/__cw_conv') { const j = JSON.parse(raw || '{}'); const c = cwdb.conversations.find((x) => String(x.id) === String(j.id)); return send(res, 200, c ? { status: c.status, meta: c.meta, custom_attribute_keys: Object.keys(c.custom_attributes || {}) } : {}) }
    const m = p.match(/^\/mbilling\/index\.php\/([A-Za-z]+)\/([A-Za-z]+)$/)
    if (m) {
      const [, mod, act] = m
      const form = Object.fromEntries(new URLSearchParams(raw))
      const logged = Object.fromEntries(Object.entries(form).filter(([k]) => !['nonce'].includes(k)).map(([k, v]) => [k, SECRET_FIELDS.test(k) ? '<redacted>' : String(v).slice(0, 80)]))
      calls.push({ t: Date.now(), kind: 'magnus', module: mod, action: act, fields: logged, signed: Boolean(req.headers['sign'] && req.headers['key']) })
      const fi = failures.findIndex((f) => f.key === `${mod}/${act}`)
      let afterCommit = false
      if (fi >= 0) { const f = failures.splice(fi, 1)[0]; if (f.mode === '500') return send(res, 500, { status: 'error', message: 'synthetic upstream failure' }); if (f.mode === 'timeout') return; afterCommit = f.mode === 'after_commit' }
      const T = (tables[mod] ??= [])
      let out
      if (act === 'read') {
        let rows = T.slice()
        if (form.filter) { try { for (const f of JSON.parse(form.filter)) rows = rows.filter((r) => matches(r, f)) } catch {} }
        const start = Number(form.start ?? 0), limit = Number(form.limit ?? 25)
        out = { rows: rows.slice(start, start + limit), count: rows.length }
      } else if (act === 'save') {
        const id = form.id && form.id !== '0' ? Number(form.id) : 0
        let row = id ? T.find((r) => Number(r.id) === id) : null
        if (!row) { row = { id: nextId(mod) }; T.push(row) }
        for (const [k, v] of Object.entries(form)) if (!['id', 'module', 'action', 'nonce'].includes(k)) row[k] = v
        if (mod === 'user' && form.id_offer !== undefined) {
          // Magnus keeps a pkg_offer_use row per (user, offer): active = status 1 + zero releasedate; a changed/cleared offer releases the old row.
          const ou = (tables.offerUse ??= [])
          for (const r of ou) if (Number(r.id_user) === Number(row.id) && String(r.id_offer) !== String(form.id_offer) && String(r.status) === '1') { r.status = '0'; r.releasedate = '2026-10-09 00:00:00' }
          const want = String(form.id_offer)
          if (want && want !== '0' && !ou.some((r) => Number(r.id_user) === Number(row.id) && String(r.id_offer) === want && String(r.status) === '1')) ou.push({ id: nextId('offerUse'), id_user: Number(row.id), id_offer: Number(want), status: '1', releasedate: '0000-00-00 00:00:00' })
        }
        out = { success: true, id: row.id, rows: [{ id: row.id }] }
      } else if (act === 'destroy') {
        const id = Number(form.id); const i = T.findIndex((r) => Number(r.id) === id); if (i >= 0) T.splice(i, 1)
        out = { success: true }
      } else out = { success: true, rows: [], count: 0 }
      if (afterCommit) return   // the write COMMITTED on our side but the response never arrives (simulates timeout after upstream success)
      return send(res, 200, out)
    }
    calls.push({ t: Date.now(), kind: 'other', method: req.method, path: p, query: url.search.slice(0, 100), bytes: raw.length })
    if (p.startsWith('/peer') || p.startsWith('/registration')) return send(res, 200, { registered: false, state: 'unknown' })
    if (p.startsWith('/seat')) return send(res, 200, { ok: true, seat_id: 'synthetic-seat-' + nextId('seat') })
    return send(res, 200, { rows: [], count: 0, success: true })
  })
}).listen(9000, '0.0.0.0', () => console.log('mock-ext v2 listening 9000'))
