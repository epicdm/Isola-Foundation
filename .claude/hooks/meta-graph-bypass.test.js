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

// ---- round-2 review: PROTECTED EDGES beyond token minting --------------
// Deriving from the token-minting sets alone still left the MUTATION edges
// outside classification. With HOST=graph.facebook.com exported earlier, these
// are real Meta mutations that the guard was treating as ordinary Bash.
// Classification now derives from TOKEN_MINTING_EDGES + ALLOWED_EDGES +
// SIDE_EFFECTING_EDGES together.
test('POST /<id>/subscribed_apps on a variable host', () => {
  deny('curl -s -X POST "https://$HOST/123456/subscribed_apps"');
});
test('DELETE /<id>/subscribed_apps on a braced variable host', () => {
  deny('curl -s -X DELETE "https://${HOST}/123456/subscribed_apps"');
});
test('POST /<id>/messages on a variable host', () => {
  deny('curl -s -X POST "https://$HOST/123456/messages" --json \'{"to":"x"}\'');
});
test('GET /<id>/request_code on a variable host', () => {
  deny('curl -s "https://$H/123456/request_code"');
});
test('GET /<id>/phone_numbers on a variable host', () => {
  deny('curl -s "https://$H/123456/phone_numbers"');
});
test('explicit :443 port does not defeat classification', () => {
  deny('curl -s -X POST "https://$HOST:443/123456/subscribed_apps"');
});
test('explicit :443 port with a braced host', () => {
  deny('curl -s -X DELETE "https://${HOST}:443/123456/subscribed_apps"');
});

// ---- round-2 review: token-exchange PARAMETERS, derived --------------
// TOKEN_EXCHANGE_PARAMS is now the single source. Both inline query and
// curl-flag-supplied parameters are inspected, so a fully-variable URL whose
// only literal element is the parameter is still classified.
test('inline client_secret on a variable host', () => {
  deny('curl -s "https://$H/$EDGE?client_secret=abc"');
});
test('inline code_verifier on a variable host', () => {
  deny('curl -s "https://$H/$EDGE?code_verifier=abc"');
});
test('percent-encoded client_secret key', () => {
  deny('curl -s "https://$H/$EDGE?client%5Fsecret=abc"');
});
test('grant_type with an unanticipated value', () => {
  deny('curl -s "https://$H/$EDGE?grant_type=some_new_flow_2027"');
});
test('-G --data-urlencode client_secret', () => {
  deny('curl -sG "https://$HOST/$EDGE" --data-urlencode "client_secret=$VALUE"');
});
test('--url-query client_secret', () => {
  deny('curl -s "https://$HOST/$EDGE" --url-query "client_secret=$VALUE"');
});
test('opaque path variable with a token-exchange parameter', () => {
  deny('curl -sG "https://$H/$OPAQUE" --data-urlencode "grant_type=fb_exchange_token"');
});

// ---- round-3 review: shell parameter expansions in the authority -------
// Matching `$HOST` and `${HOST}` by pattern missed every other valid expansion.
// Detection is now structural: brace depth is tracked so a `/` inside an
// expansion does not end the authority early, and ANY `$` in the authority
// makes the destination indeterminate.
const EXPANSIONS = [
  '${HOST:?required}',
  '${HOST:-fallback.example}',
  '${HOST:+alternate.example}',
  '${HOST%/}',
  '${HOST%%suffix}',
  '${HOST#prefix}',
  '${HOST##prefix}',
  '$HOST',
  '${HOST}',
];
for (const h of EXPANSIONS) {
  test(`expansion ${h} + /subscribed_apps is denied`, () => {
    deny(`curl -s -X POST "https://${h}/123456/subscribed_apps"`);
  });
}
test('expansion with an explicit port is denied', () => {
  deny('curl -s -X POST "https://${HOST:?required}:443/123456/subscribed_apps"');
});
test('a slash inside an expansion does not end the authority early', () => {
  deny('curl -s -X POST "https://${HOST%/}:443/123456/subscribed_apps"');
});
test('expansion + /messages is denied', () => {
  deny('curl -s -X POST "https://${HOST:-fallback.example}/123456/messages"');
});

// ---- round-3 review: percent-encoded protected paths -------------------
test('percent-encoded subscribed_apps is denied', () => {
  deny('curl -s -X POST "https://$HOST/123456/%73ubscribed_apps"');
});
test('percent-encoded messages is denied', () => {
  deny('curl -s -X POST "https://$HOST/123456/m%65ssages"');
});
test('percent-encoded access_token edge is denied', () => {
  deny('curl -s "https://$HOST/123456/%61ccess_token"');
});
test('percent-encoded oauth/access_token root is denied', () => {
  deny('curl -s "https://$HOST/oauth/%61ccess_token"');
});
test('percent-encoded request_code is denied', () => {
  deny('curl -s "https://$HOST/123456/request%5Fcode"');
});
test('encoded path separator still yields real segments', () => {
  deny('curl -s -X POST "https://$HOST/123456%2Fsubscribed_apps"');
});
test('malformed percent escape fails closed', () => {
  deny('curl -s "https://$HOST/123456/%zzsubscribed"');
});

