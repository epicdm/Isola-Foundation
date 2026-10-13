// host03 STAGING ONLY - disposable stand-in for graph.facebook.com (Cloud API /messages), reachable only from plstg_net via a
// --host-add on the staging web service. Records every POST /<ver>/<phone-id>/messages (recipient masked to last 4, payload kept:
// staging synthetic numbers only) and answers like Meta ({messages:[{id}]}). Never forwards anything. Control: GET :9001/__sent.
import https from 'node:https'
import http from 'node:http'
import { readFileSync } from 'node:fs'
const sent = []
const tls = { key: readFileSync('/h/tls/graph.key'), cert: readFileSync('/h/tls/graph.pem') }
https.createServer(tls, (req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const m = req.url.match(/^\/(v\d+\.\d+)\/(\d+)\/messages$/)
    if (req.method === 'POST' && m) {
      let body = null; try { body = JSON.parse(raw) } catch { /* keep null */ }
      const id = `wamid.STGRC16.${sent.length + 1}.${Date.now()}`
      sent.push({ t: new Date().toISOString(), version: m[1], from_phone_id: m[2], auth: /^Bearer .{8,}/.test(String(req.headers.authorization || '')), to: body?.to ?? null, body, wamid: id })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: body?.to, wa_id: body?.to }], messages: [{ id }] }))
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"metamock: unsupported"}')
  })
}).listen(443, '0.0.0.0', () => console.log('metamock https 443'))
http.createServer((req, res) => {
  if (req.url === '/__sent') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ total: sent.length, sent })) }
  if (req.url === '/__reset' && req.method === 'POST') { sent.length = 0; res.writeHead(200); return res.end('{"ok":true}') }
  res.writeHead(404); res.end()
}).listen(9001, '0.0.0.0', () => console.log('metamock control 9001'))
