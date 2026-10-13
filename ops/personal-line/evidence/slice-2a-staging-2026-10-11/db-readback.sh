ORG=cb2d5e9c-83f2-40ec-b248-e0e7c7c94ccf
U=$(sudo -n docker ps -q -f name=uplinkstg_uplink-db | head -1)
q() { sudo -n docker exec $U psql -U seldon -d seldonframe -Atc "$1"; }
echo "== identities"; q "select provider, external_id, contact_id from external_identities where org_id='$ORG' order by created_at"
echo "== self-entered contact C linked?"; q "select count(*) from external_identities where contact_id='09a53736-a03a-4e45-be4c-f53666e06c2b'"
echo "== contacts with fixture A phone"; q "select id, first_name, source, (email is not null) as has_email from contacts where org_id='$ORG' and right(phone,4)='4409' order by created_at"
echo "== inbox"; q "select type, version, applied, outcome from integration_event_inbox where org_id='$ORG' order by received_at"
echo "== facts"; q "select external_id, last_version, facts from integration_subject_facts where org_id='$ORG'"
echo "== activities"; q "select contact_id, type, subject from activities where org_id='$ORG' and type='personal_line' order by created_at"
echo "== workflow_event_log (native bus)"; q "select event_type, payload->>'contactId', payload->>'version', payload->>'stale' from workflow_event_log where org_id='$ORG' and event_type like 'pl.%' order by emitted_at"
echo "== control: total workflow_event_log rows for org"; q "select count(*) from workflow_event_log where org_id='$ORG'"
