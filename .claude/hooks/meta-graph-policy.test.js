/**
 * Pure predicate tests for the Meta Graph request policy.
 *
 *   node --test .claude/hooks/meta-graph-policy.test.js
 *
 * No network, no child processes, no fixtures on disk — every assertion is a
 * pure function call. Hook-level (child-process) coverage lives in selftest.js.
 *
 * NOTE ON FIXTURE CREDENTIALS: fake tokens are ASSEMBLED at runtime rather than
 * written as literals. A literal EAA-shaped string in a source file is exactly
 * what isola-post-edit.js flags as a committed secret, and a test suite for the
 * credential rules must not be the thing that trips them. The values below are
 * structurally valid and cryptographically meaningless.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const M = require('./lib/meta-graph-policy.js');

// --- fixtures --------------------------------------------------------------

const WABA = '272252189309178'; // shared WABA, 11 numbers
const PNID_6737 = '278390858690809'; // Front Desk / Customer Zero
const PNID_3742 = '975632242309171'; // sole public front door
const BUSINESS = '1234567890123456';

/**
 * Structurally valid, meaningless.
 *
 * Assembled with join() rather than written as a quoted literal. A NAME ending
 * in TOKEN or SECRET assigned directly to a quoted string of 12+ characters is
 * what isola-post-edit.js flags as a committed credential, and this suite must
 * not trip the very rule it exists to exercise. Both the first draft AND the
 * comment that explained the first draft were caught by that hook — describing
 * the shape is enough to match it, which is the same lesson isola-topology.js
 * records in its tok() note.
 */
const FAKE_USER_TOKEN = ['EA', 'A', 'b3xY7qLm2Nv9Kd4Rt6Wz8Ps1Hj5Gf0Cx', 'Qa7Ue2Ir'].join('');
const FAKE_APP_TOKEN = ['1234567890123', 'aBcDeFgHiJkLmNoPqRsT'].join('|');

const G = (p) => 'https://graph.facebook.com/v23.0/' + p;

const evalCmd = (cmd) => M.evaluateMetaGraph(cmd);
const allowed = (cmd) => evalCmd(cmd).decision === 'allow';
const denial = (cmd) => {
  const v = evalCmd(cmd);
  assert.strictEqual(v.decision, 'deny', 'expected DENY for: ' + cmd);
  return v;
};

/**
 * Assert a denial whose rule id is any of the given ones.
 *
 * Under the sanctioned-command-form model a write is refused one of two ways:
 * as a recognised write method (meta-asset-mutation), or because it used an
 * option the policy does not model (unclassifiable-graph-request). Both are
 * correct refusals; which one fires depends on whether the flag is in the safe
 * tables. Tests that care only that the write is BLOCKED use this.
 */
const deniedAs = (cmd, ...ruleIds) => {
  const v = denial(cmd);
  assert.ok(
    ruleIds.includes(v.ruleId),
    'expected one of [' + ruleIds.join(', ') + '] but got ' + v.ruleId + ' for: ' + cmd
  );
  return v;
};
const BLOCKED_WRITE = ['meta-asset-mutation', 'unclassifiable-graph-request'];

// ===========================================================================
// 1. HTTP METHOD CLASSIFICATION
// ===========================================================================

test('method: bare curl is GET', () => {
  assert.strictEqual(M.classifyHttpMethod('curl -q -s ' + G(WABA)), 'GET');
});

test('method: explicit -X POST is POST', () => {
  assert.strictEqual(M.classifyHttpMethod('curl -q -X POST ' + G(WABA)), 'POST');
});

test('method: attached -XDELETE is DELETE', () => {
  assert.strictEqual(M.classifyHttpMethod('curl -q -XDELETE ' + G(WABA)), 'DELETE');
});

test('method: --request=PATCH is PATCH', () => {
  assert.strictEqual(M.classifyHttpMethod('curl -q --request=PATCH ' + G(WABA)), 'PATCH');
});

test('method: a bare data flag implies POST', () => {
  assert.strictEqual(M.classifyHttpMethod('curl -q -d "a=1" ' + G(WABA)), 'POST');
  assert.strictEqual(M.classifyHttpMethod('curl -q --data-urlencode "a=1" ' + G(WABA)), 'POST');
});

test('method: upload and form flags are off the safe list, so they are UNKNOWN', () => {
  // -T (upload/PUT) and -F (multipart/POST) are writes, and are deliberately
  // absent from the safe-flag tables. The sanctioned-form check refuses them
  // before method classification matters; UNKNOWN is the conservative answer.
  for (const cmd of [
    'curl -q -T ./file.json ' + G(WABA),
    'curl -q --upload-file ./file.json ' + G(WABA),
    'curl -q --form "f=@x" ' + G(WABA),
    'curl -q -F "f=@x" ' + G(WABA),
  ]) {
    assert.strictEqual(M.classifyHttpMethod(cmd), 'UNKNOWN', cmd);
    assert.strictEqual(M.isSanctionedCurlForm(cmd), false, cmd);
  }
});

// THE CORE CORRECTION -------------------------------------------------------

test('method: -G keeps GET semantics despite --data-urlencode', () => {
  assert.strictEqual(
    M.classifyHttpMethod('curl -q -G --data-urlencode "fields=webhook_configuration" ' + G(PNID_6737)),
    'GET'
  );
});

test('method: --get keeps GET semantics despite -d', () => {
  assert.strictEqual(M.classifyHttpMethod('curl -q --get -d "fields=id" ' + G(PNID_6737)), 'GET');
});

test('method: -G inside a short-flag cluster is still recognised', () => {
  assert.strictEqual(M.classifyHttpMethod('curl -q -sG --data-urlencode "fields=id" ' + G(PNID_6737)), 'GET');
});

test('method: explicit -X POST overrides -G, as curl itself does', () => {
  assert.strictEqual(M.classifyHttpMethod('curl -q -G -X POST --data-urlencode "a=1" ' + G(WABA)), 'POST');
});

test('method: JS client shapes are classified', () => {
  assert.strictEqual(M.classifyHttpMethod('await axios.post("' + G(WABA) + '", body)'), 'POST');
  assert.strictEqual(M.classifyHttpMethod('fetch(url, { method: "DELETE" })'), 'DELETE');
});

