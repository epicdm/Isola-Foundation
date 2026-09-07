#!/usr/bin/env bash
###############################################################################
# Register /isola-360 as a Chatwoot Dashboard App on the UAT account ONLY.
#
# Scope discipline: isola_chat is a LIVE instance -- it serves inbox.epic.dm and
# isola-chat.saas00.epic.dm, including the front desk. This script touches
# exactly one row, scoped to ACCOUNT 3 (UAT). It does not touch inboxes,
# webhooks, agent bots, automations or any other account.
#
# Mode:
#   $1 = "plan"   -> read current state only, mutate nothing (default)
#   $1 = "apply"  -> create the dashboard app, then read it back
#   $1 = "revert" -> delete the row this script created
###############################################################################
set -uo pipefail

MODE="${1:-plan}"
ACCOUNT_ID=3
TITLE="Customer 360"
APP_URL="https://isola-360-uat.saas00.epic.dm/isola-360"

CW=$(sudo docker ps -q --filter label=com.docker.swarm.service.name=isola_chat | head -1)
[ -z "$CW" ] && { echo "isola_chat container not found"; exit 1; }

run_rails() { sudo docker exec -i "$CW" bundle exec rails runner "$1" 2>&1 | grep -v '^$'; }

echo "=== PRE-STATE: dashboard apps that exist right now ==="
run_rails "
  puts %(  total dashboard_apps on this instance: #{DashboardApp.count})
  DashboardApp.all.each { |d| puts %(    id=#{d.id} account=#{d.account_id} title=#{d.title.inspect}) }
  puts %(  --- account ${ACCOUNT_ID} specifically: #{DashboardApp.where(account_id: ${ACCOUNT_ID}).count})
  puts %(  CONTROL account 2 (front desk, must stay untouched): #{DashboardApp.where(account_id: 2).count})
"

echo
echo "=== REVERSAL (write it down BEFORE mutating) ==="
echo "  bash $0 revert"
echo "  equivalent: DashboardApp.where(account_id: ${ACCOUNT_ID}, title: '${TITLE}').destroy_all"

if [ "$MODE" = "plan" ]; then
  echo
  echo "=== PLAN ONLY. Nothing was changed. Re-run with 'apply' to register. ==="
  exit 0
fi

if [ "$MODE" = "revert" ]; then
  echo
  echo "=== REVERTING ==="
  run_rails "
    n = DashboardApp.where(account_id: ${ACCOUNT_ID}, title: '${TITLE}').destroy_all.size
    puts %(  destroyed #{n} row(s))
    puts %(  remaining on account ${ACCOUNT_ID}: #{DashboardApp.where(account_id: ${ACCOUNT_ID}).count})
    puts %(  CONTROL account 2 still: #{DashboardApp.where(account_id: 2).count})
  "
  exit 0
fi

echo
echo "=== APPLYING (account ${ACCOUNT_ID} only) ==="
run_rails "
  acct = Account.find_by(id: ${ACCOUNT_ID})
  if acct.nil?
    puts '  ABORT: account ${ACCOUNT_ID} does not exist on this instance'
    exit 1
  end
  puts %(  account #{acct.id} = #{acct.name.inspect})

  # A dashboard app belongs to a user; pick an administrator OF THIS ACCOUNT.
  admin = acct.administrators.first
  if admin.nil?
    puts '  ABORT: account ${ACCOUNT_ID} has no administrator to own the app'
    exit 1
  end
  puts %(  owner user id=#{admin.id})

  existing = DashboardApp.find_by(account_id: acct.id, title: '${TITLE}')
  if existing
    existing.update!(content: [{ 'type' => 'frame', 'url' => '${APP_URL}' }])
    puts %(  UPDATED existing dashboard_app id=#{existing.id})
  else
    d = DashboardApp.create!(
      account_id: acct.id,
      user_id: admin.id,
      title: '${TITLE}',
      content: [{ 'type' => 'frame', 'url' => '${APP_URL}' }]
    )
    puts %(  CREATED dashboard_app id=#{d.id})
  end
"

echo
echo "=== READ-BACK (a create that is not read back is not evidence) ==="
run_rails "
  DashboardApp.where(account_id: ${ACCOUNT_ID}).each do |d|
    puts %(  id=#{d.id} title=#{d.title.inspect})
    puts %(     content=#{d.content.inspect})
  end
  puts %(  CONTROL account 2 unchanged at: #{DashboardApp.where(account_id: 2).count})
"
