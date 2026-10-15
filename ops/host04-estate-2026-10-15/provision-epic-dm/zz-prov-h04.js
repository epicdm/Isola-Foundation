// Inside plsvc: call provision.epic.dm pinned to HOST04 (66.118.37.29), real TLS with SNI provision.epic.dm. Credentials in-process, never printed.
const fs = require('fs'), https = require('https');
process.env.DATABASE_URL = fs.readFileSync('/app/.dburl', 'utf8').trim();
const { PrismaClient } = require('@prisma/client'); const { PrismaPg } = require('@prisma/adapter-pg');
const get = (path) => new Promise((res) => {
  const r = https.request({ host: '66.118.37.29', servername: 'provision.epic.dm', path, method: 'GET', headers: { Host: 'provision.epic.dm' } }, (resp) => {
    let b = ''; resp.on('data', (c) => (b += c)); resp.on('end', () => res({ s: resp.statusCode, b, loc: resp.headers.location || '' }));
  }); r.on('error', (e) => res({ s: 'ERR ' + e.message, b: '' })); r.end();
});
const host = (u) => { try { const x = new URL(u.replace(/&amp;/g, '&')); return x.host + x.pathname } catch { return '-' } };
(async () => {
  const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const a = await p.$queryRawUnsafe(`select "sipUsername" u, "sipPassword" pw from lite_accounts where right("ownerPhone",4)='9610' and "ownerPhone" not like '%retired%' order by "createdAt" desc limit 1`); await p.$disconnect();
  const qs = `?username=${encodeURIComponent(a[0].u)}&password=${encodeURIComponent(a[0].pw)}`;
  const n1 = await get('/api/v1/acrobits/provision'); console.log('NEG provision no-creds ->', n1.s, n1.b.replace(/\s+/g, ' ').slice(0, 80));
  const n2 = await get('/api/v1/acrobits/tab-entry'); console.log('NEG tab-entry no-creds ->', n2.s, n2.b.replace(/\s+/g, ' ').slice(0, 60));
  const x = await get('/api/v1/acrobits/provision' + qs);
  const tags = ['account', 'username', 'password', 'genericBrowserUrl', 'extProvUrl', 'extProvInterval'].filter((t) => x.b.includes('<' + t + '>'));
  const ext = (x.b.match(/<extProvUrl>([^<]+)</) || [])[1], gb = (x.b.match(/<genericBrowserUrl>([^<]+)</) || [])[1];
  console.log('POS provision with creds ->', x.s, '| tags:', tags.join(','), '| extProvUrl ->', ext ? host(ext) : '-', '| genericBrowserUrl ->', gb ? host(gb) : '-');
  const t = await get('/api/v1/acrobits/tab-entry' + qs); console.log('POS tab-entry with creds ->', t.s, '| redirect to', host(t.loc), '| tab_code in redirect:', /tab_code=/.test(t.loc));
  const h = await get('/home/' + qs); console.log('POS /home/ with creds ->', h.s, '| redirect to', host(h.loc), '| tab_code in redirect:', /tab_code=/.test(h.loc));
})().catch((e) => { console.log('ERR', String(e.message).slice(0, 160)); process.exit(1); });
