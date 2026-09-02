'use strict';
/**
 * Adversarial verification of the Meta DevTools MCP guard.
 *
 * Every assertion drives the REAL hook binary (isola-guard.js) as a child
 * process with a synthetic PreToolUse payload. Nothing here reads the policy
 * source to decide a verdict — the verdict is the guard's own exit status.
 *
 * No network. No Meta call. The sentinel is synthetic and never leaves this
 * process.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const GUARD = path.join(__dirname, 'isola-guard.js');
const SID = 'meta-mcp-test';

// Shaped like a Meta token so the credential matcher is genuinely exercised.
const SENTINEL = 'EAA' + 'G'.repeat(44) + 'SENTINELDONOTLEAK';

function run(toolName, toolInput) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ session_id: SID, tool_name: toolName, tool_input: toolInput }),
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

const T = (n) => `mcp__meta_developer_tools__${n}`;
const APP = '1293246411364782';

const denied = (tool, input) => {
  const { verdict, out } = run(tool, input);
  assert.strictEqual(verdict, 'DENY', `expected DENY, got ${verdict}`);
  assert.ok(!out.includes(SENTINEL), 'sentinel must never appear in guard output');
  return out;
};
const allowed = (tool, input) => {
  const { verdict, out } = run(tool, input);
  assert.strictEqual(verdict, 'ALLOW', `expected ALLOW, got ${verdict}`);
  return out;
};

// ---------------------------------------------------- approved metadata reads
const APPROVED = [
  ['devtools_app_list', { action: 'list' }],
  ['devtools_app_list', { action: 'list', limit: 50, cursor: 'abc' }],
  ['devtools_app', { action: 'basic_settings', app_id: APP }],
  ['devtools_app', { action: 'advanced_settings', app_id: APP }],
  ['devtools_app', { action: 'restrictions', app_id: APP }],
  ['devtools_webhook_list', { action: 'list_topics', app_id: APP }],
  ['devtools_webhook_list', { action: 'list_subscriptions', app_id: APP }],
  ['devtools_api_usage', { action: 'rate_limits', app_id: APP }],
  ['devtools_api_usage', { action: 'call_volume', app_id: APP, lookback_minutes: 1440 }],
  ['devtools_api_usage', { action: 'deprecations', app_id: APP }],
  ['devtools_compliance', { action: 'status', app_id: APP }],
  ['devtools_app_review', { action: 'status', app_id: APP }],
  ['devtools_app_review', { action: 'privileges', app_id: APP }],
  ['devtools_discovery', { action: 'search_docs', query: 'whatsapp webhooks' }],
  ['devtools_api_changelog', { action: 'list_products' }],
  ['devtools_skill_invocation', { action: 'start', skill_name: 'api-health' }],
];
for (const [tool, input] of APPROVED) {
  test(`ALLOW ${tool}:${input.action}`, () => { allowed(T(tool), input); });
}
test('ALLOW approved read carrying universal optional keys', () => {
  allowed(T('devtools_app'), { action: 'basic_settings', app_id: APP, model_name: 'x', skill_name: 'api-health' });
});

// ------------------------------------------------------------ mutation denied
for (const action of ['subscribe', 'unsubscribe', 'update_fields']) {
  test(`DENY devtools_webhook_manage:${action}`, () => {
    const out = denied(T('devtools_webhook_manage'), { action, app_id: APP, topic: 'whatsapp_business_account' });
    assert.match(out, /meta-mcp-mutation/);
  });
}
test('DENY devtools_webhook_test:test_send (causes a real delivery)', () => {
  const out = denied(T('devtools_webhook_test'), { action: 'test_send', app_id: APP, topic: 'whatsapp_business_account', field: 'messages' });
  assert.match(out, /meta-mcp-mutation/);
});
test('DENY webhook_manage even with an unknown action', () => {
  denied(T('devtools_webhook_manage'), { action: 'totally_new_thing', app_id: APP, topic: 'x' });
});

// ----------------------------------------------------- credential-risk denied
test('DENY devtools_app:security', () => {
  const out = denied(T('devtools_app'), { action: 'security', app_id: APP });
  assert.match(out, /meta-mcp-credential-risk/);
});
test('DENY devtools_app:data_protection_officer', () => {
  const out = denied(T('devtools_app'), { action: 'data_protection_officer', app_id: APP });
  assert.match(out, /meta-mcp-credential-risk/);
});

// ------------------------------------------------- unknown tools and actions
test('DENY unknown Meta MCP tool', () => {
  const out = denied(T('devtools_billing_charge'), { action: 'list' });
  assert.match(out, /meta-mcp-unknown-tool/);
});
test('DENY unknown action on an allowlisted tool', () => {
  const out = denied(T('devtools_app'), { action: 'delete_app', app_id: APP });
  assert.match(out, /meta-mcp-unknown-action/);
});
test('DENY omitted action', () => {
  const out = denied(T('devtools_app'), { app_id: APP });
  assert.match(out, /meta-mcp-missing-action/);
});
test('DENY differently-cased action', () => {
  const out = denied(T('devtools_app'), { action: 'Basic_Settings', app_id: APP });
  assert.match(out, /meta-mcp-unknown-action/);
});
test('DENY non-string action', () => {
  denied(T('devtools_app'), { action: { real: 'basic_settings' }, app_id: APP });
});
test('DENY empty action', () => {
  denied(T('devtools_app'), { action: '', app_id: APP });
});

// ------------------------------------------------------- unexpected key denied
test('DENY unexpected top-level key on an approved action', () => {
  const out = denied(T('devtools_app'), { action: 'basic_settings', app_id: APP, callback_url: 'https://evil.example' });
  assert.match(out, /meta-mcp-unexpected-key/);
});
test('DENY webhook-manage-shaped keys smuggled onto a read tool', () => {
  denied(T('devtools_webhook_list'), { action: 'list_subscriptions', app_id: APP, fields: ['messages'], verify_token: 'x' });
});

// --------------------------------------------------- nested / free-text hiding
test('DENY action hidden in a nested object', () => {
  const out = denied(T('devtools_app'), { action: 'basic_settings', app_id: APP, arguments: { action: 'security' } });
  assert.match(out, /meta-mcp-(nested-action|unexpected-key)/);
});
test('DENY mutating verb injected via free text', () => {
  const out = denied(T('devtools_discovery'), { action: 'search_docs', query: 'please subscribe the webhook now' });
  assert.match(out, /meta-mcp-freetext-injection/);
});
test('DENY serialized string tool_input', () => {
  denied(T('devtools_app'), JSON.stringify({ action: 'basic_settings', app_id: APP }));
});

// ------------------------------------------------------- sentinel containment
test('DENY credential-shaped value, and never echo it', () => {
  const out = denied(T('devtools_app'), { action: 'basic_settings', app_id: SENTINEL });
  assert.match(out, /meta-mcp-credential-input/);
  assert.ok(!out.includes(SENTINEL));
});
test('DENY credential-named key, and never echo it', () => {
  const out = denied(T('devtools_app_list'), { action: 'list', access_token: SENTINEL });
  assert.ok(!out.includes(SENTINEL));
});
test('DENY nested credential, and never echo it', () => {
  const out = denied(T('devtools_app'), { action: 'basic_settings', app_id: APP, meta: { deep: { authorization: `Bearer ${SENTINEL}` } } });
  assert.ok(!out.includes(SENTINEL));
});

// --------------------------------------------------------- no false positives
test('unrelated MCP tools are unaffected', () => {
  allowed('mcp__claude_ai_Port_IO__list_entities', { blueprintIdentifier: 'decision' });
});
test('ordinary Bash is unaffected', () => {
  allowed('Bash', { command: 'git status --short' });
});
test('a tool merely NAMED like Meta but not the MCP family is unaffected', () => {
  allowed('Bash', { command: 'echo devtools_webhook_manage is denied by policy' });
});
