#!/usr/bin/env python3
# Build zz-emit service specs from existing STAGING specs WITHOUT printing any env/secret value.
# usage: zz-emit-mkspec.py plsvc <inspect.json> <out.json> <events_secret_id> <org_id> <image> <wa_ids_csv>
#        zz-emit-mkspec.py app   <inspect.json> <out.json>
import json, os, sys

kind, src, out = sys.argv[1], sys.argv[2], sys.argv[3]
D = '/home/epicadmin/zz-emit-20261011'
spec = json.load(open(src))[0]['Spec']
cs = spec['TaskTemplate']['ContainerSpec']
spec['Labels'] = {'lane': 'lane-a', 'purpose': 'zzemit-lifecycle-outbox-staging'}
cs.pop('Labels', None)
spec['EndpointSpec'] = {'Mode': 'vip'}
spec['Mode'] = {'Replicated': {'Replicas': 1}}
spec['TaskTemplate'].pop('ForceUpdate', None)


def setenv(env, over, drop=()):
    keep = [e for e in env if e.split('=', 1)[0] not in over and e.split('=', 1)[0] not in drop]
    return keep + [f'{k}={v}' for k, v in over.items()]


def rd(name):
    return open(f'{D}/keys/{name}').read().strip()


if kind == 'plsvc':
    assert spec['Name'] == 'plstg_web_acctsum'
    spec['Name'] = 'plstg_zzemit_web'
    sid, org, image, was = sys.argv[4], sys.argv[5], sys.argv[6], sys.argv[7]
    cs['Image'] = image
    over = {
        # isolated stand-ins: Magnus REST + AMI peer listener + Lumen seat bind all go to OUR mock
        'MAGNUS_URL': 'http://zzemit-mock:9000/mbilling',
        'AMI_LISTENER_URL': 'http://zzemit-mock:9000',
        'LUMEN_SEAT_BIND_URL': 'http://zzemit-mock:9000/seat',
        # no WhatsApp/alert reach: blank phone + dead tokens (and graph.facebook.com is sunk via Hosts below)
        'ERIC_PHONE': '', 'META_WA_TOKEN': 'zzemit-disabled', 'WHATSAPP_TOKEN': 'zzemit-disabled',
        # synthetic numbers are test identities: they never reach Odoo
        'TEST_IDENTITIES': was,
        # the outbox under test
        'PL_SF_OUTBOX_ENABLED': 'true',
        'PL_SF_EVENTS_URL': f'http://zzemit-app:3000/api/webhooks/personal-line/{org}',
        'PL_SF_EVENTS_KID': 'ev1',
        'PL_SF_EVENTS_KEY_FILE': '/run/secrets/pl_sf_events_key',
        # the real provisioning route needs its own (staging-only, throwaway) assertion key + the cron credential
        'PL_CONCIERGE_SVC_PROVISION_ENABLED': 'true',
        'PL_ASSERTION_KID': 'zz1', 'PL_ASSERTION_HMAC_KEY': rd('assertion'),
        'PL_CONCIERGE_PNID_ALLOWLIST': '100000000000009',
        'CRON_SECRET': rd('cron'),
        'PL_SF_FIRST_CALL_SWEEP': 'true',
    }
    cs['Env'] = setenv(cs.get('Env', []), over, drop=('PL_SF_SUMMARY_KEY_FILE', 'PL_SF_SUMMARY_KID'))
    sec = [s for s in cs['Secrets'] if s['SecretName'] == 'plstg_sf_summary_key_v1']
    assert len(sec) == 1
    sec[0]['SecretName'] = 'plstg_zzemit_events_key_v1'
    sec[0]['SecretID'] = sid
    sec[0]['File']['Name'] = 'pl_sf_events_key'
    assert any(s['SecretName'] == 'plstg_app_env_v3' for s in cs['Secrets'])
    cs['Hosts'] = ['127.0.0.1 graph.facebook.com', '127.0.0.1 api.smtp2go.com', '127.0.0.1 api.resend.com']
    alias = 'zzemit-plsvc'
elif kind == 'app':
    assert spec['Name'] == 'uplinkstg_app_acctslice'
    spec['Name'] = 'uplinkstg_zzemit_app'
    cs['Image'] = 'lane-a-uplink-app:acctslice-7feab80b'   # == epicdm/isola-seldonframe#12 head 7feab80b
    a = list(cs['Args'])
    body = a[-1]
    old = 'unset SMTP2GO_API_KEY PORTAL_EMAIL_FROM RESEND_API_KEY;'
    assert body.count(old) == 1
    # the existing launch line blanks the real mail transport; additionally disable the model endpoint (no agent turn runs here)
    body = body.replace(old, old + ' export MODEL_BASE_URL=http://127.0.0.1:9/model-disabled-zzemit;')
    cs['Args'] = a[:-1] + [body]
    cs['Env'] = setenv(cs.get('Env', []), {'MODEL_BASE_URL': 'http://127.0.0.1:9/model-disabled-zzemit'})
    cs['Secrets'] = [s for s in cs.get('Secrets', []) if s['SecretName'] != 'uplinkstg_model_key_v1']
    alias = 'zzemit-app'
else:
    raise SystemExit('bad kind')
spec['TaskTemplate']['Networks'] = [{'Target': n['Target'], 'Aliases': [alias]} for n in spec['TaskTemplate']['Networks']]
assert spec['Name'].startswith(('plstg_zzemit_', 'uplinkstg_zzemit_'))
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump(spec, f)
print('name:', spec['Name'], 'image:', cs['Image'])
print('env names:', sorted(e.split('=', 1)[0] for e in cs['Env']))
print('secrets:', [s['SecretName'] for s in cs.get('Secrets', [])])
print('hosts:', cs.get('Hosts'), 'networks:', spec['TaskTemplate']['Networks'])
