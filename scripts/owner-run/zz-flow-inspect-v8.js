// READ-ONLY: inspect the pre-existing draft Flow named 'Isola Personal Line Onboarding v8' and list all flows (id, name, status). Token in-process, never printed.
const fs = require('fs'); let T = ''; try { T = fs.readFileSync(process.env.WA_PRESENCE_TOKEN_FILE, 'utf8').trim(); } catch {}
const G = 'https://graph.facebook.com/v21.0', H = { Authorization: 'Bearer ' + T }, ID = '1063932616548574', WABA = '272252189309178';
(async () => {
  const all = await fetch(`${G}/${WABA}/flows?fields=id,name,status,updated_at,json_version&limit=100`, { headers: H }).then((r) => r.json());
  (all.data || []).forEach((x) => console.log(' ', x.id, '|', x.status, '|', x.name, '|', x.updated_at || '-', '|', x.json_version || '-'));
  const g = await fetch(`${G}/${ID}?fields=id,name,status,json_version,validation_errors,endpoint_uri,updated_at`, { headers: H }).then((r) => r.json());
  console.log('draft', ID, 'status', g.status, '| updated_at', g.updated_at, '| validation_errors', (g.validation_errors || []).length, '| endpoint set', Boolean(g.endpoint_uri), '| json_version', g.json_version);
  const a = await fetch(`${G}/${ID}/assets`, { headers: H }).then((r) => r.json());
  const asset = (a.data || []).find((x) => x.asset_type === 'FLOW_JSON');
  if (asset) { const j = await fetch(asset.download_url).then((r) => r.json()); console.log('draft JSON version', j.version, '| screens:', (j.screens || []).map((s) => s.id).join(','), '| first heading texts:', JSON.stringify((j.screens || []).slice(0, 3).map((s) => JSON.stringify(s.layout).match(/"text":"([^"]{0,60})/)?.[1])) ); }
})().catch((e) => console.log('ERR', e.message));
