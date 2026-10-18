#!/usr/bin/env python3
# Build zz-acct2 service specs from existing STAGING specs WITHOUT printing any env/secret value.
# usage: zz-acct2-mkspec.py plsvc <inspect.json> <out.json> x <new_secret_id>
#        zz-acct2-mkspec.py app   <inspect.json> <out.json> <sink_ip>
import json, os, sys
kind, src, out = sys.argv[1], sys.argv[2], sys.argv[3]
spec = json.load(open(src))[0]['Spec']
cs = spec['TaskTemplate']['ContainerSpec']
spec['Labels'] = {'lane': 'lane-a', 'purpose': 'zzacct2-slice-2a-ui-acceptance-staging'}
cs.pop('Labels', None)
spec['EndpointSpec'] = {'Mode': 'vip'}
spec['Mode'] = {'Replicated': {'Replicas': 1}}
spec['TaskTemplate'].pop('ForceUpdate', None)


def setenv(env, over):
    keep = [e for e in env if e.split('=', 1)[0] not in over]
    return keep + [f'{k}={v}' for k, v in over.items()]


if kind == 'plsvc':
    assert spec['Name'] == 'plstg_web_acctsum'
    spec['Name'] = 'plstg_zzacct2_web'
    sid = sys.argv[5]
    cs['Env'] = setenv(cs.get('Env', []), {'MAGNUS_URL': 'http://zzacct2-mock:9000/mbilling', 'AMI_LISTENER_URL': 'http://zzacct2-mock:9000'})
    sec = [s for s in cs['Secrets'] if s['SecretName'] == 'plstg_sf_summary_key_v1']
    assert len(sec) == 1
    sec[0]['SecretName'] = 'plstg_zzacct2_sf_key_v1'
    sec[0]['SecretID'] = sid
    assert any(s['SecretName'] == 'plstg_app_env_v3' for s in cs['Secrets'])
    alias = 'zzacct2-plsvc'
elif kind == 'app':
    assert spec['Name'] == 'uplinkstg_app_acctslice'
    spec['Name'] = 'uplinkstg_zzacct2_app'
    sink_ip = sys.argv[4]
    cs['Image'] = 'lane-a-uplink-app:acctslice-7feab80b'
    cs['Env'] = setenv(cs.get('Env', []), {'MODEL_BASE_URL': 'http://127.0.0.1:9/model-disabled-zzacct2', 'NODE_EXTRA_CA_CERTS': '/etc/zzacct2/ca.crt'})
    # Derive from the EXISTING spec's launch line: replace only its "unset <mail vars>" clause (which blanks real mail transport)
    # with dummy keys + the sink CA + a disabled model. Everything else in the launch line is untouched.
    a = list(cs['Args'])
    body = a[-1]
    old = 'unset SMTP2GO_API_KEY PORTAL_EMAIL_FROM RESEND_API_KEY;'
    assert body.count(old) == 1
    body = body.replace(old, 'export SMTP2GO_API_KEY=zzacct2-dummy-not-a-key PORTAL_EMAIL_FROM=zzacct2-noreply@example.test AUTH_RESEND_KEY=zzacct2-dummy RESEND_API_KEY=zzacct2-dummy MODEL_BASE_URL=http://127.0.0.1:9/model-disabled-zzacct2 NODE_EXTRA_CA_CERTS=/etc/zzacct2/ca.crt;')
    cs['Args'] = a[:-1] + [body]
    cs.pop('Command', None)
    cs['Mounts'] = [{'Type': 'bind', 'Source': '/home/epicadmin/zz-acct2-20261011/tls', 'Target': '/etc/zzacct2', 'ReadOnly': True}]
    cs['Secrets'] = [s for s in cs.get('Secrets', []) if s['SecretName'] != 'uplinkstg_model_key_v1']
    cs['Hosts'] = [f'{sink_ip} api.smtp2go.com', f'{sink_ip} api.resend.com']
    alias = 'zzacct2-app'
else:
    raise SystemExit('bad kind')
spec['TaskTemplate']['Networks'] = [{'Target': n['Target'], 'Aliases': [alias]} for n in spec['TaskTemplate']['Networks']]
assert spec['Name'].startswith(('plstg_zzacct2_', 'uplinkstg_zzacct2_'))
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump(spec, f)
print('name:', spec['Name'], 'image:', cs['Image'])
print('env names:', sorted(e.split('=', 1)[0] for e in cs['Env']))
print('secrets:', [s['SecretName'] for s in cs.get('Secrets', [])])
print('mounts:', cs.get('Mounts'), 'hosts:', cs.get('Hosts'), 'networks:', spec['TaskTemplate']['Networks'])
