// READ-ONLY: dump the JSON of two pre-existing DRAFT flows (IDs from env FLOWS=comma list) to stdout as {id: json}. Token in-process, never printed.
const fs = require('fs'); let T = ''; try { T = fs.readFileSync(process.env.WA_PRESENCE_TOKEN_FILE, 'utf8').trim(); } catch {}
const G = 'https://graph.facebook.com/v21.0', H = { Authorization: 'Bearer ' + T };
(async () => {
  const out = {};
  for (const id of (process.env.FLOWS || '').split(',').filter(Boolean)) {
    const a = await fetch(`${G}/${id}/assets`, { headers: H }).then((r) => r.json());
    const asset = (a.data || []).find((x) => x.asset_type === 'FLOW_JSON');
    out[id] = asset ? await fetch(asset.download_url).then((r) => r.json()) : null;
  }
  process.stdout.write(JSON.stringify(out));
})().catch((e) => { console.error('ERR', e.message); process.exit(2); });