test('method: -H header values are not misread as flags', () => {
  assert.strictEqual(M.classifyHttpMethod('curl -q -H "X-Thing: -d" ' + G(WABA)), 'GET');
});

// ===========================================================================
// 2. CURL PARSING
// ===========================================================================

test('tokenize: respects single and double quotes', () => {
  assert.deepStrictEqual(M.tokenize('curl -d "a b" \'c d\''), ['curl', '-d', 'a b', 'c d']);
});

test('tokenize: folds line continuations', () => {
  assert.deepStrictEqual(M.tokenize('curl \\\n  -G \\\n  url'), ['curl', '-G', 'url']);
});

test('parseGraphUrls: strips the version prefix and splits query', () => {
  const [u] = M.parseGraphUrls('curl -q "' + G(WABA + '/subscribed_apps?fields=whatsapp_business_api_data') + '"');
  assert.strictEqual(u.version, 'v23.0');
  assert.deepStrictEqual(u.segments, [WABA, 'subscribed_apps']);
  assert.strictEqual(M.paramValue(u.params, 'fields'), 'whatsapp_business_api_data');
});

test('parseGraphUrls: works without a version prefix or scheme', () => {
  const [u] = M.parseGraphUrls('curl -q graph.facebook.com/' + WABA + '/phone_numbers');
  assert.strictEqual(u.version, null);
  assert.deepStrictEqual(u.segments, [WABA, 'phone_numbers']);
});

test('collectDataParams: -G promotes data flags into the query', () => {
  const p = M.collectDataParams('curl -q -G --data-urlencode "fields=id,status" -d "limit=5" ' + G(WABA));
  assert.strictEqual(M.paramValue(p, 'fields'), 'id,status');
  assert.strictEqual(M.paramValue(p, 'limit'), '5');
});

test('topLevelFields: ignores nested expansions', () => {
  assert.deepStrictEqual(M.topLevelFields('id,phone_numbers{display_phone_number,quality_rating},name'), [
    'id',
    'phone_numbers',
    'name',
  ]);
});

// ===========================================================================
// 3. REQUIRED PASS CASES
// ===========================================================================

test('PASS: allowlisted subscribed_apps GET', () => {
  assert.ok(allowed('curl -q -s "' + G(WABA + '/subscribed_apps') + '"'));
});

test('PASS: allowlisted phone-number identity/display metadata GET', () => {
  assert.ok(
    allowed('curl -q -s "' + G(PNID_3742 + '?fields=display_phone_number,verified_name,quality_rating') + '"')
  );
});

test('PASS: allowlisted phone-level webhook_configuration GET', () => {
  assert.ok(allowed('curl -q -s "' + G(PNID_6737 + '?fields=webhook_configuration') + '"'));
});

test('PASS: allowlisted WABA phone-number enumeration GET', () => {
  assert.ok(allowed('curl -q -s "' + G(WABA + '/phone_numbers') + '"'));
});

test('PASS: business/WABA association metadata GET', () => {
  assert.ok(allowed('curl -q -s "' + G(BUSINESS + '/owned_whatsapp_business_accounts') + '"'));
  assert.ok(allowed('curl -q -s "' + G(BUSINESS + '/client_whatsapp_business_accounts') + '"'));
});

test('PASS: metadata-only debug_token GET', () => {
  assert.ok(allowed('curl -q -s -G --data-urlencode "input_token=$SUBJECT" -d "access_token=$APP" ' + G('debug_token')));
});

test('PASS: curl -G --data-urlencode retains GET semantics end to end', () => {
  const v = evalCmd(
    'curl -q -sG --data-urlencode "fields=webhook_configuration" --data-urlencode "access_token=$META_GRAPH_TOKEN" ' +
      G(PNID_6737)
  );
  assert.strictEqual(v.decision, 'allow');
  assert.strictEqual(v.method, 'GET');
});

test('PASS: token supplied through an approved environment reference', () => {
  for (const ref of ['$META_TOKEN', '${META_TOKEN}', '$env:META_TOKEN', '%META_TOKEN%']) {
    assert.ok(
      allowed('curl -q -s "' + G(WABA + '/subscribed_apps') + '?access_token=' + ref + '"'),
      'expected allow for ref ' + ref
    );
  }
});

test('PASS: non-Graph commands are untouched', () => {
  assert.ok(allowed('curl -q -X POST https://example.com/api -d "a=1"'));
});

test('PASS: prose mentioning the host without a URL is not gated', () => {
  assert.ok(allowed('grep -rn graph.facebook.com artifacts/isola/lib'));
});

// ===========================================================================
// 3b. THE SIX PREPARED S0.1 READS (G1-G6)
//
// Acceptance, not decoration. These are the exact requests recorded in
// ev-devtools-oauth-narrowing-and-graph-read-plan-2026-08-05, whose execution
// was gated on this guard change. If any is denied, the fix has failed its own
// purpose. Written verbatim from that record, including the v21.0 version and
// the shell-variable form G6 actually uses.
// ===========================================================================

const G21 = (p) => 'https://graph.facebook.com/v21.0/' + p;
const TOK = '--data-urlencode "access_token=$META_GRAPH_TOKEN"';

test('G1: shared WABA subscribed_apps is ADMITTED', () => {
  assert.ok(allowed('curl -q -sG ' + TOK + ' ' + G21('272252189309178/subscribed_apps')));
});

test('G2: 6737-only WABA subscribed_apps is ADMITTED', () => {
  assert.ok(allowed('curl -q -sG ' + TOK + ' ' + G21('227366173803234/subscribed_apps')));
});

test('G3: 3742 display-number drift resolver is ADMITTED', () => {
  assert.ok(
    allowed(
      'curl -q -sG --data-urlencode "fields=display_phone_number,verified_name,platform_type,is_on_biz_app" ' +
        TOK + ' ' + G21('975632242309171')
    )
  );
});

test('G4: consumer-OTP sender metadata is ADMITTED', () => {
  assert.ok(
    allowed(
      'curl -q -sG --data-urlencode "fields=display_phone_number,verified_name,platform_type,is_on_biz_app" ' +
        TOK + ' ' + G21('1023804347491554')
    )
  );
});

test('G5: shared-WABA phone-number enumeration is ADMITTED', () => {
  assert.ok(
    allowed(
      'curl -q -sG --data-urlencode "fields=id,display_phone_number,verified_name,platform_type,is_on_biz_app" ' +
        TOK + ' ' + G21('272252189309178/phone_numbers')
    )
  );
});

