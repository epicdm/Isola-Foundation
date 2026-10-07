# Runbook / decision / prior-work index, snapshot 2026-10-07

Entries were located by a read-only inventory on 2026-10-07; the documents themselves were not all re-read. Repo paths are relative to the Isola-Foundation repository (some files live only in other lanes' working trees or are untracked; verify before relying on them). Port ids are exact.

## Ratified decisions (Port, blueprint decision)
- dec-owner-hermes-single-easypanel-native-migrate-then-shutdown-2026-09-29: the Hermes in use is the host03 EasyPanel one; deepseek profiles are migrated, then stopped; no deepseek stop without Lane A GO.
- dec-owner-relocate-deepseek-mcp-tools-to-host03-hermes-2026-09-27: relocate the mature deepseek MCP tools to host03 as purpose-built production tools (no generic query_odoo/update_record).
- dec-epic-owner-os-canonical-dual-channel-2026-07-23: one canonical Owner OS brain, WhatsApp and Telegram channels.
- dec-hermes-internal-staged-go-live-2026-07-27: staged internal go-live (owner operations, pilot, all staff) with gates.
- dec-runtime-is-a-menu-hermes-internal-reratified-2026-08-17: Hermes re-ratified for INTERNAL exposure only.
- dec-owner-runtime-first-personal-line-sales-agent-2026-10-03: Personal Line sales agent replies from the Hermes runtime; Paperclip asynchronous.
- dec-owner-isola-production-host03-uplink-deepseek-beta-2026-10-06: host03 is production (uplink.epic.dm); deepseek is the beta/testbed.
- dec-owner-seldonframe-native-first-collapse-business-portal-2026-10-04: SeldonFrame native business workspace; Isola keeps telecom, identity, wallet, Odoo ledger, provisioning.
- dec-owner-personal-line-support-hours-8-6-2026-10-01: human support 08:00-18:00 America/Dominica Mon-Sat.
- dec-owner-uplink-acceptance-model-test-budget-usd3-2026-10-07: US$3 aggregate model-test budget for Uplink acceptance.

## Plans and runbooks (Port, blueprint execution_plan)
- isola-current-plan (master plan); plan-isola-uplink-host03-production-and-prune-2026-10-06 (Uplink phased plan); plan-internal-agent-hermes-host03-canonical-2026-10-07 (this agent).
- runbook-int-001-hermes-telegram-full-text-2026-09-10 (v3): INT-001 on Hermes epic-operator over Telegram.
- lane-isola-internal-agent-workspace-standup-2026-10-02 (predecessor charter).

## Evidence worth knowing (Port, blueprint evidence)
- ev-hermes-native-capability-review-2026-10-03: what native Hermes provides (dashboard, skills, sessions, cron, webhook/API platforms) and the toolset-scoping warning.
- ev-lane-a-uplink-v4-4-reuse-inventory-and-smallest-connection-2026-10-06: Personal Line plane inventory and the smallest connection to Uplink.
- ev-internal-agent-lane-host03-hermes-baseline-and-dashboard-502-2026-10-07 and ev-internal-agent-lane-dashboard-repaired-and-hermes-upgraded-to-v0-21-5-2026-10-07: this service's baseline, repair, upgrade, rollback.

## Repo documents (docs/isola/ unless noted)
- PAPERCLIP-OWNER-MANUAL-2026-08-28.md: owner operating manual for Paperclip.
- CHARTER-EDIT-CHECKLIST-2026-08-19.md: how to edit an agent charter safely.
- RUNBOOK-STOP-THE-AI-6737.md: stop the AI on the 6737 front-desk line.
- ISOLA-PERSONAL-PILOT-ROLLBACK-AND-SUPPORT.md: Personal Line pilot rollback and support.
- EASYPANEL-TRANSITION-PACK.md: EasyPanel transition.
- CDR-ANOMALY-WATCH-HANDOVER.md: call-record anomaly watch.
- SIP-CREDENTIAL-LOG-EXPIRY-AND-ROTATION-RUNBOOK.md: SIP credential log expiry/rotation.
- CHATWOOT-COMPOSE-MIGRATION-RUNBOOK.md and CHATWOOT-DEEPSEEK-TO-COOLIFY-MIGRATION-RUNBOOK.md: Chatwoot migrations.
- WS4-IDEMPOTENCY-AND-ROLLBACK-CONTRACTS.md: idempotency and rollback contracts.
- ODOO-CONTEXT-GET-LIVE-VERIFICATION-2026-09-18.md: live verification of Odoo context.
- ISOLA-PREDEFINED-AGENT-CATALOGUE.md: predefined agent catalogue.
- artifacts/isola/charters/: charter snapshots for the old internal manager and front desk.

## Prior Hermes / Owner OS work retained on deepseek (not deployed here)
- Skills in ~/.hermes/shared-founder-skills (founder-brief, collections-odoo-reconciliation, customer-tenant-360, isola-launch-readiness, operations-investigation, founder-open-loops, internal-work-brief, end-of-day-closure): adopt later; they need Odoo/ops tools that do not exist on this host yet.
- MCP servers in bff-v2/services (mcp-owner-os, mcp-work-orchestrator, mcp-odoo, mcp-isola-ops, mcp-isola-customer-tools) and /home/epicdm/isola-staff-ops-mcp: relocation pending per the 2026-09-27 decision.
- Hermes state snapshots: ~/.hermes/state-snapshots (2026-07-06 and 2026-07-29) on deepseek.
