#!/bin/bash
# zz-emit-e2e.sh <phase> [args]  -- STAGING ONLY, synthetic accounts only. plsvc (plstg_zzemit_web) -> fork (uplinkstg_zzemit_app) end to end.
# Every DB read/write goes through zz-emit-psql.sh (service + database identity asserted before anything runs).
# phases: pre | prov <wa> <tag> | tick | regsetup <acct> | peer <sip> <status> | watch | cdr <acct> | readbacks <acct> | late | reset-delivered <eventidprefix> | probes | fail-start | fail-end | backfill-setup | backfill <acct>
D=/home/epicadmin/zz-emit-20261011
ORG=${ZZ_ORG:-f221e842-2b26-450d-b20f-13474e232cf9}
dk() { sudo -n docker "$@"; }
PLC=$(dk ps -q -f name=^plstg_zzemit_web\\. | head -1)
MOCKC=$(dk ps -q -f name=^plstg_zzemit_mock\\. | head -1)
assert_target() {
  [ -n "$PLC" ] || { echo "REFUSED: plstg_zzemit_web container not running"; exit 3; }
  local sn; sn=$(dk inspect $PLC --format '{{index .Config.Labels "com.docker.swarm.service.name"}}')
  [ "$sn" = "plstg_zzemit_web" ] || { echo "REFUSED: container service '$sn'"; exit 3; }
}
PL() { dk exec $PLC node /tmp/zz-emit-driver.mjs "$@"; }
Q() { bash $D/zz-emit-q.sh "$@"; }
mockget() { dk exec $PLC node -e "fetch('http://zzemit-mock:9000'+process.argv[1]).then(r=>r.text()).then(t=>console.log(t.slice(0,300)))" "$1"; }
mockpost() { dk exec $PLC node -e "fetch('http://zzemit-mock:9000'+process.argv[1],{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:process.argv[2]}).then(r=>r.text()).then(t=>console.log(t.slice(0,200)))" "$1" "$2"; }
outbox() { echo "--- plsvc outbox for $1"; Q plsvc <<EOF
select version v, type, left(event_id::text,8) eid, attempts att, (delivered_at is not null) dlv, (dead_at is not null) dead, last_status st, last_error err, to_char(next_attempt_at,'HH24:MI:SS') next, payload::text facts from sf_event_outbox where pl_account_id = '$1' order by version;
EOF
}
fork_rb() { echo "--- fork readback (workspace $ORG) account $1"; Q uplink <<EOF
select 'identity' k, ei.external_id, left(ei.contact_id::text,8) contact from external_identities ei where ei.org_id='$ORG' and ei.external_id='$1';
select 'inbox' k, left(event_id::text,8) eid, type, version v, applied, outcome from integration_event_inbox where org_id='$ORG' and external_id='$1' order by version, received_at;
select 'facts' k, last_version, facts::text from integration_subject_facts where org_id='$ORG' and external_id='$1';
select 'activity' k, to_char(a.completed_at,'HH24:MI:SS') at, a.subject, a.metadata->>'event_type' etype, (a.metadata->>'version') v, a.metadata->>'stale' stale, left(a.metadata->>'event_id',8) eid from activities a join external_identities ei on ei.contact_id=a.contact_id and ei.org_id=a.org_id where a.org_id='$ORG' and ei.external_id='$1' and a.type='personal_line' order by a.completed_at, a.created_at;
select 'bus' k, event_type, left(payload->>'eventId',8) eid, payload->>'version' v, payload->>'stale' stale from workflow_event_log where org_id='$ORG' and event_type like 'pl.%' and payload->>'plAccountId'='$1' order by emitted_at;
EOF
}
acct_by_wa() { Q plsvc <<EOF | grep -E '^[a-z0-9]{20,}' | head -1
select id from lite_accounts where "ownerPhone" = '$1' order by "createdAt" desc limit 1;
EOF
}
phase=$1; shift
case "$phase" in
  pre)
    assert_target
    echo "plsvc svc: $(dk service ls --format '{{.Name}} {{.Image}} {{.Replicas}}' | grep -E 'zzemit')"
    Q plsvc <<'EOF'
select count(*) as outbox_rows from sf_event_outbox;
EOF
    Q uplink <<EOF
select count(*) filter (where org_id='$ORG') as inbox_rows_in_workspace, count(*) as inbox_rows_total from integration_event_inbox;
select slug, integrations->'personalLine' - 'lastCheckedAt' as pl_record from organizations where id='$ORG';
select service_name, scope from workspace_secrets where workspace_id='$ORG';
EOF
    echo "--- plsvc env NAMES relevant (values not printed except booleans/kid)"; dk exec $PLC sh -c 'for n in PL_SF_OUTBOX_ENABLED PL_SF_EVENTS_URL PL_SF_EVENTS_KID PL_SF_EVENTS_KEY_FILE PL_CONCIERGE_SVC_PROVISION_ENABLED CRON_SECRET PL_ASSERTION_HMAC_KEY MAGNUS_URL AMI_LISTENER_URL; do eval v=\${$n}; if [ -n "$v" ]; then case $n in PL_SF_OUTBOX_ENABLED|PL_CONCIERGE_SVC_PROVISION_ENABLED|PL_SF_EVENTS_KID) echo "$n=$v";; PL_SF_EVENTS_URL|MAGNUS_URL|AMI_LISTENER_URL) echo "$n=$(echo $v | sed -E "s#[0-9a-f]{8}-[0-9a-f-]{27}#<org>#")";; *) echo "$n=<set len=${#v}>";; esac; else echo "$n=<unset>"; fi; done; ls -l /run/secrets/pl_sf_events_key | awk "{print \"secret file:\", \$1, \$5\" bytes\"}"'
    ;;
  install-driver) assert_target; dk cp $D/zz-emit-driver.mjs $PLC:/tmp/zz-emit-driver.mjs && echo "driver installed in $PLC" ;;
  prov) assert_target; PL provision "$1" "$2" ;;
  tick) assert_target; PL get /api/cron/sf-outbox ;;
  counts) assert_target; PL get '/api/cron/sf-outbox?counts=1' ;;
  watch) assert_target; PL get /api/cron/registration-watch ;;
  peer) assert_target; mockget "/__peer?name=$1&status=$2" ;;
  regsetup)   # the credential hand-off fixture the watch reads (the activation page itself needs a device)
    assert_target
    Q plsvc rw <<EOF
