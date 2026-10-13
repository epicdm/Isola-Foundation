#!/bin/bash
C=$(docker ps -q -f name=uplink_uplink-db-prod | head -1)
q() { docker exec -i $C sh -c 'psql -U "$POSTGRES_USER" -d uplink -X -At -F " | " -c "$0"' "$1" </dev/null; }
echo "== gate row now"; q "select spent_micro_usd, reserved_micro_usd, uncertain_micro_usd, budget_micro_usd, enabled from public_turn_spend_gates"
echo "== reservations by day: count, actual micro-USD, states"
q "select to_char(created_at,'MM-DD'), count(*), coalesce(sum(actual_micro_usd),0), string_agg(distinct state, ',') from public_turn_spend_reservations group by 1 order by 1 desc limit 6"
echo "== reservations from 09:00Z today (the synthetic copy tests): time, agent, state, actual"
q "select to_char(created_at,'HH24:MI:SS'), substr(agent_id::text,1,8), state, coalesce(actual_micro_usd,0), input_tokens, output_tokens from public_turn_spend_reservations where created_at >= '2026-10-13 09:00' order by created_at"
echo "== reservations 09:00Z today: total"
q "select count(*), coalesce(sum(actual_micro_usd),0) from public_turn_spend_reservations where created_at >= '2026-10-13 09:00'"
echo "== gate audit rows today: op, field, old, new, application, time"
q "select op, field, old_value, new_value, application_name, to_char(at,'HH24:MI:SS') from public_turn_spend_gate_audit where at >= '2026-10-13 00:00' order by at limit 25"
echo "== reservations sum for this gate, all time vs gate spent"
q "select count(*), coalesce(sum(actual_micro_usd),0) from public_turn_spend_reservations where gate_id='uplink-personal-line-public-14d'"
echo "== agent_evals since 2026-10-13 00:00 (positive control: all-time count shown after)"
q "select count(*) from agent_evals where ran_at >= '2026-10-13 00:00'"
q "select count(*), to_char(max(ran_at),'MM-DD HH24:MI') from agent_evals"