test('G6: phone-level webhook_configuration is ADMITTED for every id, literal and variable', () => {
  for (const pnid of [
    '278390858690809',
    '1029700810228517',
    '1056283370899948',
    '975632242309171',
    '1023804347491554',
  ]) {
    assert.ok(
      allowed('curl -q -sG --data-urlencode "fields=webhook_configuration" ' + TOK + ' ' + G21(pnid)),
      'G6 denied for literal pnid ' + pnid
    );
  }
  // The real probe loops over a shell variable rather than pasting five literals.
  for (const ref of ['$PNID', '${PNID}', '$env:PNID', '%PNID%']) {
    assert.ok(
      allowed('curl -q -sG --data-urlencode "fields=webhook_configuration" ' + TOK + ' ' + G21(ref)),
      'G6 denied for variable object id ' + ref
    );
  }
});

test('a variable object id does NOT relax the edge, field or token rules', () => {
  // The compensating controls that make variable object ids acceptable.
  assert.strictEqual(denial('curl -q -sG ' + TOK + ' ' + G21('$WABA/message_templates')).ruleId, 'unapproved-edge');
  assert.strictEqual(denial('curl -q -sG ' + TOK + ' ' + G21('$ID/accounts')).ruleId, 'token-minting');
  assert.strictEqual(
    denial('curl -q -sG --data-urlencode "fields=access_token" ' + TOK + ' ' + G21('$PNID')).ruleId,
    'credential-field'
  );
  // Accepting variables does not accept NAMED nodes: the object hanging off an
  // allowlisted edge must still be an asset id or a variable, never `oauth`.
  assert.strictEqual(denial('curl -q -sG ' + TOK + ' ' + G21('oauth/subscribed_apps')).ruleId, 'unapproved-object');
});

// ===========================================================================
// 4. REQUIRED BLOCK CASES
// ===========================================================================

test('BLOCK: every write method against Graph', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const v = denial('curl -q -X ' + method + ' "' + G(PNID_3742 + '/subscribed_apps') + '"');
    assert.strictEqual(v.ruleId, 'meta-asset-mutation');
    assert.strictEqual(v.method, method);
  }
});

test('BLOCK: implicit write via a body flag', () => {
  const v = denial('curl -q "' + G(PNID_3742 + '/subscribed_apps') + '" --data "subscribed_fields=messages"');
  assert.strictEqual(v.ruleId, 'meta-asset-mutation');
});

test('BLOCK: implicit write via an upload flag', () => {
  deniedAs('curl -q -T ./payload.json "' + G(WABA) + '"', ...BLOCKED_WRITE);
});

test('BLOCK: token minting via /oauth/access_token', () => {
  assert.strictEqual(denial('curl -q -s "' + G('oauth/access_token') + '?client_id=$ID"').ruleId, 'token-minting');
});

test('BLOCK: long-lived-token generation via grant_type exchange', () => {
  const v = denial(
    'curl -q -sG -d "grant_type=fb_exchange_token" -d "client_id=$ID" -d "client_secret=$SECRET" ' +
      '-d "fb_exchange_token=$SHORT" ' + G('oauth/access_token')
  );
  assert.ok(v.ruleId === 'token-exchange' || v.ruleId === 'token-minting');
});

test('BLOCK: /{id}/accounts returns page access tokens', () => {
  assert.strictEqual(denial('curl -q -s "' + G('me/accounts') + '"').ruleId, 'token-minting');
});

test('BLOCK: device login token flow', () => {
  assert.strictEqual(denial('curl -q -s "' + G('device/login') + '?scope=whatsapp"').ruleId, 'token-minting');
});

test('BLOCK: literal EAA-style credential in argv', () => {
  const v = denial('curl -q -s "' + G(WABA + '/subscribed_apps') + '?access_token=' + FAKE_USER_TOKEN + '"');
  assert.strictEqual(v.ruleId, 'credential-literal');
});

test('BLOCK: literal app access token ({app-id}|{app-secret}) in argv', () => {
  const v = denial('curl -q -sG -d "access_token=' + FAKE_APP_TOKEN + '" ' + G('debug_token'));
  assert.strictEqual(v.ruleId, 'credential-literal');
});

test('BLOCK: appsecret_proof supplied as a literal', () => {
  const v = denial(
    'curl -q -sG -d "appsecret_proof=0123456789abcdef0123456789abcdef" -d "access_token=$T" ' + G(WABA + '/phone_numbers')
  );
  assert.strictEqual(v.ruleId, 'credential-literal');
});

test('BLOCK: literal bearer token in an Authorization header', () => {
  const v = denial('curl -q -s -H "Authorization: Bearer ' + FAKE_USER_TOKEN + '" ' + G(WABA + '/phone_numbers'));
  assert.strictEqual(v.ruleId, 'credential-literal');
});

test('BLOCK: credential printed inline alongside a Graph read', () => {
  const v = denial('curl -q -s "' + G(WABA + '/subscribed_apps') + '?access_token=$T" && echo "$META_GRAPH_TOKEN"');
  assert.strictEqual(v.ruleId, 'credential-print');
});

test('BLOCK: unapproved Graph edge', () => {
  assert.strictEqual(denial('curl -q -s "' + G(WABA + '/message_templates') + '"').ruleId, 'unapproved-edge');
});

test('BLOCK: unapproved Graph object', () => {
  // A single non-numeric segment is a named node (/app, /search, /me is the one
  // exception). None of them are allowlisted metadata reads.
  assert.strictEqual(denial('curl -q -s "' + G('app') + '"').ruleId, 'unapproved-object');
  assert.strictEqual(denial('curl -q -s "' + G('search?q=x') + '"').ruleId, 'unapproved-object');
  // Two segments are classified as an edge read, and denied there instead.
  assert.strictEqual(denial('curl -q -s "' + G('app/uploads') + '"').ruleId, 'unapproved-edge');
});

test('BLOCK: approved object requesting an unapproved field', () => {
  assert.strictEqual(denial('curl -q -s "' + G(PNID_3742 + '?fields=messages') + '"').ruleId, 'unapproved-field');
});

