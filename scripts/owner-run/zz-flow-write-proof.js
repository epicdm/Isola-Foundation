// OWNER-AUTHORIZED (coordinator relay 2026-10-14) WRITE-PATH PROOF for WhatsApp Flows: create ONE throwaway DRAFT clone of the published v7.1 Flow, read it, fetch its preview link, then DELETE it (never published, never sent). Runs INSIDE the relay container with the relay's own WhatsApp token read in-process (never printed).
// Steps print only HTTP status + Meta error code/message (no token). Aborts cleanly; always attempts the delete of anything it created.
const fs = require('fs'); let T = ''; try { T = fs.readFileSync(process.env.WA_PRESENCE_TOKEN_FILE, 'utf8').trim(); } catch {}
const WABA = process.env.WABA_ID || '272252189309178', SRC = process.env.SRC_FLOW || '1028745810223586', G = 'https://graph.facebook.com/v21.0';
const H = { Authorization: 'Bearer ' + T };
const err = (j) => (j && j.error ? `code ${j.error.code}/${j.error.error_subcode || '-'}: ${String(j.error.message).slice(0, 160)}` : '-');
async function call(method, url, body) {
  const r = await fetch(url, { method, headers: { ...H, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body, signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({})); return { status: r.status, j };
}
(async () => {
  console.log('token present:', Boolean(T));
  const dbg = await call('GET', `${G}/debug_token?input_token=${encodeURIComponent(T)}`); // scopes only
  console.log('debug_token HTTP', dbg.status, '| type:', dbg.j?.data?.type, '| scopes:', (dbg.j?.data?.scopes || []).filter((s) => /whatsapp/.test(s)).join(',') || '(none listed)', '| valid:', dbg.j?.data?.is_valid, '| err:', err(dbg.j));
  const rd = await call('GET', `${G}/${SRC}?fields=id,name,status`); console.log('READ source flow HTTP', rd.status, rd.j?.name, rd.j?.status, '| err:', err(rd.j));
  const ctrl = await call('GET', `${G}/${WABA}/flows?fields=id,name,status&limit=50`); console.log('LIST flows of the WABA HTTP', ctrl.status, '| count:', (ctrl.j?.data || []).length, '| err:', err(ctrl.j));
  const body = new URLSearchParams({ name: 'ZZ-WRITE-TEST-delete-me-2026-10-14', categories: JSON.stringify(['OTHER']), clone_flow_id: SRC }).toString();
  const cr = await call('POST', `${G}/${WABA}/flows`, body);
  console.log('CREATE draft (clone) HTTP', cr.status, '| id:', cr.j?.id || '-', '| validation_errors:', JSON.stringify((cr.j?.validation_errors || []).slice(0, 2)).slice(0, 200), '| err:', err(cr.j));
  const id = cr.j?.id;
  if (id) {
    const g = await call('GET', `${G}/${id}?fields=id,name,status,json_version,validation_errors,endpoint_uri,preview.invalidate(false)`);
    console.log('READ draft HTTP', g.status, '| name:', g.j?.name, '| status:', g.j?.status, '| json_version:', g.j?.json_version, '| validation_errors:', (g.j?.validation_errors || []).length, '| endpoint_uri present:', Boolean(g.j?.endpoint_uri), '| preview url present:', Boolean(g.j?.preview?.preview_url), '| err:', err(g.j));
    if (g.j?.preview?.preview_url) console.log('PREVIEW HOST:', new URL(g.j.preview.preview_url).host, '(url itself not printed here)');
    const as = await call('GET', `${G}/${id}/assets`); console.log('LIST draft assets HTTP', as.status, (as.j?.data || []).map((x) => x.name).join(','), '| err:', err(as.j));
    const dl = await call('DELETE', `${G}/${id}`); console.log('DELETE draft HTTP', dl.status, '| success:', dl.j?.success, '| err:', err(dl.j));
    const after = await call('GET', `${G}/${id}?fields=id,status`); console.log('READ after delete HTTP', after.status, '| (expect an error: gone) err:', err(after.j));
  }
  const fin = await call('GET', `${G}/${WABA}/flows?fields=id,name,status&limit=50`); const left = (fin.j?.data || []).filter((x) => /ZZ-WRITE-TEST/.test(x.name)); console.log('LEFTOVER test flows after run:', left.length, '| total flows:', (fin.j?.data || []).length);
})().catch((e) => console.log('ERR', e.message));