insert into "AgentActivity"(id,"agentId",type,summary,metadata) values ('zzemit-act-$1','synthetic-concierge-agent','lite_activation','zzemit-$1',
 jsonb_build_object('nonce','zzemit','liteAccountId','$1','verified',true,'xmlFetched',true,'xmlFetchedAt',(extract(epoch from now())*1000)::bigint-30000,'nonceExpiresAt',(extract(epoch from now())*1000)::bigint+600000));
EOF
    ;;
  cdr)   # an ANSWERED call (sessiontime > 0) for the account's Magnus user, in OUR mock's CDR
    assert_target
    MU=$(Q plsvc <<EOF | grep -E '^[0-9]+$' | head -1
select "magnusUserId" from lite_accounts where id='$1';
EOF
)
    echo "magnus user (mock) = $MU"
    mockpost "/mbilling/index.php/call/save" "id_user=$MU&starttime=$(date -u +%Y-%m-%d+%H:%M:%S)&sessiontime=42&real_sessiontime=42&callerid=zzemit&calledstation=17675550142&uniqueid=zzemit-cdr-$1"
    ;;
  late)   # OLDER-EVENT: account $1 gets a v5 registration_changed(registered) delivered FIRST, then a DEAD v2 registration_changed(not_registered) is requeued and delivered after it
    assert_target
    Q plsvc rw <<EOF
insert into sf_event_outbox(event_id,dedupe_key,type,pl_account_id,version,occurred_at,payload,next_attempt_at) values
 (gen_random_uuid(),'zzemit-late-v5:$1','pl.registration_changed','$1',5,now() at time zone 'utc','{"registration_now":"registered"}',now() at time zone 'utc'),
 (gen_random_uuid(),'zzemit-late-v2:$1','pl.registration_changed','$1',2,(now() at time zone 'utc') - interval '5 minutes','{"registration_now":"not_registered"}',now() at time zone 'utc');
update sf_event_outbox set dead_at = now() at time zone 'utc', last_error='zzemit_held_back_to_simulate_a_late_arrival' where dedupe_key='zzemit-late-v2:$1' and delivered_at is null;
EOF
    ;;
  reset-delivered)   # force a redelivery of an already-delivered event of mine (by event id prefix, account-scoped)
    assert_target
    Q plsvc rw <<EOF
update sf_event_outbox set delivered_at = null, next_attempt_at = now() at time zone 'utc', last_error='zzemit_forced_redelivery' where pl_account_id='$1' and left(event_id::text,8)='$2' and delivered_at is not null;
select left(event_id::text,8) eid, type, version, attempts, delivered_at is null as pending from sf_event_outbox where pl_account_id='$1' and left(event_id::text,8)='$2';
EOF
    ;;
  insert-signup-started)   # a type the receiver does not accept: proves a permanent 4xx is dead-lettered visibly
    assert_target
    Q plsvc rw <<EOF
insert into sf_event_outbox(event_id,dedupe_key,type,pl_account_id,version,occurred_at,payload,next_attempt_at)
 values (gen_random_uuid(),'zzemit-signup-started:$1','pl.signup_started','$1',90,now() at time zone 'utc','{}',now() at time zone 'utc');
EOF
    ;;
  probes)
    assert_target
    OTHER=4535d525-df75-4d72-bfd6-1de3ee98d030
    PL fork good '{"pl_account_id":"zzemitprobe","version":1,"facts":{"registration_now":"registered"}}'
    PL fork badsig '{"pl_account_id":"zzemitprobe","version":2}'
    PL fork oldts  '{"pl_account_id":"zzemitprobe","version":3}'
    PL fork otherpath '{"pl_account_id":"zzemitprobe","version":4,"other_org":"'$OTHER'"}'
    PL fork good '{"type":"pl.signup_started","pl_account_id":"zzemitprobe","version":5,"facts":{}}'
    ;;
  fork-down) dk service scale uplinkstg_zzemit_app=0 2>&1 | tail -n 2 ;;
  fork-up)   dk service scale uplinkstg_zzemit_app=1 2>&1 | tail -n 2 ;;
  delete-outbox-row)   # simulate a line that PRE-DATES the integration: remove my own pending line_created row for account $1
    assert_target
    Q plsvc rw <<EOF
delete from sf_event_outbox where pl_account_id='$1' and dedupe_key='line_created:$1' and delivered_at is null;
select count(*) as remaining from sf_event_outbox where pl_account_id='$1';
EOF
    ;;
  outbox) outbox "$1" ;;
  forkrb) fork_rb "$1" ;;
  sql-plsvc) Q plsvc "$@" ;;
  *) echo "unknown phase"; exit 2 ;;
esac