// ---- round-3 review: curl file-backed query forms ----------------------
test('--data-urlencode name@file exposes the name', () => {
  deny('curl -sG "https://$HOST/$EDGE" --data-urlencode "client_secret@params.txt"');
});
test('--data-urlencode code_verifier@file', () => {
  deny('curl -sG "https://$HOST/$EDGE" --data-urlencode "code_verifier@params.txt"');
});
test('bare @file is opaque and fails closed', () => {
  deny('curl -sG "https://$HOST/$EDGE" --data-urlencode "@params.txt"');
});
test('--url-query name@file exposes the name', () => {
  deny('curl -sG "https://$HOST/$EDGE" --url-query "client_secret@params.txt"');
});
test('attached --data-urlencode=name@file form', () => {
  deny('curl -sG "https://$HOST/$EDGE" --data-urlencode=client_secret@params.txt');
});
test('bare @file via --url-query is opaque', () => {
  deny('curl -sG "https://$HOST/$EDGE" --url-query "@params.txt"');
});

// ---- round-4 review: the classifier's ENTRY BOUNDARY --------------------
// Scanning raw contiguous URL text only classified an indeterminate authority
// when a protected LITERAL survived. A target that becomes Meta only after
// expansion never entered the policy at all. One shared analysis now decides
// both classification and denial.
test('variable host, object and protected edge', () => {
  deny('curl -s -X POST "https://$HOST/$WABA_ID/$EDGE" -H "Authorization: Bearer $META_BUSINESS_TOKEN"');
});
test('fully variable POST URL', () => {
  deny('curl -s -X POST "$META_SUBSCRIBE_URL" -H "Authorization: Bearer $META_BUSINESS_TOKEN"');
});
test('fully variable token-minting GET URL', () => {
  deny('curl -s "$META_ACCOUNTS_URL" -H "Authorization: Bearer $META_BUSINESS_TOKEN"');
});
test('braced variable host, object and edge', () => {
  deny('curl -s -X DELETE "https://${HOST}/${WABA_ID}/${EDGE}"');
});
test('variable protected final edge only', () => {
  deny('curl -s -X POST "https://$HOST/123456/$EDGE"');
});
test('partially constructed edge', () => {
  deny('curl -s -X POST "https://$HOST/123456/mess${AGES}"');
});
test('dynamically constructed parameter NAME', () => {
  deny('curl -sG "https://$HOST/$EDGE" --data-urlencode "client_${KEY}=x"');
});
test('variable scheme and authority', () => {
  deny('curl -s -X POST "${SCHEME}://${HOST}/123456/messages"');
});
test('quote-concatenated authority', () => {
  deny('curl -s -X POST https://"$HOST"/123456/messages');
});
test('command substitution authority', () => {
  deny('curl -s -X POST "https://$(get_meta_host)/123456/messages"');
});
test('backtick authority substitution', () => {
  deny('curl -s -X POST "https://`get_meta_host`/123456/messages"');
});
test('--url with a variable value', () => {
  deny('curl -s --url "$META_URL" -X POST');
});
test('attached --url=$VAR form', () => {
  deny('curl -s --url=$META_URL -X DELETE');
});
test('-K config file', () => {
  deny('curl -K meta-request.conf');
});
test('--config file', () => {
  deny('curl --config meta-request.conf');
});
test('-K reading from stdin', () => {
  deny('curl -K -');
});
test('curl-native --expand-url with an environment-backed authority', () => {
  deny('curl --variable %HOST --expand-url "https://{{HOST}}/123456/subscribed_apps" -X POST');
});
test('curl-native fully expanded target', () => {
  deny('curl --variable %TARGET --expand-url "{{TARGET}}" -X POST');
});
test('a second indeterminate transfer after --next', () => {
  deny('curl -s https://svc.internal.example/health --next -X POST "https://$HOST/$WABA/$EDGE"');
});
test('malformed target input fails closed without crashing', () => {
  deny('curl -s -X POST "https://${UNCLOSED/123456/messages"');
});

// ---- the fix must not over-block ordinary work -------------------------
test('literal internal host, ordinary GET, stays allowed', () => {
  allow('curl -s https://svc.internal.example/health');
});
test('literal internal host, ordinary POST, stays allowed', () => {
  allow('curl -s -X POST https://svc.internal.example/internal/reindex');
});
test('dynamic parameter VALUE under a fixed ordinary key stays allowed', () => {
  allow('curl -sG "https://$SVC_HOST/search" --data-urlencode "q=$USER_QUERY"');
});
test('non-request command with variables is untouched', () => {
  allow('cd $WORKTREE && git status --short');
});
test('ordinary internal host with a file-backed param stays allowed', () => {
  allow('curl -sG "https://svc.internal.example/search" --data-urlencode "q@query.txt"');
});
test('variable host with ordinary query parameters stays allowed', () => {
  allow('curl -sG "https://$SVC_HOST/search" --data-urlencode "q=hello"');
});
test('variable host with no protected parameter stays allowed', () => {
  allow('curl -s "https://$SVC_HOST/items?page=2&limit=50"');
});
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