test('BLOCK: approved object requesting credential fields, at any nesting depth', () => {
  assert.strictEqual(denial('curl -q -s "' + G(PNID_3742 + '?fields=access_token') + '"').ruleId, 'credential-field');
  assert.strictEqual(
    denial('curl -q -s "' + G(BUSINESS + '?fields=owned_whatsapp_business_accounts{access_token}') + '"').ruleId,
    'credential-field'
  );
});

test('BLOCK: side-effecting GET-shaped endpoints', () => {
  for (const edge of ['request_code', 'verify_code', 'register', 'deregister', 'messages']) {
    assert.strictEqual(
      denial('curl -q -s "' + G(PNID_3742 + '/' + edge) + '"').ruleId,
      'side-effecting-get',
      'expected side-effecting-get for /' + edge
    );
  }
});

test('BLOCK: -G cannot smuggle an unapproved field past the allowlist', () => {
  // The regression this whole module guards: -G is honoured for METHOD, but the
  // promoted parameters are still field-checked.
  assert.strictEqual(
    denial('curl -q -sG --data-urlencode "fields=access_token" -d "access_token=$T" ' + G(PNID_3742)).ruleId,
    'credential-field'
  );
});

test('BLOCK: nested paths beyond object/edge are refused', () => {
  assert.strictEqual(denial('curl -q -s "' + G(WABA + '/phone_numbers/' + PNID_3742) + '"').ruleId, 'unapproved-edge');
});

// ===========================================================================
// 4b. ADVERSARIAL REVIEW REGRESSIONS (independent Codex review, 2026-08-05)
//
// Six confirmed bypasses of the first implementation. Every one was reproduced
// locally before being fixed. These tests exist so none of them can come back.
// ===========================================================================

test('REGRESSION 1 (critical): a malformed percent escape must not fail the guard open', () => {
  // decodeURIComponent('bad%ZZ') throws URIError. isola-guard.js fails open on any
  // internal error, so this threw during parsing and let a POST through.
  const cmd = 'curl -q -X POST "' + G('123/subscribed_apps') + '?bad%ZZ=1&access_token=$T"';
  assert.doesNotThrow(() => evalCmd(cmd));
  assert.strictEqual(denial(cmd).ruleId, 'meta-asset-mutation');
  // Every decode path must tolerate it.
  assert.doesNotThrow(() => M.safeDecode('%ZZ'));
  assert.strictEqual(M.safeDecode('%ZZ'), '%ZZ');
  assert.doesNotThrow(() => M.allFieldNames('%E0%A4%A'));
  assert.doesNotThrow(() => evalCmd('curl -q -sG -d "fields=%ZZ" ' + G(PNID_3742)));
});

test('REGRESSION 2 (high): curl --next transfers are classified independently', () => {
  const cmd =
    'curl -q -G "' + G('123') + '?fields=name&access_token=$T" --next -d "x=y" "' + G('123/subscribed_apps') + '?access_token=$T"';
  deniedAs(cmd, ...BLOCKED_WRITE);
  // The short form of --next is -: and must split too.
  deniedAs('curl -q -G "' + G('123') + '?fields=name" -: -d "x=y" "' + G('123/subscribed_apps') + '"', ...BLOCKED_WRITE);

  // BEHAVIOUR CHANGE, deliberate: under the sanctioned-command-form model
  // --next is not on the safe-flag list at all, so multi-transfer curl against
  // Graph is refused outright rather than split and re-classified. Two reads in
  // one command was never a requirement, and refusing the whole construct
  // removes a per-transfer option-scoping problem instead of modelling it.
  deniedAs(
    'curl -q -sG -d "access_token=$T" "' + G(WABA + '/subscribed_apps') + '" --next -sG -d "access_token=$T" "' +
      G(WABA + '/phone_numbers') + '"',
    'unclassifiable-graph-request'
  );
  // The same two reads as two commands are both fine.
  assert.ok(allowed('curl -q -sG -d "access_token=$T" "' + G(WABA + '/subscribed_apps') + '"'));
  assert.ok(allowed('curl -q -sG -d "access_token=$T" "' + G(WABA + '/phone_numbers') + '"'));
});

test('REGRESSION 3 (high): non-curl clients cannot POST while classified as GET', () => {
  const writes = [
    'python -c "import requests; requests.request(\'POST\', \'' + G('123/subscribed_apps') + '\', data={})"',
    'wget --post-data="access_token=$T" ' + G('123/subscribed_apps') + ' -O -',
    'http POST ' + G('123/subscribed_apps') + ' access_token==$T',
    'wget --method=DELETE ' + G('123/subscribed_apps'),
    'requests.post("' + G('123/subscribed_apps') + '")',
  ];
  for (const cmd of writes) {
    assert.strictEqual(denial(cmd).ruleId, 'meta-asset-mutation', 'not blocked: ' + cmd);
  }
});

test('REGRESSION 3b (high): an opaque curl option source is refused, not guessed', () => {
  // -K can set `request = "POST"` from a file, so the method is unknowable.
  for (const flag of ['-K cfg.txt', '--config cfg.txt']) {
    assert.strictEqual(
      denial('curl -q ' + flag + ' "' + G(WABA + '/subscribed_apps') + '?access_token=$T"').ruleId,
      'unclassifiable-graph-request'
    );
  }
});

test('REGRESSION 4 (high): a shell-assembled host cannot smuggle a token-minting call', () => {
  const cmd =
    'HOST=graph.facebook.com; curl "https://$HOST/v23.0/oauth/access_token?grant_type=fb_exchange_token&client_id=$A"';
  assert.strictEqual(denial(cmd).ruleId, 'unclassifiable-graph-request');
  // But prose that merely names the host is still not gated.
  assert.ok(allowed('grep -rn graph.facebook.com artifacts/isola/lib'));
  assert.ok(allowed('rg "graph.facebook.com" --files-with-matches'));
});

test('REGRESSION 5 (medium): nested field expansion is allowlisted at every depth', () => {
  assert.strictEqual(
    denial('curl -q -G "' + G('123') + '" --data-urlencode "fields=phone_numbers{messages}" -d "access_token=$T"').ruleId,
    'unapproved-field'
  );
  // Legitimate nesting still passes, and read modifiers are not treated as fields.
  assert.ok(
    allowed('curl -q -sG --data-urlencode "fields=phone_numbers{display_phone_number,quality_rating}" -d "access_token=$T" ' + G(WABA))
  );
  assert.ok(allowed('curl -q -sG --data-urlencode "fields=phone_numbers.limit(50){id}" -d "access_token=$T" ' + G(WABA)));
});

