// rc16g STAGING one-shot: do the staging web's PL assertion key and the shared adapter's PL key agree? Prints only equal/not-equal,
// key NAMES, lengths and kids - never a key value or any digest of one.
import { readFileSync } from 'node:fs'
const env = {}
for (const raw of readFileSync('/run/secrets/plenv', 'utf8').split(/\r?\n/)) {
  const l = raw.trim(); if (!l || l.startsWith('#') || !l.includes('=')) continue
  const i = l.indexOf('='); env[l.slice(0, i).replace(/^export\s+/, '').trim()] = l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')
}
const webKey = env.PL_ASSERTION_HMAC_KEY, adKey = readFileSync('/run/secrets/plkey', 'utf8').replace(/\r?\n$/, '')
console.log('web env names present:', ['PL_ASSERTION_HMAC_KEY', 'PL_ASSERTION_KID', 'PL_ASSERTION_KEYS', 'PL_ADAPTER_URL', 'DATABASE_URL'].map((k) => `${k}=${env[k] ? 'set' : 'unset'}`).join(' '))
console.log('web kid:', env.PL_ASSERTION_KID ?? '(none)', '| web key length:', webKey?.length, '| adapter key length:', adKey.length)
console.log('web key == adapter key:', webKey === adKey)
