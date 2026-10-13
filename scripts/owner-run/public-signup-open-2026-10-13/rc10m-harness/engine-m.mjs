// zz-accept-engine.mjs - ISOLATED ACCEPTANCE ONLY. A stand-in for the Uplink agent route used in the joint acceptance of relay rc10k + the candidate adapter.
// REAL: the relay-context verifier is Uplink's own source (packages/crm/src/lib/agents/mcp/relay-context.ts @ da08b734, copied byte-for-byte as relay-context.ts and run with node type stripping),
//       with the route's own expected-binding logic (route.ts lines 314-372 reproduced). The 5-turn limit answers the same 503 body. Tools are called over MCP (JSON-RPC tools/call) exactly like a BYO connector,
//       with the relay context in params._meta["com.epic.uplink/relay-context-v1"] and the connector bearer.
// STAND-IN: the model. The scripted "agent" calls pl_journey (and pl_balance when asked) on the adapter, then answers from the tool result and from the text it was given. Retention by a REAL model is proven separately.
// No credentials of the estate are used: every key here was generated for this run.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { verifyRelayContext } from './relay-context.ts';
const E = process.env, rd = (p) => fs.readFileSync(p, 'utf8').replace(/\r?\n$/, '');
const CTX_KEY = rd(E.CTX_KEY_FILE), KID = 'ctx1', ADAPTER = E.ADAPTER_URL, BEARER = rd(E.ADAPTER_BEARER_FILE), CAP_SECRET = crypto.randomBytes(32);
const WS = E.WORKSPACE_ID, AGENT = E.AGENT_ID, SLUG_ORG = 'acceptance-workspace', SLUG_AGENT = 'personal-line-whatsapp-concierge', CANON = `${SLUG_ORG}--${SLUG_AGENT}`;
const META_KEY = 'com.epic.uplink/relay-context-v1', MAX_TURNS = 5;
const convs = new Map();   // id -> { id, sessionId, channelMeta, binding, turns[], reservations }
const stats = { reservations: 0, settled: 0, refused: { limit: 0, context: 0, injected: 0 }, accepted: 0, dropped: 0, toolOk: 0, toolRefused: 0, emptyReplies: 0 };
let mode = 'normal'; let markupThen = 'normal';       // normal | refuse_next (HTTP 500 before acceptance) | drop_after_accept (accept the turn, then kill the socket) - both fire only on the NEXT NEW conversation (i.e. the rotation attempt)
const json = (rs, code, o) => { rs.writeHead(code, { 'content-type': 'application/json' }); rs.end(JSON.stringify(o)); };
const body = async (rq) => { let raw = ''; for await (const c of rq) raw += c; try { return JSON.parse(raw || '{}'); } catch { return {}; } };
const cap = (id) => crypto.createHmac('sha256', CAP_SECRET).update(id).digest('base64url');
async function callTool(name, ctxToken) {
  const r = await fetch(`${ADAPTER}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${BEARER}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {}, _meta: { [META_KEY]: ctxToken } } }) });
  const j = await r.json().catch(() => ({}));
  const text = j?.result?.content?.[0]?.text; let out = {}; try { out = JSON.parse(text); } catch {}
  return { name, isError: j?.result?.isError === true, output: out, raw: j };
}
http.createServer(async (rq, rs) => {
  const u = new URL(rq.url, 'http://x'), p = u.pathname;
  if (p === '/__admin' && rq.method === 'POST') { const b = await body(rq); mode = b.mode || 'normal'; markupThen = b.then || 'normal'; return json(rs, 200, { mode }); }
  if (p === '/__stats') return json(rs, 200, { ...stats, mode, conversations: [...convs.values()].map((c) => ({ id: c.id.slice(0, 8), turns: c.turns.filter((t) => t.role === 'assistant').length, chatwoot: c.channelMeta?.conversation_id })) });
  if (p === '/__lastuser') { const cw = u.searchParams.get('chatwoot'); const cs = [...convs.values()].filter((c) => String(c.channelMeta?.conversation_id) === String(cw)); const turns = cs.flatMap((c) => c.turns.filter((t) => t.role === 'user').map((t) => t.content)); return json(rs, 200, { count: turns.length, last: turns.at(-1) ?? null }); }
  // authenticated readback used by the relay (inspectTurn / escalation)
  if (p === '/api/v1/agents' && rq.method === 'POST') {
    const b = await body(rq); const c = convs.get(b.conversation_id); if (!c) return json(rs, 404, { error: 'not_found' });
    return json(rs, 200, { conversation: { id: c.id, orgId: WS, agentId: AGENT, anonymousSessionId: c.sessionId, channelMeta: c.channelMeta }, turns: c.turns });
  }
  const m = /^\/api\/v1\/public\/agent\/([^/]+)\/turn$/.exec(p);
  if (!(m && rq.method === 'POST')) return json(rs, 404, { error: 'not_found' });
  const b = await body(rq); const message = typeof b.message === 'string' ? b.message.trim() : '';
  if (!message) return json(rs, 400, { error: 'missing_message' });
  const isNew = !b.conversation_id; let conv = isNew ? null : convs.get(b.conversation_id);
  if (!isNew && (!conv || b.conversation_capability !== cap(conv.id))) return json(rs, 403, { error: 'invalid_conversation_capability' });
  // ---- the route's relay-proof handling (route.ts 314-372) with the REAL verifier ----
  const proof = rq.headers['x-isola-relay-context'];
  let ctxToken = null, claims = null;
  if (proof !== undefined) {
    const verified = verifyRelayContext({ token: proof, key: CTX_KEY, kid: KID, message, expected: { accountId: 2, inboxId: 11, workspaceId: WS, agentId: AGENT, agentSlug: CANON, sessionId: b.anonymous_session_id, uplinkConversationId: isNew ? null : conv.id } });
    const sameBinding = isNew || (verified.ok && conv.binding && ['accountId', 'inboxId', 'chatwootConversationId', 'workspaceId', 'agentId', 'agentSlug', 'sessionId'].every((k) => conv.binding[k] === verified.binding[k]));
    if (!verified.ok || !sameBinding) { stats.refused.context++; return json(rs, 403, { error: 'invalid_channel_context' }); }
    ctxToken = proof; claims = verified.claims;
  }
  if (mode === 'refuse_next' && isNew) { mode = 'normal'; return json(rs, 500, { error: 'upstream_error' }); }
  if (!isNew && conv.turns.filter((t) => t.role === 'assistant').length >= MAX_TURNS) { stats.refused.limit++; return json(rs, 503, { error: 'PUBLIC_CHAT_CONVERSATION_LIMIT', message: 'This chat has reached its message limit.' }); }
  if (isNew) { conv = { id: crypto.randomUUID(), sessionId: b.anonymous_session_id, channelMeta: b.channel_meta, binding: claims ? { accountId: claims.accountId, inboxId: claims.inboxId, chatwootConversationId: claims.chatwootConversationId, workspaceId: claims.workspaceId, agentId: claims.agentId, agentSlug: claims.agentSlug, sessionId: claims.sessionId } : null, turns: [] }; convs.set(conv.id, conv); }
  // ---- rc10m harness modes (STAND-IN for the Uplink runtime's request-size refusal and other degraded/failed turns) ----
  const degraded = (reason, message) => json(rs, 200, { conversation_id: conv.id, conversation_capability: cap(conv.id), message: message || 'This conversation has reached its safe context limit. Please start a new chat.', degraded: true, reason });
  if (mode === 'size_next' && !isNew) { mode = 'normal'; stats.sizeRefusals = (stats.sizeRefusals || 0) + 1; stats.reservations++; return degraded('request_too_large'); }
  if (mode === 'size_always') { stats.sizeRefusals = (stats.sizeRefusals || 0) + 1; return degraded('request_too_large'); }
  if (mode === 'genuine503_next' && !isNew) { mode = 'normal'; return json(rs, 503, { error: 'PUBLIC_CHAT_UNAVAILABLE', message: 'unavailable' }); }
  if (mode === 'llmnc_next' && !isNew) { mode = 'normal'; return degraded('llm_not_configured', 'not configured'); }
  stats.reservations++; stats.accepted++;       // spend reservation taken only after verification and the limit check, like the real route
  // ---- scripted agent: tools over MCP, then an answer built from the tool result and the text received ----
  const calls = [], results = [];
  let toolsOk = true;
  for (const t of ['pl_journey', ...(/balance/i.test(message) ? ['pl_balance'] : [])]) {
    if (!ctxToken) break;
    const r = await callTool(t, ctxToken); calls.push({ id: crypto.randomUUID(), name: `pl-action-adapter__${t}`, input: {} });
    results.push({ ok: !r.isError, output: { content: [{ text: JSON.stringify(r.output), type: 'text' }] } });
    if (r.isError) { toolsOk = false; stats.toolRefused++; } else stats.toolOk++;
  }
  if (mode === 'size_after_tools' && !isNew) { mode = 'normal'; stats.sizeRefusals = (stats.sizeRefusals || 0) + 1; stats.refusedAfterTools = (stats.refusedAfterTools || 0) + 1; return degraded('request_too_large'); }
  let reply = '';
  if (toolsOk) {
    const carried = /\[Earlier in this same WhatsApp chat/.test(message);
    const lines = message.split('\n').filter((l) => /^Customer: /.test(l));
    const intent = [...lines].reverse().find((l) => /planning|going to|want to/i.test(l));
    reply = carried && intent ? `Picking up where we left off: you told me "${intent.replace(/^Customer: /, '')}". Your line is active and ready for that.` : 'Your line is active. How can I help?';
  } else { stats.emptyReplies++; reply = ''; }   // what the real agent did when every tool call failed identity (observed live)
  if (mode === 'markup_next' && !isNew) { mode = markupThen; markupThen = 'normal'; reply = '<invoke name="pl_journey"></invoke>'; }   // a model that wrote its tool call as visible text (relay tool_markup_retry path)
  conv.turns.push({ role: 'user', content: message }); conv.turns.push({ role: 'assistant', content: reply, toolCalls: calls, toolResults: results });
  stats.settled++;
  if (mode === 'drop_after_accept' && isNew) { mode = 'normal'; stats.dropped++; rq.socket.destroy(); return; }
  return json(rs, 200, { message: reply, conversation_id: conv.id, conversation_capability: cap(conv.id) });
}).listen(3000, () => console.log('acceptance-engine listening 3000'));