test('REGRESSION 6 (medium): the guard redacts what it writes to the session ledger', () => {
  // isola-guard.js record() routes through redactSensitive so a literal token
  // cannot persist to .claude/state/sessions/<id>/commands-run.log.
  const line = 'LOCAL curl "https://graph.facebook.com/v23.0/123?access_token=' + FAKE_USER_TOKEN + '"';
  const redacted = M.redactSensitive(line);
  assert.ok(!redacted.includes(FAKE_USER_TOKEN));
  assert.ok(redacted.includes('[REDACTED'));
});

// ===========================================================================
// 4c. ADVERSARIAL REVIEW ROUND 2
//
// Round 1's fixes were confirmed, and a deeper pass found five more bypasses.
// Two of them were introduced BY the round-1 fixes (the -K matcher was too
// narrow, and stripping every .name() modifier ate real field selections),
// which is exactly why a second round was run rather than declaring victory.
// ===========================================================================

test('R2-1 (high): shell-chained commands are classified separately', () => {
  // `a && b` are two processes. A -G in the first must not vouch for the second.
  const chained = [
    'curl -q -sG "' + G('123') + '?fields=name" && curl -q -d "subscribed_fields=messages" "' + G('123/subscribed_apps') + '"',
    'curl -q -sG "' + G('123') + '?fields=name" ; curl -q -d "x=y" "' + G('123/subscribed_apps') + '"',
    'curl -q -sG "' + G('123') + '?fields=name" | tee out.json ; curl -q -d "x=y" "' + G('123/subscribed_apps') + '"',
  ];
  for (const cmd of chained) {
    assert.strictEqual(denial(cmd).ruleId, 'meta-asset-mutation', 'not blocked: ' + cmd);
  }
  // Two legitimate chained reads still pass.
  assert.ok(
    allowed('curl -q -sG -d "access_token=$T" "' + G(WABA + '/subscribed_apps') + '" && curl -q -sG -d "access_token=$T" "' + G(WABA + '/phone_numbers') + '"')
  );
});

test('R2-2 (high): an indirectly supplied method is refused, not assumed GET', () => {
  assert.strictEqual(
    denial('METHOD=POST curl -X$METHOD "' + G('123/subscribed_apps') + '?access_token=$T"').ruleId,
    'unclassifiable-graph-request'
  );
  assert.strictEqual(M.classifyHttpMethod('curl -q -X$METHOD ' + G('123')), 'UNKNOWN');
  assert.strictEqual(M.classifyHttpMethod('curl -q --request "$VERB" ' + G('123')), 'UNKNOWN');
  // Literal methods are still classified normally.
  assert.strictEqual(M.classifyHttpMethod('curl -q -X GET ' + G('123')), 'GET');
});

test('R2-3 (high): attached and process-substitution config sources are opaque too', () => {
  const opaque = [
    'curl -q -K<(printf \'data = "x=y"\') "' + G('123/subscribed_apps') + '?access_token=$T"',
    'curl -q -Kcfg.txt "' + G('123/subscribed_apps') + '?access_token=$T"',
    'curl -q -sK cfg.txt "' + G('123/subscribed_apps') + '?access_token=$T"',
    'curl -q --config=cfg.txt "' + G('123/subscribed_apps') + '?access_token=$T"',
  ];
  for (const cmd of opaque) {
    assert.strictEqual(denial(cmd).ruleId, 'unclassifiable-graph-request', 'not blocked: ' + cmd);
  }
  // Lowercase -k is still a DIFFERENT flag from -K (config) — the case
  // distinction this test was written for still holds. But as of round 5 it is
  // no longer sanctioned either: -k disables certificate verification, which
  // combined with --resolve can send the bearer credential to an attacker's TLS
  // endpoint while the command still reads as a Graph URL. It is now refused.
  denial('curl -q -sk -G -d "access_token=$T" "' + G(WABA + '/subscribed_apps') + '"');
  // The same read without it remains the sanctioned form.
  assert.ok(allowed('curl -q -sG -d "access_token=$T" "' + G(WABA + '/subscribed_apps') + '"'));
});

test('R2-4 (medium): .fields() selects fields and must not be stripped as a modifier', () => {
  assert.strictEqual(
    denial('curl -q -sG --data-urlencode "fields=phone_numbers.fields(messages)" -d "access_token=$T" ' + G(WABA)).ruleId,
    'unapproved-field'
  );
  // Read-constraining modifiers are still stripped, so legitimate reads pass.
  assert.ok(allowed('curl -q -sG --data-urlencode "fields=phone_numbers.limit(50){id}" -d "access_token=$T" ' + G(WABA)));
  assert.ok(allowed('curl -q -sG --data-urlencode "fields=phone_numbers.offset(10){id}" -d "access_token=$T" ' + G(WABA)));
});

test('R2-5 (low): naming the host in a local script is not a Graph request', () => {
  // The round-1 fix for host indirection was too eager: any command containing
  // `python`/`node` plus the host name was denied, including pure string work.
  assert.ok(allowed('python -c "print(\'graph.facebook.com\')"'));
  assert.ok(allowed('node -e "console.log(\'graph.facebook.com\')"'));
  assert.ok(allowed('echo graph.facebook.com >> notes.txt'));
  // But a real request with a shell-assembled host is still refused.
  assert.strictEqual(
    denial('HOST=graph.facebook.com; curl "https://$HOST/v23.0/oauth/access_token?grant_type=fb_exchange_token"').ruleId,
    'unclassifiable-graph-request'
  );
  // A variable in the PATH is fine — that is how the real probe loops ids.
  assert.ok(allowed('curl -q -sG -d "fields=webhook_configuration" -d "access_token=$T" ' + G('$PNID')));
});

// ===========================================================================
// 4d. ADVERSARIAL REVIEW ROUND 3
//
// Round 3 confirmed rounds 1 and 2 hold, and found five more gaps — all of the
// same class: curl option grammar the classifier did not know about. The lesson
// is recorded here rather than in a comment elsewhere: this policy is only as
// good as its model of the client, so ANY new flag that can carry a body or
// build a query must be added to the sets above, with a case here.
// ===========================================================================

