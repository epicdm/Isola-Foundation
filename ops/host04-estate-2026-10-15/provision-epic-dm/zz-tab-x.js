// Inside plsvc: full tab chain for the 9610 fixture. tab-entry -> test.epic.dm/?tab_code -> app redirect keeps code? -> CORS -> exchange returns a session? Secrets never printed.
const fs = require('fs'), https = require('https');
process.env.DATABASE_URL = fs.readFileSync('/app/.dburl', 'utf8').trim();
const { PrismaClient } = require('@prisma/client'); const { PrismaPg } = require('@prisma/adapter-pg');
const req = (hostIp, sni, path, method = 'GET', headers = {}, body) => new Promise((res) => {
  const r = https.request({ host: hostIp, servername: sni, path, method, headers: { Host: sni, ...headers } }, (resp) => { let b = ''; resp.on('data', (c) => (b += c)); resp.on('end', () => res({ s: resp.statusCode, b, h: resp.headers })); });
  r.on('error', (e) => res({ s: 'ERR ' + e.message, b: '', h: {} })); if (body) r.write(body); r.end();
});
(async () => {
  const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const a = await p.$queryRawUnsafe(`select "sipUsername" u, "sipPassword" pw from lite_accounts where right("ownerPhone",4)='9610' and "ownerPhone" not like '%retired%' order by "createdAt" desc limit 1`); await p.$disconnect();
  const t = await req('66.118.37.29', 'provision.epic.dm', `/api/v1/acrobits/tab-entry?username=${encodeURIComponent(a[0].u)}&password=${encodeURIComponent(a[0].pw)}`);
  const loc = t.h.location || ''; const code = new URL(loc).searchParams.get('tab_code');
  const r1 = await req('66.118.37.29', 'test.epic.dm', '/?tab_code=' + encodeURIComponent(code));
  const l2 = r1.h.location || ''; let keep = false, h2 = '-'; try { const u = new URL(l2); keep = u.searchParams.get('tab_code') === code; h2 = u.host } catch {}
  console.log('1 test.epic.dm/?tab_code ->', r1.s, '| to', h2, '| code preserved:', keep);
  const pre = await req('66.118.37.29', 'bff.epic.dm', '/api/lite/acrobits/tab-exchange', 'OPTIONS', { Origin: 'https://app.isola.epic.dm', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' });
  console.log('2 CORS preflight ->', pre.s, '| allow-origin:', pre.h['access-control-allow-origin'] || '(none)');
  const body = JSON.stringify({ code, currentUsername: a[0].u });
  const ex = await req('66.118.37.29', 'bff.epic.dm', '/api/lite/acrobits/tab-exchange', 'POST', { 'content-type': 'application/json', Origin: 'https://app.isola.epic.dm', 'content-length': Buffer.byteLength(body) }, body);
  let j = {}; try { j = JSON.parse(ex.b) } catch {}
  console.log('3 exchange ->', ex.s, '| allow-origin:', ex.h['access-control-allow-origin'] || '(none)', '| response keys:', Object.keys(j).join(',') || ex.b.slice(0, 60));
  const bad = await req('66.118.37.29', 'bff.epic.dm', '/api/lite/acrobits/tab-exchange', 'POST', { 'content-type': 'application/json', Origin: 'https://app.isola.epic.dm', 'content-length': Buffer.byteLength(JSON.stringify({ code: 'not-a-real-code-000000000' })) }, JSON.stringify({ code: 'not-a-real-code-000000000' }));
  console.log('4 CONTROL bogus code ->', bad.s, '(must NOT be 200)');
})().catch((e) => { console.log('ERR', String(e.message).slice(0, 160)); process.exit(1); });
