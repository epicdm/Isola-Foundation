// rc13j: resolveSender / verifyContext with the optional originalMessageSha256 (rotated Uplink turns). Run: node test/orig_digest_test.mjs <adapter.mjs>
import crypto from 'node:crypto'
const [, , adapterPath] = process.argv
const A = await import('file:///' + adapterPath.replace(/\\/g, '/'))
let n = 0, fails = 0
const check = (name, ok, x = '') => { n++; if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (x ? ' | ' + x : '')) }
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex')
const ORIGINAL = 'What was I planning to do tomorrow?'
const SENT = '[Earlier in this same WhatsApp chat ...]\nCustomer: I am planning to call my sister\n[End of earlier messages.]\n' + ORIGINAL
const cfg = { cwBase: 'http://cw', cwAccount: 2, cwToken: 't', cwInbox: 11, timeoutMs: 1000 }
const f = async (url) => {
  const u = String(url)
  const body = u.endsWith('/messages') ? { payload: [{ id: 5933, message_type: 0, private: false, sender_type: 'Contact', source_id: 'wamid.ABCDEFGHIJKLMNOP', content: ORIGINAL, created_at: 1 }] }
    : u.includes('/contacts/') ? { payload: { id: 98, phone_number: '+17670000011', contact_inboxes: [{ source_id: '17670000011', inbox: { id: 11 } }] } }
    : { id: 521, inbox_id: 11, contact_id: 98, meta: { sender: { id: 98 } } }
  return { ok: true, status: 200, json: async () => body }
}
const base = { chatwootConversationId: '521', chatwootMessageId: '5933' }
const r1 = await A.resolveSender(cfg, { ...base, messageSha256: sha(ORIGINAL) }, f)
check('ordinary turn (no original hash): the Chatwoot message digest equals messageSha256 -> verified', r1.ok === true, r1.why)
const r2 = await A.resolveSender(cfg, { ...base, messageSha256: sha(SENT) }, f)
check('rotated turn WITHOUT originalMessageSha256 (the rc10j shape): refused message_digest_mismatch (the defect)', r2.ok === false && r2.why === 'message_digest_mismatch', r2.why)
const r3 = await A.resolveSender(cfg, { ...base, messageSha256: sha(SENT), originalMessageSha256: sha(ORIGINAL) }, f)
check('rotated turn WITH originalMessageSha256: verified (positive control for the defect)', r3.ok === true, r3.why)
const r4 = await A.resolveSender(cfg, { ...base, messageSha256: sha(SENT), originalMessageSha256: sha('some other text') }, f)
check('originalMessageSha256 that does not match the Chatwoot message: refused (it is not a bypass)', r4.ok === false && r4.why === 'message_digest_mismatch', r4.why)
const key = 'k'.repeat(40), cfg2 = { ctxKid: 'ctx1', ctxKey: key, ctxSkewS: 60, cwAccount: 2, cwInbox: 11, workspaceId: 'w', agentId: 'a', agentSlug: 's' }
const mk = (extra) => {
  const c = { kid: 'ctx1', accountId: 2, inboxId: 11, workspaceId: 'w', agentId: 'a', agentSlug: 's', chatwootConversationId: '521', chatwootMessageId: '5933', messageSha256: sha(SENT), iat: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(16).toString('base64url').slice(0, 22), ...extra }
  const e = Buffer.from(JSON.stringify(c)).toString('base64url')
  return `v1.${e}.${crypto.createHmac('sha256', key).update('v1.' + e).digest('base64url')}`
}
check('verifyContext: a well-formed originalMessageSha256 is accepted', A.verifyContext(mk({ originalMessageSha256: sha(ORIGINAL) }), cfg2).ok === true)
check('verifyContext: a malformed originalMessageSha256 is refused', A.verifyContext(mk({ originalMessageSha256: 'zz' }), cfg2).ok === false)
console.log(`${n - fails}/${n} ` + (fails ? 'FAILED' : 'ALL PASSED')); process.exit(fails ? 1 : 0)