test('R3-1 (high): --json carries a body and is never a read', () => {
  deniedAs('curl -q --json "{\\"a\\":1}" "' + G('123/subscribed_apps') + '"', ...BLOCKED_WRITE);
  // Not on the safe-flag list, so the form check refuses it and the method is
  // reported conservatively rather than guessed. -G cannot rescue it either.
  assert.strictEqual(M.isSanctionedCurlForm('curl -q --json "{}" ' + G('123')), false);
  assert.strictEqual(M.classifyHttpMethod('curl -q -G --json "{}" ' + G('123')), 'UNKNOWN');
});

test('R3-2 (high): a runtime-selected method in any client is refused', () => {
  const indirect = [
    'METHOD=POST node -e "fetch(\'' + G('123/subscribed_apps') + '\',{method:process.env.METHOD})"',
    'METHOD=POST python -c "import os,requests; requests.request(method=os.environ[\'METHOD\'], url=\'' + G('123/subscribed_apps') + '\')"',
    'node -e "fetch(u,{method: verb})" ' + G('123/subscribed_apps'),
  ];
  for (const cmd of indirect) {
    assert.strictEqual(denial(cmd).ruleId, 'unclassifiable-graph-request', 'not blocked: ' + cmd);
  }
  // A literal method is still classified, in either case.
  assert.strictEqual(M.classifyHttpMethod('fetch(u, { method: "post" })'), 'POST');
});

test('R3-3 (high): -G does not convert uploads or form bodies', () => {
  // -G folds --data* into the query string. It does NOT convert -T (a file
  // upload, PUT) or -F (a multipart body, POST). Treating it as universal let
  // an upload classify as a metadata read.
  for (const cmd of [
    'curl -q -sG -T payload.json "' + G('123/subscribed_apps') + '"',
    'curl -q -sG --upload-file payload.json "' + G('123/subscribed_apps') + '"',
    'curl -q -sG -F "a=b" "' + G('123/subscribed_apps') + '"',
    'curl -q -sG --form "a=b" "' + G('123/subscribed_apps') + '"',
  ]) {
    deniedAs(cmd, ...BLOCKED_WRITE);
  }
  // But -G still converts real data flags — the original correction is intact.
  assert.strictEqual(M.classifyHttpMethod('curl -q -sG --data-urlencode "fields=id" ' + G('123')), 'GET');
  assert.ok(M.isSanctionedCurlForm('curl -q -sG --data-urlencode "fields=id" ' + G('123')));
});

test('R3-4 (medium): --url-query parameters are validated like any other', () => {
  assert.strictEqual(
    denial('curl -q -sG --url-query "fields=messages" -d "access_token=$T" "' + G(PNID_3742) + '"').ruleId,
    'unapproved-field'
  );
  assert.strictEqual(
    denial('curl -q -sG --url-query "fields=access_token" -d "access_token=$T" "' + G(PNID_3742) + '"').ruleId,
    'credential-field'
  );
  // A legitimate --url-query read still passes.
  assert.ok(allowed('curl -q -sG --url-query "fields=webhook_configuration" -d "access_token=$T" "' + G(PNID_6737) + '"'));
  assert.strictEqual(M.paramValue(M.collectDataParams('curl -q --url-query "fields=id" u'), 'fields'), 'id');
});

test('R3-5 (medium): an OAuth code is redacted, not just validated', () => {
  // `code` was in CREDENTIAL_PARAMS but missing from the redaction key list, so
  // it could still reach the on-disk session ledger.
  assert.strictEqual(M.redactSensitive('code=REALOAUTHCODE123'), 'code=[REDACTED]');
  assert.strictEqual(M.redactSensitive('code_verifier=abc123xyz'), 'code_verifier=[REDACTED]');
  assert.strictEqual(M.redactSensitive('code=$OAUTH_CODE'), 'code=$OAUTH_CODE');
  assert.ok(!M.redactSensitive('?code=REALOAUTHCODE123&fields=id').includes('REALOAUTHCODE123'));
});

// ===========================================================================
// 4e. ADVERSARIAL REVIEW ROUND 4 — the structural close
//
// Rounds 1, 3 and 4 each found the same shape of bypass: a client library
// expressing "write" in a way the classifier did not model. Enumerating client
// APIs is an unwinnable race, so round 4 is closed structurally: a Graph URL
// inside inline interpreter code is refused, because the method is decided by
// arbitrary code rather than by the command line.
// ===========================================================================

test('R4 (high): a Graph URL inside inline interpreter code is refused', () => {
  const inline = [
    // PHP curl_setopt(CURLOPT_POST) — the reported bypass.
    'php -r \'$c=curl_init("' + G('123/subscribed_apps') + '"); curl_setopt($c,CURLOPT_POST,1); curl_exec($c);\'',
    // Same class, different clients.
    'perl -e \'use LWP::UserAgent; $ua->post("' + G('123/subscribed_apps') + '");\'',
    'ruby -e \'Net::HTTP::Post.new(URI("' + G('123/subscribed_apps') + '"))\'',
    'deno eval "await fetch(\'' + G('123/subscribed_apps') + '\')"',
  ];
  for (const cmd of inline) {
    assert.strictEqual(denial(cmd).decision, 'deny', 'not blocked: ' + cmd);
  }
});

test('R4: an obvious inline write still reports the clearer mutation reason', () => {
  assert.strictEqual(
    denial('python -c "import requests; requests.post(\'' + G('123/subscribed_apps') + '\')"').ruleId,
    'meta-asset-mutation'
  );
});

test('R4: the structural rule costs no legitimate path', () => {
  // The sanctioned read path is curl with a literal URL.
  assert.ok(allowed('curl -q -sG --data-urlencode "access_token=$T" ' + G(WABA + '/subscribed_apps')));
  // A checked-in script is unaffected: its URL lives in the file, not in the
  // command line the guard inspects, so the policy never fires.
  assert.ok(allowed('node scripts/fetch-waba-subscriptions.js'));
  assert.ok(allowed('python scripts/probe_webhooks.py --waba 272252189309178'));
  // And merely naming the host in interpreter code is still not a request.
  assert.ok(allowed('python -c "print(\'graph.facebook.com\')"'));
});

// ===========================================================================
// 4f. ADVERSARIAL REVIEW ROUND 5
// ===========================================================================

