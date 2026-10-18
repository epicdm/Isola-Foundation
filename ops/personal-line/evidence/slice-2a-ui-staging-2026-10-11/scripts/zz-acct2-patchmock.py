#!/usr/bin/env python3
# Derive zz-acct2-mock.mjs from the shared mock-ext.mjs (read-only source) with: explicit-id saves, and an AMI-listener /peer stand-in.
import sys
src, out = sys.argv[1], sys.argv[2]
s = open(src).read()
a = "row = { id: nextId(mod) }"
assert s.count(a) == 1
s = s.replace(a, "row = { id: id || nextId(mod) }")
h = "if (p === '/__health') return send(res, 200, { ok: true })"
assert s.count(h) == 1
add = h + """
    if (p === '/__peer') { peers[url.searchParams.get('name')] = url.searchParams.get('status'); return send(res, 200, { ok: true, peers }) }
    const pm = p.match(/^\/peer\/([^/]+)$/)
    if (pm) {
      const nm = decodeURIComponent(pm[1]); calls.push({ t: Date.now(), kind: 'peer', name: nm })
      const st = peers[nm]
      if (!st) return send(res, 200, { status: 'absent', listenerConnected: true, at: new Date().toISOString(), address: null, source: 'ami' })
      return send(res, 200, { status: st, listenerConnected: true, at: new Date().toISOString(), address: '203.0.113.7:5060', source: 'ami' })
    }"""
s = s.replace(h, add)
c = "const calls = []"
assert s.count(c) == 1
s = s.replace(c, "const calls = []\nconst peers = {}")
open(out, 'w').write(s)
print('ok', len(s))
