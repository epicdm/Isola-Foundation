// OWNER-AUTHORIZED draft work: upload a new flow.json asset to an existing DRAFT flow (id in env FLOW_ID, file /tmp/flow-update.json). Never publishes. Token in-process. Prints HTTP, success and validation errors, then re-reads the draft and writes a fresh preview URL to /tmp/flow-update-preview.url.
const fs = require('fs'); let T = ''; try { T = fs.readFileSync(process.env.WA_PRESENCE_TOKEN_FILE, 'utf8').trim(); } catch {}
const G = 'https://graph.facebook.com/v21.0', ID = process.env.FLOW_ID, H = { Authorization: 'Bearer ' + T };
(async () => {
  const g0 = await fetch(`${G}/${ID}?fields=id,name,status`, { headers: H }).then((r) => r.json());
  console.log('target:', g0.name, '|', g0.status); if (g0.status !== 'DRAFT') { console.log('REFUSED: not a DRAFT'); return; }
  const fd = new FormData(); fd.append('name', 'flow.json'); fd.append('asset_type', 'FLOW_JSON'); fd.append('file', new Blob([fs.readFileSync('/tmp/flow-update.json')], { type: 'application/json' }), 'flow.json');
  const r = await fetch(`${G}/${ID}/assets`, { method: 'POST', headers: H, body: fd }); const j = await r.json().catch(() => ({}));
  console.log('UPLOAD asset HTTP', r.status, '| success:', j.success, '| validation_errors:', (j.validation_errors || []).length, '| err:', j.error ? `code ${j.error.code}: ${String(j.error.message).slice(0, 160)}` : '-');
  (j.validation_errors || []).slice(0, 10).forEach((e) => console.log('  VERR', e.error, '|', String(e.message).slice(0, 200)));
  const g = await fetch(`${G}/${ID}?fields=id,status,validation_errors,preview.invalidate(true)`, { headers: H }).then((x) => x.json());
  console.log('READ HTTP ok | status', g.status, '| validation_errors', (g.validation_errors || []).length, '| preview', Boolean(g.preview?.preview_url));
  if (g.preview?.preview_url) fs.writeFileSync('/tmp/flow-update-preview.url', g.preview.preview_url, { mode: 0o600 });
})().catch((e) => console.log('ERR', e.message));
