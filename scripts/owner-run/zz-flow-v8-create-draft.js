// OWNER-AUTHORIZED (coordinator relay 2026-10-14): create the DRAFT Flow 'Isola Personal Line Onboarding v8' from /tmp/flow-v8.json (inside the relay container; token in-process, never printed). NEVER publishes, NEVER sends, NEVER touches v7.1. Prints status, id, validation errors, and writes the preview URL to /tmp/flow-v8-preview.url (not printed).
const fs = require('fs'); let T = ''; try { T = fs.readFileSync(process.env.WA_PRESENCE_TOKEN_FILE, 'utf8').trim(); } catch {}
const WABA = '272252189309178', SRC = '1028745810223586', G = 'https://graph.facebook.com/v21.0', NAME = process.env.FLOW_NAME || 'Isola Personal Line Onboarding v8 - 2-tap (2026-10-14)', H = { Authorization: 'Bearer ' + T };
const err = (j) => (j && j.error ? `code ${j.error.code}/${j.error.error_subcode || '-'}: ${String(j.error.message).slice(0, 200)}${j.error.error_user_msg ? ' | ' + String(j.error.error_user_msg).slice(0, 200) : ''}` : '-');
const call = async (m, u, b, extra) => { const r = await fetch(u, { method: m, headers: { ...H, ...(b && typeof b === 'string' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: b, signal: AbortSignal.timeout(45000) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
(async () => {
  const flowJson = fs.readFileSync(process.env.FLOW_FILE || '/tmp/flow-v8.json', 'utf8');
  const existing = (await call('GET', `${G}/${WABA}/flows?fields=id,name,status&limit=100`)).j?.data || [];
  const dup = existing.filter((x) => x.name === NAME); console.log('flows in WABA:', existing.length, '| already named v8:', dup.length, dup.map((x) => x.id + ':' + x.status).join(','));
  if (dup.length) { console.log('REFUSED: a flow named v8 already exists; no write'); return; }
  const src = (await call('GET', `${G}/${SRC}?fields=endpoint_uri,categories`)).j; console.log('v7.1 endpoint host:', (() => { try { return new URL(src.endpoint_uri).host; } catch { return 'none'; } })(), '| categories:', JSON.stringify(src.categories));
  const body = new URLSearchParams({ name: NAME, categories: JSON.stringify(src.categories && src.categories.length ? src.categories : ['OTHER']), endpoint_uri: src.endpoint_uri, flow_json: flowJson }).toString();
  const cr = await call('POST', `${G}/${WABA}/flows`, body);
  console.log('CREATE v8 draft HTTP', cr.status, '| id:', cr.j?.id || '-', '| success:', cr.j?.success, '| validation_errors:', (cr.j?.validation_errors || []).length, '| err:', err(cr.j));
  (cr.j?.validation_errors || []).slice(0, 12).forEach((e) => console.log('  VERR', e.error, '|', String(e.message).slice(0, 220), '|', JSON.stringify(e.pointers || []).slice(0, 160)));
  const id = cr.j?.id; if (!id) return;
  const g = await call('GET', `${G}/${id}?fields=id,name,status,json_version,validation_errors,endpoint_uri,preview.invalidate(false)`);
  console.log('READ draft HTTP', g.status, '| status:', g.j?.status, '| json_version:', g.j?.json_version, '| validation_errors:', (g.j?.validation_errors || []).length, '| endpoint set:', Boolean(g.j?.endpoint_uri), '| preview:', Boolean(g.j?.preview?.preview_url), '| expires:', g.j?.preview?.expires_at || '-');
  (g.j?.validation_errors || []).slice(0, 12).forEach((e) => console.log('  VERR', e.error, '|', String(e.message).slice(0, 220)));
  if (g.j?.preview?.preview_url) fs.writeFileSync((process.env.PREVIEW_FILE || '/tmp/flow-v8-preview.url'), g.j.preview.preview_url, { mode: 0o600 });
  console.log('DRAFT ID:', id);
})().catch((e) => console.log('ERR', e.message));
