// zz-sip-ua.js - a minimal headless SIP user agent for the owner-authorized fixture test (O7 register, O8 ONE call). Runs in a throwaway container (docker run --rm). Credentials come ONLY from environment variables and are never printed.
// Flow: REGISTER (digest) -> [call mode] INVITE sip:<DEST>@<host> (digest) -> RTP silence for HOLD_S seconds -> BYE -> unregister. Hard limits: BYE at HOLD_S (<= 30) after the 200 OK, the whole process exits at HARD_S.
const dgram = require('dgram'), crypto = require('crypto'), os = require('os');
const HOST = process.env.SIP_HOST, PORT = Number(process.env.SIP_PORT || 5060), USER = process.env.SIPUSER, PASS = process.env.SIPPASS, MODE = process.env.MODE || 'register', DEST = process.env.DEST || '';
const HOLD_S = Math.min(Number(process.env.HOLD_S || 30), 30), HARD_S = 75;
if (!HOST || !USER || !PASS) { console.log('REFUSED: missing configuration'); process.exit(3); }
const sock = dgram.createSocket('udp4'), rtp = dgram.createSocket('udp4');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex'), rnd = (n = 8) => crypto.randomBytes(n).toString('hex');
let LPORT = 0; const LIP = (Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal) || {}).address || '0.0.0.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const callId = rnd() + '@fixture', fromTag = rnd(4); let cseq = 1; const waiters = [];
sock.on('message', (m) => { const t = m.toString(); for (const w of waiters.slice()) if (w(t)) { waiters.splice(waiters.indexOf(w), 1); w.res(t); } });
const wait = (pred, ms) => new Promise((res, rej) => { const w = Object.assign((t) => pred(t), { res }); waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error('timeout')); } }, ms); });
const status = (t) => Number((/^SIP\/2\.0 (\d{3})/.exec(t) || [])[1] || 0), hdr = (t, n) => (new RegExp('^' + n + ':\\s*(.*)$', 'im').exec(t) || [])[1] || '';
function auth(method, uri, ch) {
  const realm = /realm="([^"]*)"/.exec(ch)[1], nonce = /nonce="([^"]*)"/.exec(ch)[1], qop = /qop="?([a-z,]*)/.exec(ch); const ha1 = md5(`${USER}:${realm}:${PASS}`), ha2 = md5(`${method}:${uri}`);
  if (qop && qop[1].includes('auth')) { const cn = rnd(4), nc = '00000001'; return `Digest username="${USER}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${md5(`${ha1}:${nonce}:${nc}:${cn}:auth:${ha2}`)}", algorithm=MD5, qop=auth, nc=${nc}, cnonce="${cn}"`; }
  return `Digest username="${USER}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${md5(`${ha1}:${nonce}:${ha2}`)}", algorithm=MD5`;
}
const send = (msg) => sock.send(Buffer.from(msg.replace(/\r?\n/g, '\r\n')), PORT, HOST);
function req(method, uri, extra, body, branch, to, toTag) {
  return `${method} ${uri} SIP/2.0\nVia: SIP/2.0/UDP ${LIP}:${LPORT};branch=z9hG4bK${branch};rport\nMax-Forwards: 70\nFrom: <sip:${USER}@${HOST}>;tag=${fromTag}\nTo: <${to}>${toTag ? ';tag=' + toTag : ''}\nCall-ID: ${callId}${method === 'INVITE' || method === 'BYE' || method === 'ACK' ? '-call' : ''}\nCSeq: ${cseq} ${method}\nContact: <sip:${USER}@${LIP}:${LPORT};transport=udp>\nUser-Agent: fixture-ua/1.0\n${extra}Content-Length: ${Buffer.byteLength(body || '')}\n\n${body || ''}`;
}
async function register(expires) {
  const uri = `sip:${HOST}`, to = `sip:${USER}@${HOST}`;
  cseq++; send(req('REGISTER', uri, `Expires: ${expires}\n`, '', rnd(6), to));
  let r = await wait((t) => /CSeq: \d+ REGISTER/i.test(t) && status(t) >= 200, 8000);
  if (status(r) === 401 || status(r) === 407) { cseq++; const ch = hdr(r, status(r) === 401 ? 'WWW-Authenticate' : 'Proxy-Authenticate'); send(req('REGISTER', uri, `Authorization: ${auth('REGISTER', uri, ch)}\nExpires: ${expires}\n`, '', rnd(6), to)); r = await wait((t) => /CSeq: \d+ REGISTER/i.test(t) && status(t) >= 200, 8000); }
  return status(r);
}
async function call() {
  const uri = `sip:${DEST}@${HOST}`, rport = 40000 + Math.floor(Math.random() * 1000); rtp.bind(rport);
  const sdp = `v=0\no=fixture 1 1 IN IP4 ${LIP}\ns=fixture\nc=IN IP4 ${LIP}\nt=0 0\nm=audio ${rport} RTP/AVP 0 101\na=rtpmap:0 PCMU/8000\na=rtpmap:101 telephone-event/8000\na=sendrecv\n`;
  const ct = 'Content-Type: application/sdp\n'; const invCall = callId + '-call'; const to = uri;
  cseq++; send(req('INVITE', uri, ct, sdp, rnd(6), to));
  let r = await wait((t) => /CSeq: \d+ INVITE/i.test(t) && status(t) >= 180 && status(t) !== 183 || /CSeq: \d+ INVITE/i.test(t) && status(t) >= 200, 10000);
  if (status(r) === 401 || status(r) === 407) { send(req('ACK', uri, '', '', rnd(6), to, '')); cseq++; const ch = hdr(r, status(r) === 401 ? 'WWW-Authenticate' : 'Proxy-Authenticate'); send(req('INVITE', uri, `${status(r) === 401 ? 'Authorization' : 'Proxy-Authorization'}: ${auth('INVITE', uri, ch)}\n` + ct, sdp, rnd(6), to)); r = await wait((t) => /CSeq: \d+ INVITE/i.test(t) && status(t) >= 200, 20000); }
  const code = status(r); console.log('INVITE final response:', code);
  if (code !== 200) return { code };
  const toTag = (/;tag=([^;>\s]+)/.exec(hdr(r, 'To')) || [])[1] || ''; const t0 = Date.now();
  const cIp = (/c=IN IP4 (\S+)/.exec(r) || [])[1], cPort = Number((/m=audio (\d+)/.exec(r) || [])[1]);
  send(req('ACK', uri, '', '', rnd(6), `${uri}`, toTag));
  let seq = 0, ts = 0; const ssrc = crypto.randomBytes(4); const timer = setInterval(() => { if (!cIp || !cPort) return; const h = Buffer.alloc(12); h[0] = 0x80; h[1] = 0; h.writeUInt16BE(seq++ & 0xffff, 2); h.writeUInt32BE(ts, 4); ts += 160; ssrc.copy(h, 8); rtp.send(Buffer.concat([h, Buffer.alloc(160, 0xff)]), cPort, cIp); }, 20);
  let got = 0; rtp.on('message', () => { got++; });
  await sleep(HOLD_S * 1000); clearInterval(timer);
  cseq++; send(req('BYE', uri, '', '', rnd(6), `${uri}`, toTag)); let b = 0; try { b = status(await wait((t) => /CSeq: \d+ BYE/i.test(t) && status(t) >= 200, 6000)); } catch { b = -1; }
  console.log('held for', Math.round((Date.now() - t0) / 1000), 's; BYE response:', b, '; echoed RTP packets received:', got);
  return { code: 200, held: Math.round((Date.now() - t0) / 1000) };
}
(async () => {
  setTimeout(() => { console.log('HARD LIMIT reached, exiting'); process.exit(4); }, HARD_S * 1000);
  sock.bind(0, async () => {
    LPORT = sock.address().port;
    try {
      const reg = await register(120); console.log('REGISTER final response:', reg);
      if (reg !== 200) { process.exit(1); }
      if (MODE === 'register' && Number(process.env.REG_HOLD_S || 0) > 0) { console.log('REGISTERED; holding', process.env.REG_HOLD_S, 's for the server-side registration read'); await sleep(Number(process.env.REG_HOLD_S) * 1000); }
      if (MODE === 'call') { const c = await call(); if (c.code !== 200) { await register(0).catch(() => 0); process.exit(1); } }
      const un = await register(0).catch(() => -1); console.log('UNREGISTER (Expires 0) response:', un);
      process.exit(0);
    } catch (e) { console.log('ERROR', e.message); try { await register(0); } catch { } process.exit(2); }
  });
})();
