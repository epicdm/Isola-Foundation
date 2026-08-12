'use strict';
/**
 * Regression suite for the variable-host classification bypass.
 * See defect-meta-guard-variable-host-classification-bypass-2026-08-11.
 *
 * `isMetaGraphCommand()` gated Meta classification on the literal string
 * `graph.facebook.com`. So a command that hid the host in a shell variable —
 * `curl "https://$HOST/oauth/access_token"`, with HOST exported in an earlier
 * turn — never entered `evaluateMetaGraph()`, and reached a credential-minting
 * endpoint with no method check, no allowlist and no minting denial. The
 * `VARIABLE_HOST_RE` defence written for exactly that case was unreachable,
 * because the function containing it was never called.
 *
 * These assertions drive the REAL hook binary. They fail if the classification
 * widening is ever reverted, and they fail just as loudly if it is widened so
 * far that ordinary variable-host requests start being blocked.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const GUARD = path.join(__dirname, 'isola-guard.js');
const SENTINEL = 'EAA' + 'H'.repeat(44) + 'SENTINELDONOTLEAK';

function run(command) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ session_id: 'bypass-test', tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    timeout: 20000,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  let verdict = 'ALLOW';
  if (r.status === 2) verdict = 'DENY';
  else if (out.includes('"permissionDecision":"deny"')) verdict = 'DENY';
  else if (out.includes('"decision":"block"')) verdict = 'DENY';
  return { verdict, out };
}
const deny = (c) => { const r = run(c); assert.strictEqual(r.verdict, 'DENY', `expected DENY: ${c}`); return r.out; };
const allow = (c) => { const r = run(c); assert.strictEqual(r.verdict, 'ALLOW', `expected ALLOW: ${c}`); return r.out; };

const G = 'https://graph.facebook.com/v21.0';

// ---- the bypass itself, in each shape ----------------------------------
test('variable host + mint path, literal host absent', () => {
  deny('curl -s "https://$HOST/oauth/access_token?grant_type=fb_exchange_token"');
});
test('braced variable host + version path, literal host absent', () => {
  deny('curl -s "https://${META_HOST}/v21.0/123456/subscribed_apps"');
});
test('variable host + debug_token, literal host absent', () => {
  deny('curl -s "https://$H/debug_token?input_token=x"');
});
test('variable host + device/login, literal host absent', () => {
  deny('curl -s "https://$H/device/login?scope=whatsapp_business_management"');
});

// ---- residual bypass found by independent review of b2ecf20 ------------
// The first fix kept its own list of "Graph-shaped" paths and it had already
// drifted: it knew versioned URLs and a few roots, but not the UNVERSIONED
// token-minting EDGES the policy already models. Classification is now derived
// from TOKEN_MINTING_PATHS / TOKEN_MINTING_EDGES / ALLOWED_ROOT_PATHS, so
// widening a deny set widens classification automatically.
test('variable host + /me/accounts (mints a page token per page)', () => {
  deny('curl -s "https://$HOST/me/accounts?fields=id,name"');
});
test('braced variable host + /me/accounts', () => {
  deny('curl -s "https://${META_HOST}/me/accounts"');
});
test('variable host + /<id>/access_token', () => {
  deny('curl -s "https://$H/123456789/access_token"');
});
test('variable host + /<id>/app_access_token', () => {
  deny('curl -s "https://$H/123456789/app_access_token"');
});
test('variable host + /oauth/client_code', () => {
  deny('curl -s "https://$H/oauth/client_code?access_token=x"');
});
test('variable host + /device/login_status', () => {
  deny('curl -s "https://$H/device/login_status?code=x"');
});
test('token-exchange query shape alone is enough to classify', () => {
  deny('curl -s "https://$H/some/opaque/path?grant_type=fb_exchange_token&fb_exchange_token=x"');
});
test('versioned variable host + unversioned-style edge still denied', () => {
  deny('curl -s "https://$H/v21.0/me/accounts"');
});

// ---- the fix must not over-block ordinary work -------------------------
test('single-segment /accounts on an internal host is NOT a Meta shape', () => {
  allow('curl -s "https://$SVC_HOST/accounts"');
});
test('ordinary internal path containing the word token is unaffected', () => {
  allow('curl -s "https://$SVC_HOST/v2/session/refresh"');
});
test('ordinary internal API on a variable host is unaffected', () => {
  allow('curl -s "$API_URL/health"');
});
test('ordinary versioned internal API on a variable host is unaffected', () => {
  allow('curl -s "https://$SVC_HOST/api/v1/status"');
});
test('ordinary POST to a non-Meta variable host is unaffected', () => {
  allow('curl -s -X POST "https://$SVC_HOST/internal/reindex"');
});

// ---- the pre-existing policy must still hold ---------------------------
test('approved GET with allowlisted fields still passes', () => {
  allow(`curl -s '${G}/272252189309178?fields=id,name,currency'`);
});
test('subscribed_apps edge still passes', () => {
  allow(`curl -s '${G}/272252189309178/subscribed_apps'`);
});
test('webhook_configuration via -G --data-urlencode still passes', () => {
  allow(`curl -s -G '${G}/123456' --data-urlencode 'fields=webhook_configuration'`);
});
test('debug_token in env-reference form still passes', () => {
  allow(`curl -sG '${G}/debug_token' --data-urlencode "input_token=$META_SUBJECT_TOKEN" --data-urlencode "access_token=$META_GRAPH_TOKEN"`);
});
test('literal credential in a Graph query is still refused', () => {
  deny(`curl -s '${G}/debug_token?input_token=TOKEN_REF&access_token=APP_REF'`);
});
for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  test(`${m} to Graph is still denied`, () => { deny(`curl -s -X ${m} '${G}/123456'`); });
}
test('oauth/access_token with literal host is still denied', () => {
  deny(`curl -s '${G}/oauth/access_token?grant_type=fb_exchange_token'`);
});
test('/me/accounts token-minting edge is still denied', () => {
  deny(`curl -s '${G}/me/accounts?fields=id,name'`);
});
test('unknown field still fails closed', () => {
  deny(`curl -s '${G}/123456?fields=id,totally_unknown_field'`);
});
test('unknown edge still fails closed', () => {
  deny(`curl -s '${G}/123456/messages'`);
});

// ---- sentinel containment ----------------------------------------------
test('sentinel in a Graph query is denied and never echoed', () => {
  const out = deny(`curl -s '${G}/oauth/access_token?access_token=${SENTINEL}'`);
  assert.ok(!out.includes(SENTINEL), 'sentinel must never appear in guard output');
});
test('sentinel in an Authorization header is denied and never echoed', () => {
  const out = deny(`curl -s -X POST -H 'Authorization: Bearer ${SENTINEL}' '${G}/123456'`);
  assert.ok(!out.includes(SENTINEL), 'sentinel must never appear in guard output');
});