test('R5-1 (high): a value attached to a clustered short option is still data', () => {
  // curl lets a value attach to the LAST letter of a cluster, and that letter
  // can sit anywhere: `-sdk=v` is -s plus -d "k=v". Matching only `-[dFT]...`
  // missed every cluster with a leading flag.
  for (const cmd of [
    'curl -q -sdsubscribed_fields=messages "' + G('123/subscribed_apps') + '"',
    'curl -q -sFsubscribed_fields=messages "' + G('123/subscribed_apps') + '"',
    'curl -q -sTpayload.json "' + G('123/subscribed_apps') + '"',
  ]) {
    deniedAs(cmd, ...BLOCKED_WRITE);
  }
  // The cluster parser must also SURFACE the value, or the field allowlist
  // never runs on it — the round-6 finding. One parser feeds both.
  assert.strictEqual(M.paramValue(M.collectDataParams('curl -q -sGd"fields=id" u'), 'fields'), 'id');
  // The sanctioned clustered read is unaffected.
  assert.ok(allowed('curl -q -sG --data-urlencode "fields=id" -d "access_token=$T" ' + G(WABA)));
  assert.strictEqual(M.classifyHttpMethod('curl -q -sG -d "fields=id" ' + G(WABA)), 'GET');
});

test('R5-2 (high): a variable that expands into URL structure is refused', () => {
  // `NODE=123/accounts` presents as a bare node read but expands to a
  // token-minting edge. Where the assignment is visible, catch it exactly.
  assert.strictEqual(
    denial('NODE=123/accounts; curl -sG -d "access_token=$T" "' + G('$NODE') + '"').ruleId,
    'unclassifiable-graph-request'
  );
  assert.strictEqual(
    denial('NODE=123?fields=access_token; curl -sG -d "access_token=$T" "' + G('$NODE') + '"').ruleId,
    'unclassifiable-graph-request'
  );
  // A plain id in a variable is still fine — that is G6's real form.
  assert.ok(allowed('curl -q -sG -d "fields=webhook_configuration" -d "access_token=$T" ' + G('$PNID')));
});

test('R5-3 (high): interpreter detection survives a path or a version suffix', () => {
  for (const bin of ['/usr/bin/php', 'php8.2', '/usr/bin/perl', '/usr/local/bin/ruby', 'ruby3.2', 'python3.11']) {
    const cmd = bin + ' -e \'fetch("' + G('123/subscribed_apps') + '")\'';
    assert.strictEqual(denial(cmd).decision, 'deny', 'not blocked: ' + cmd);
  }
  // A path-qualified curl is still the sanctioned read path.
  assert.ok(allowed('/usr/bin/curl -q -sG --data-urlencode "access_token=$T" ' + G(WABA + '/subscribed_apps')));
});

// ===========================================================================
// 4g. ADVERSARIAL REVIEW ROUND 6 — the model inversion
//
// Round 6 found a CRITICAL PowerShell write bypass and a clustered-flag hole,
// and observed that the finding rate would not converge "unless the policy
// shifts from client-shape enumeration toward stricter approved-command forms".
// That was correct, and the policy was inverted accordingly: a Graph request
// must POSITIVELY MATCH `[VAR=v ...] curl <recognised flags> <literal URL>`.
//
// These tests pin the inversion itself, not just its symptoms. A new HTTP
// client or a new curl flag can no longer become a silent bypass — it becomes a
// refusal until someone adds it deliberately, with a test.
// ===========================================================================

test('R6-1 (critical): a non-curl client cannot reach Graph at all', () => {
  for (const cmd of [
    'Invoke-WebRequest -Method Post "' + G('123/subscribed_apps') + '" -Body "subscribed_fields=messages"',
    'Invoke-RestMethod -Method Get "' + G('123/subscribed_apps') + '"',
    'wget -q -O - ' + G(WABA + '/subscribed_apps'),
    'xh GET ' + G(WABA + '/subscribed_apps'),
    'aria2c ' + G(WABA + '/subscribed_apps'),
  ]) {
    deniedAs(cmd, ...BLOCKED_WRITE);
  }
});

test('R6-2 (high): one parser feeds both method and parameter collection', () => {
  // The divergence that let `-sGd'fields=accounts{access_token}'` through: the
  // method classifier understood the cluster, the parameter collector did not,
  // so the field allowlist never ran.
  assert.strictEqual(
    denial('curl -q -sGd\'fields=accounts{access_token}\' "' + G('me') + '?access_token=$T"').ruleId,
    'credential-field'
  );
  assert.strictEqual(denial('curl -q -sGd\'fields=messages\' "' + G(PNID_3742) + '"').ruleId, 'unapproved-field');
  const p = M.collectDataParams('curl -q -sGd\'fields=id\' -d "access_token=$T" u');
  assert.strictEqual(M.paramValue(p, 'fields'), 'id');
  assert.strictEqual(M.paramValue(p, 'access_token'), '$T');
});

test('R6: the sanctioned form is positively defined, not blocklisted', () => {
  // In the form.
  assert.ok(M.isSanctionedCurlForm('curl -q -sG --data-urlencode "fields=id" ' + G(WABA)));
  assert.ok(M.isSanctionedCurlForm('TOKEN=$X curl -s -H "A: b" -o out.json ' + G(WABA)));
  assert.ok(M.isSanctionedCurlForm('/usr/bin/curl -sG -d "fields=id" ' + G(WABA)));
  // Out of the form.
  for (const cmd of [
    'wget ' + G(WABA),
    'curl -q -K cfg ' + G(WABA),
    'curl -q --json "{}" ' + G(WABA),
    'curl -q -T f ' + G(WABA),
    'curl -q --next ' + G(WABA),
    'curl -q --proxy http://x ' + G(WABA),
  ]) {
    assert.strictEqual(M.isSanctionedCurlForm(cmd), false, 'should be out of form: ' + cmd);
  }
});

test('R6: an unmodelled flag fails CLOSED and names itself', () => {
  // The property that makes this converge: an option nobody has classified is a
  // refusal, and the refusal says which option so it can be added deliberately.
  const v = denial('curl -q -sG --some-future-flag=1 -d "access_token=$T" ' + G(WABA + '/subscribed_apps'));
  assert.strictEqual(v.ruleId, 'unclassifiable-graph-request');
  assert.ok(v.reason.includes('--some-future-flag'), 'refusal should name the offending option');
});

