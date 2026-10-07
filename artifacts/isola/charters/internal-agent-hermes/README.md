# Internal Agent (Hermes on host03) - operating brief, version-controlled copy

Owner: Internal Agent lane. Canonical plan: Port `plan-internal-agent-hermes-host03-canonical-2026-10-07`. Port wins where this and Port disagree.

## What is here
- `SOUL.md` -> deployed as `/opt/data/SOUL.md` (the agent's identity and rules). Replaces the stock 513-byte Nous persona.
- `skills/epic-status-brief`, `skills/epic-runbook-finder`, `skills/epic-work-order` -> deployed as `/opt/data/skills/epic/<name>/` (Hermes native skills, SKILL.md + references).

## Provenance and reuse decisions
- Role text, "source and as-of time for every fact", "no claim of recording before read-back": adapted from the Internal COO first-launch card (docs/isola/INTERNAL-COO-NATIVE-FIRST-LAUNCH-CARD-2026-10-04.md, other lane's worktree, untracked).
- "Propose, wait, execute, confirm" writes and untrusted-content rule: adapted from the deepseek `epic-operator` SOUL.md (5894 B, sha256 prefix b6b82594). Its Telegram/Owner-OS single-tool rules were NOT copied (no such tools here).
- Agent-side Laws (12 fail closed, 23 ambiguous negative, 13/18 controls, 24 resolve the toolset, 9 no permission inference, 10 retry that changes the request, 22 scoped authorization) distilled from CLAUDE.md section 2; engineering-only laws stay in the harness.
- Deliberately NOT deployed: the deepseek founder/EPIC skills (founder-brief, collections-odoo-reconciliation, customer-tenant-360, isola-launch-readiness, operations-investigation, ...). They call Odoo/ops MCP tools that do not exist on this host; deploying them would make the agent claim tools it lacks (Law 24). Adopt each when its tools are relocated per dec-owner-relocate-deepseek-mcp-tools-to-host03-hermes-2026-09-27.

## Deploy (host03, no restart needed; new sessions read these files)
Files are streamed into the running container as the `hermes` user (no secrets involved): see the evidence record for the exact commands. Recovery copy of the previous state: `/root/recovery-internal-agent-2026-10-07/` on host03 (tar of config/SOUL/auth; full volume tar).

## Roll back
Restore the previous SOUL.md from `opt-data-config-before.tar` (`tar -xf ... SOUL.md -C /opt/data` as the hermes user) and remove `/opt/data/skills/epic/`. Toolset change: `hermes tools enable|disable skills --platform api_server` (read config.yaml back after).

## Maintenance
Edit here, commit, redeploy. Snapshot files carry an as-of date; the agent must label them as snapshots until live Port reads are connected (milestone 4).
