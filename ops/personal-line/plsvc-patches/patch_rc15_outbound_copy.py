#!/usr/bin/env python3
# rc15 (PM 2026-10-11, launch scope = free-trial OUTBOUND calling): the signup Flow's WELCOME offer must not imply receiving calls.
# Incoming calls to new lines were measured failing on 2026-10-11 (busy -> voicemail). One string, in the isolated copy src-rc15.
import sys
p = sys.argv[1]
t = open(p, encoding='utf-8').read()
old = "You make and receive calls in the free Cloud Softphone app."
new = "You make calls from the free Cloud Softphone app. Incoming calls to your number are not available yet."
assert t.count(old) == 1, f'expected 1x, found {t.count(old)}'
t = t.replace(old, new)
open(p, 'w', encoding='utf-8').write(t)
print('patched', p)
