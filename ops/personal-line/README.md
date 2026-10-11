# Personal Line — operational source of record

Everything here is what runs (or ran) for the Personal Line launch on WhatsApp +1 767 818 0001, committed so it can be
rebuilt and reviewed. Protocol (owner 2026-10-11): **no production change ships unless its source is committed or a PR is
open in the same dispatch.**

| Folder | What | Production state (2026-10-11) |
|---|---|---|
| `agent-config/` | Uplink agent configs v10–v15 for agent `28a55c69` + `uplink_agent_apply.ts` (Uplink's own updateAgentBlueprint, dry/apply, readback) + `apply-prod.sh` | v15 config live as agent version 14 |
| `flows/` | WhatsApp Flow JSON v6, v7 (do not use: INSTALL NavigationList description > 20 chars), **v7.1 (live, Flow id 1028745810223586)** + flag/badge PNG sources | plsvc `PL_SIGNUP_FLOW_ID` = v7.1 |
| `plsvc-patches/` | Patch series applied to the Personal Line service (isolav2 base `cbf1d10c`) rc9 → rc15, in order | plsvc image `prod3-go-rc15-cbf1d10c`; the patched source tree is committed to isolav2 separately (see Port) |
| `staging-harness/` | host03 staging suite (synthetic identities, real model under the staging dollar gate) | — |
| `journey-monitor/` | Exception monitor (cron `*/5` on host03 `~/pl-monitor`) + fixture tests | live |
| `specs/` | SeldonFrame runtime-linked agent (Class 2) spec v1 | Planned |

Related services: `services/sf-relay/` (Chatwoot ⇄ Uplink relay) and `services/pl-action-adapter/` (MCP tools).
Port: `ev-pl-*-2026-10-11` evidence records; decisions `dec-two-agent-classes-…-2026-10-11`.