// ===========================================================================
// 4h. ADVERSARIAL REVIEW ROUND 7
//
// Round 7 confirmed the inversion closed the client-enumeration class outright
// ("no longer an open-ended client-enumeration problem"). What remained were two
// gaps INSIDE the sanctioned curl grammar — a bounded surface, which is the
// whole point of having inverted the model.
// ===========================================================================

test('R7-1 (high): a safe flag with an unreadable value is not safe', () => {
  // `-d @params.txt` supplies parameters from a file the guard cannot read, so
  // the field allowlist and credential checks would run against nothing.
  for (const cmd of [
    'curl -q -sG --data-urlencode "access_token=$T" -d @params.txt ' + G('me'),
    'curl -q -sG --data @payload.txt ' + G(WABA),
    'curl -q -sG --data-urlencode fields@payload.txt ' + G(WABA),
    'curl -q -sG -d@params.txt ' + G(WABA),
  ]) {
    assert.strictEqual(denial(cmd).ruleId, 'unclassifiable-graph-request', 'not blocked: ' + cmd);
  }
  // An inline value containing @ (an email, say) is not a file reference.
  assert.ok(allowed('curl -q -sG --data-urlencode "fields=id" -d "access_token=$T" ' + G(WABA)));
});

test('R7-2 (medium): -X GET does not launder a request body', () => {
  // curl -X GET -d body still SENDS the body; only the method token changes.
  assert.strictEqual(
    denial('curl -q -X GET -d "subscribed_fields=messages" -d "access_token=$T" ' + G(PNID_3742 + '/subscribed_apps')).ruleId,
    'unclassifiable-graph-request'
  );
  assert.strictEqual(M.classifyHttpMethod('curl -q -X GET -d "a=1" ' + G(WABA)), 'UNKNOWN');
  // With -G the data really is folded into the query, so it is a genuine read.
  assert.strictEqual(M.classifyHttpMethod('curl -q -X GET -G -d "fields=id" ' + G(WABA)), 'GET');
  assert.ok(allowed('curl -q -X GET -G --data-urlencode "fields=id" -d "access_token=$T" ' + G(WABA)));
});

test('R7-3: multi-object addressing cannot escape the object allowlist', () => {
  // ?ids= reads objects the URL never names.
  assert.strictEqual(denial('curl -q -sG -d "ids=123,456" -d "access_token=$T" ' + G('')).ruleId, 'unapproved-object');
  assert.strictEqual(
    denial('curl -q -s "' + G(WABA + '/phone_numbers') + '?ids=1,2&access_token=$T"').ruleId,
    'unapproved-object'
  );
});

// ===========================================================================
// 5. CREDENTIAL SOURCE VALIDATION
// ===========================================================================

test('credentials: command substitution is not an approved source', () => {
  assert.ok(!M.APPROVED_CREDENTIAL_REF_RE.test('$(cat .env)'));
  assert.ok(!M.APPROVED_CREDENTIAL_REF_RE.test('`cat token.txt`'));
});

test('credentials: plain env references are approved', () => {
  for (const ref of ['$TOKEN', '${TOKEN}', '$env:TOKEN', '%TOKEN%']) {
    assert.ok(M.APPROVED_CREDENTIAL_REF_RE.test(ref), ref);
  }
});

test('credentials: an empty value is not treated as a literal', () => {
  const r = M.validateCredentials('curl -q ' + G('debug_token'), [{ key: 'access_token', value: '' }]);
  assert.strictEqual(r.ok, true);
});

// ===========================================================================
// 6. OUTPUT REDACTION
// ===========================================================================

test('redaction: literal tokens are replaced wholesale, not truncated', () => {
  const out = M.redactSensitive('token was ' + FAKE_USER_TOKEN + ' ok');
  assert.ok(out.includes('[REDACTED:meta-token]'));
  assert.ok(!out.includes(FAKE_USER_TOKEN));
  // No prefix or suffix of the credential may survive.
  assert.ok(!out.includes(FAKE_USER_TOKEN.slice(0, 12)));
  assert.ok(!out.includes(FAKE_USER_TOKEN.slice(-12)));
});

test('redaction: app access tokens are replaced', () => {
  const out = M.redactSensitive('using ' + FAKE_APP_TOKEN);
  assert.ok(out.includes('[REDACTED:app-access-token]'));
  assert.ok(!out.includes(FAKE_APP_TOKEN));
});

test('redaction: credential parameters are scrubbed by key', () => {
  const out = M.redactSensitive('?input_token=abc123def456&fields=id');
  assert.ok(out.includes('input_token=[REDACTED]'));
  assert.ok(out.includes('fields=id'), 'non-credential params must survive');
});

test('redaction: approved env references are left readable', () => {
  assert.strictEqual(M.redactSensitive('access_token=$META_TOKEN'), 'access_token=$META_TOKEN');
});

test('redaction: literal bearer headers are scrubbed', () => {
  const out = M.redactSensitive('Authorization: Bearer ' + FAKE_USER_TOKEN);
  assert.ok(!out.includes(FAKE_USER_TOKEN));
});

test('redaction: is safe on null and undefined', () => {
  assert.strictEqual(M.redactSensitive(null), '');
  assert.strictEqual(M.redactSensitive(undefined), '');
});

test('fingerprint: stable, non-reversible, and not a token substring', () => {
  const fp = M.tokenFingerprint(FAKE_USER_TOKEN);
  assert.strictEqual(fp, M.tokenFingerprint(FAKE_USER_TOKEN));
  assert.strictEqual(fp.length, 12);
  assert.notStrictEqual(fp, M.tokenFingerprint(FAKE_USER_TOKEN + 'x'));
  assert.ok(!FAKE_USER_TOKEN.includes(fp));
});

// ===========================================================================
// 7. DENY MESSAGES NEVER LEAK
// ===========================================================================

test('deny reasons are redacted before they reach the transcript', () => {
  const v = evalCmd('curl -q -s "' + G(WABA + '/subscribed_apps') + '?access_token=' + FAKE_USER_TOKEN + '"');
  assert.strictEqual(v.decision, 'deny');
  assert.ok(!v.reason.includes(FAKE_USER_TOKEN));
  assert.ok(!v.remedy.includes(FAKE_USER_TOKEN));
});
