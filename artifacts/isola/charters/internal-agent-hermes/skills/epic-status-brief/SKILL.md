---
name: epic-status-brief
description: "Answer 'where are we with Personal Line / Uplink / <project>?' with sourced done / blocked / unknown / next, labelling stale vs live."
version: 1.0.0
author: EPIC internal-agent lane
metadata:
  hermes:
    tags: [EPIC, status, Port, Uplink, Personal Line]
---

# EPIC status brief

Use when asked for project status, "where are we", priorities, blockers, or what is next.

## Procedure

1. Try the live source first. If a Port read tool is available (name starts with `port`), read in this order and record each entity id and its updated/last-reviewed time:
   - `plan-isola-uplink-host03-production-and-prune-2026-10-06` (execution_plan) for the Uplink launch status.
   - `isola-current-plan` (execution_plan) for the master plan.
   - Open defects: blueprint `defect`, titles containing `uplink` (newest first).
   - Newest `evidence` for the topic, newest first (top 5).
2. If no Port read tool is available or a read fails, say in the FIRST LINE: "I cannot read Port right now; the following is from the brief snapshot dated 2026-10-07, not live." Then use `references/snapshot-2026-10-07.md`. Do not describe snapshot content as current.
3. Compose the answer in exactly this order:
   - **Source and freshness** (live or snapshot; entity ids; as-of times)
   - **Done** (each item with its evidence id)
   - **Blocked / needs a decision** (blocker, owner, what unblocks it)
   - **Unknown** (what you could not verify)
   - **Next executable action** (one action, who runs it)
4. Distinguish a stale receipt from current state: if the newest evidence is older than 24 hours, or a later record exists that supersedes it, say so.
5. Never state percentages, dates or spend that the source does not state.

## Do not

Do not call Odoo, telecom or deployment systems to "double check"; you do not have them. Do not claim a deployment, customer delivery or test passed unless an evidence record says so and you quote it.
