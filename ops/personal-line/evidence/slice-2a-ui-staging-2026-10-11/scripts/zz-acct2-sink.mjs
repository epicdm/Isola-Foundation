// Lane A staging-only mail sink for slice-2a UI acceptance (zz-acct2). Impersonates api.smtp2go.com / api.resend.com ONLY inside
// the isolated zzacct2 app service (via its /etc/hosts), with a throwaway CA trusted only by that service.
// Captures (a) the operator sign-in link and (b) the customer portal 6-digit access code, per recipient. Never logs headers,
// tokens or codes; the browser page fetches them same-origin via the edge and never echoes them.
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';

const links = new Map();   // recipient -> [relative callback path+query]
const codes = new Map();   // recipient -> latest 6-digit portal code
let n = 0;

function grabLink(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>]+\/api\/auth\/callback\/[a-z0-9]+\?[^\s"'<>]+/i);
  if (!m) return null;
  const u = new URL(m[0].replace(/&amp;/g, '&'));
  return u.pathname + u.search;
}
function grabCode(subject, text) {
  const m = String(subject || '').match(/sign-in code:\s*(\d{6})/i) || String(text || '').match(/\b(\d{6})\b/);
  return m ? m[1] : null;
}

const tlsServer = https.createServer(
  { key: fs.readFileSync('/s/tls/sink.key'), cert: fs.readFileSync('/s/tls/sink.crt') },
  (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      n += 1;
      let to = '?', text = '', subject = '';
      try {
        const j = JSON.parse(body || '{}');
        to = Array.isArray(j.to) ? String(j.to[0]) : String(j.to || '?');
        text = (j.text_body || j.text || '') + '\n' + (j.html_body || j.html || '');
        subject = String(j.subject || '');
      } catch {}
      const m = to.match(/<([^>]+)>/); if (m) to = m[1];
      to = to.trim().toLowerCase();
      const link = grabLink(text);
      if (link) { const a = links.get(to) || []; a.push(link); links.set(to, a); }
      const code = /sign-in code/i.test(subject) ? grabCode(subject, text) : null;
      if (code) codes.set(to, code);
      console.log(JSON.stringify({ at: new Date().toISOString(), host: req.headers.host, path: req.url, to, subject: subject.replace(/\d{6}/g, '######').slice(0, 80), has_signin_link: !!link, has_portal_code: !!code }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'sink-' + n, data: { succeeded: 1, failed: 0, email_id: 'sink-' + n } }));
    });
  },
);
tlsServer.listen(443, '0.0.0.0');

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__mailsink/status') {
    const s = {}; for (const [k, v] of links) s[k] = v.length;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ received: n, pending_links: s, pending_codes: [...codes.keys()] })); return;
  }
  if (u.pathname === '/__mailsink/go') {
    const to = String(u.searchParams.get('to') || '').toLowerCase();
    const a = links.get(to) || [];
    const link = a.pop();
    if (!link) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no captured sign-in link for ' + to); return; }
    links.set(to, []);
    res.writeHead(302, { location: link }); res.end(); return;
  }
  if (u.pathname === '/__mailsink/code') {
    const to = String(u.searchParams.get('to') || '').toLowerCase();
    const c = codes.get(to);
    if (!c) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('none'); return; }
    codes.delete(to);
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end(c); return;
  }
  if (u.pathname === '/__mailsink/zzkey') {
    const nm = String(u.searchParams.get('name') || '');
    if (!['events', 'summary'].includes(nm)) { res.writeHead(404); res.end(); return; }
    try { const k = fs.readFileSync('/s/keys/' + nm, 'utf8').trim(); res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end(k); }
    catch { res.writeHead(404); res.end(); }
    return;
  }
  res.writeHead(404); res.end();
}).listen(8025, '0.0.0.0');
console.log('sink up');
