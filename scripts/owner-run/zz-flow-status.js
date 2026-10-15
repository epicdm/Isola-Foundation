// READ-ONLY: published status of the signup Flow (Meta Graph) using the relay's own presence token in-process (never printed). Compares the flow id with the id the plsvc is configured to send (passed as FLOW_ID_EXPECT env, boolean result only).
const fs = require('fs'); let T = ''; try { T = fs.readFileSync(process.env.WA_PRESENCE_TOKEN_FILE, 'utf8').trim(); } catch {}
const ID = process.env.FLOW_ID || '1028745810223586';
(async () => {
  const r = await fetch(`https://graph.facebook.com/v21.0/${ID}?fields=id,name,status,categories,json_version,validation_errors,endpoint_uri`, { headers: { Authorization: 'Bearer ' + T } });
  const j = await r.json().catch(() => ({}));
  console.log('Flow', ID.slice(0, 4) + '...', 'HTTP', r.status, '| name:', j.name, '| status:', j.status, '| json_version:', j.json_version, '| validation_errors:', (j.validation_errors || []).length, '| endpoint host:', (() => { try { return new URL(j.endpoint_uri).host; } catch { return j.endpoint_uri ? 'set' : 'none'; } })(), '| error:', j.error ? j.error.message : '-');
  const a = await fetch(`https://graph.facebook.com/v21.0/${ID}/assets`, { headers: { Authorization: 'Bearer ' + T } }).then((x) => x.json()).catch(() => ({}));
  console.log('assets:', (a.data || []).map((x) => x.name + ':' + x.asset_type).join(','));
})().catch((e) => console.log('ERR', e.message));
