// READ-ONLY: print the published Flow JSON (v7.1) of the signup Flow to stdout (relay token read in-process, never printed). The JSON has no secrets (screen layout, copy, base64 badge images).
const fs = require('fs'); let T = ''; try { T = fs.readFileSync(process.env.WA_PRESENCE_TOKEN_FILE, 'utf8').trim(); } catch {}
const ID = process.env.FLOW_ID || '1028745810223586';
(async () => {
  const a = await fetch(`https://graph.facebook.com/v21.0/${ID}/assets`, { headers: { Authorization: 'Bearer ' + T } }).then((r) => r.json());
  const asset = (a.data || []).find((x) => x.asset_type === 'FLOW_JSON') || (a.data || [])[0];
  const flow = await fetch(asset.download_url).then((r) => r.text());
  process.stdout.write(flow);
})().catch((e) => { console.error('ERR', e.message); process.exit(2); });
