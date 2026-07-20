import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isProdDatabaseUrl, redactedHost } from './guard-not-prod-db'

test('isProdDatabaseUrl flags the Neon prod host', () => {
  assert.equal(
    isProdDatabaseUrl('postgresql://user:pass@ep-fancy-cake-aiczmqqq.c-4.us-east-1.aws.neon.tech/neondb'),
    true,
  )
})

test('isProdDatabaseUrl allows a dev/local host', () => {
  assert.equal(isProdDatabaseUrl('postgresql://isola:devpassword@localhost:5436/isola_dev_v2'), false)
})

test('isProdDatabaseUrl allows an unset DATABASE_URL (downstream command reports its own error)', () => {
  assert.equal(isProdDatabaseUrl(undefined), false)
})

test('isProdDatabaseUrl does not throw on an unparseable URL', () => {
  assert.equal(isProdDatabaseUrl('not-a-url'), false)
})

test('redactedHost returns only the hostname, never credentials', () => {
  const host = redactedHost('postgresql://user:supersecret@ep-fancy-cake-aiczmqqq.c-4.us-east-1.aws.neon.tech/neondb')
  assert.equal(host, 'ep-fancy-cake-aiczmqqq.c-4.us-east-1.aws.neon.tech')
  assert.ok(!host.includes('supersecret'))
})

test('redactedHost reports unset and unparseable values without throwing', () => {
  assert.equal(redactedHost(undefined), '(unset)')
  assert.equal(redactedHost('not-a-url'), '(unparseable)')
})
