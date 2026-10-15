# Reversal notes: owner-authorized reset of 9610 (17672859610), 2026-10-14

Backup folder (host04, root, 0700): /var/backups/pl-9610-reset-20261014/
Contents: lite_accounts, lite_plan_subscriptions, lite_minute_ledger, lite_provision_attempts, whatsapp_opt_in, lite_admission_log, lite_admission_queue (CSV, pre-reset rows), magnus-before.json (raw Magnus user 613, sip 789, did 547, diddestination 421, offerUse 37, call rows; 0600, contains the SIP secret, never print), chatwoot_conv_599.csv (status/assignee only), runtime-flags.json.before (sha 575bc9fb...4cfe).

What the supported fixture-reset route does (dry-run preview 06:45Z): deletes diddestination 421, offerUse 37, SIP peer 789; releases DID 547 (...5098) to the Magnus pool; DEACTIVATES Magnus user 613 (kept, balance 0.00); soft-retires the LiteAccount (ownerPhone and userId renamed to `17672859610-retired-<ts>`). Financial/ledger/subscription rows are NEVER deleted. Chatwoot conv 599 is not touched by the route; it is resolved separately.

Reversal, by layer (be honest: only the database part is exactly reversible):
1. LiteAccount: rename back. `update lite_accounts set "ownerPhone"='17672859610', "userId"='17672859610' where id='cmv3bl97b003h01l8ilc9mycm'` (the backup CSV has the exact original values) - only valid while no NEW account exists for the phone.
2. Magnus: user 613 can be re-activated; sip 789, diddestination 421 and offerUse 37 are DELETED by the route and are NOT recreated automatically (magnus-before.json has the raw fields to recreate by hand through the Magnus API). DID ...5098 returns to the pool and may be allocated to someone else.
3. Chatwoot conv 599: reopen as pending, assignee 20 (PL Relay Bot). The relay binding on it is not restored (it is not needed: a new conversation forms).
4. The new-customer re-signup creates a new account/DID/Magnus user; to discard that test account use the same supported fixture-reset route again (preview first).

Admission flags (separate change): reversal = write /var/backups/pl-9610-reset-20261014/runtime-flags.json.before back IN PLACE (cat >, same inode), sha must read 575bc9fb...4cfe.
