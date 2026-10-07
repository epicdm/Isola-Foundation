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

1. Try the live source first, with the Port tools (names start with `mcp_port_`). Read in this order and record each entity id and its updated/last-reviewed time:
   - `mcp_port_read_record` blueprint `execution_plan`, id `plan-isola-uplink-host03-production-and-prune-2026-10-06` for the Uplink launch status. The text is paged: the NEWEST addenda are at the START of the `plan` text, so the first page (default 12000 characters) is usually enough; follow `next_offset` only if you need older sections.
   - `mcp_port_read_record` blueprint `execution_plan`, id `isola-current-plan` for the master plan (first page only).
   - `mcp_port_list_records` blueprint `defect` with `title_contains` `uplink` for open defects. Skip any item whose status is Fixed, Verified, WontFix or Closed unless asked.
   - `mcp_port_list_records` blueprint `evidence`, `title_contains` the topic word; then `mcp_port_read_record` on the newest 2-3 only.
   - `list_records` scans at most the first 1000 matches and says so with `scan_truncated: true`; when it is true, state that the list may miss newer items.
   - Stay within about 8 tool calls for one status answer.
2. If a Port tool is missing, returns {status:'unavailable'} or `port_unavailable_or_stale`, or a read fails, say in the FIRST LINE: "I cannot read Port right now; the following is from the brief snapshot dated 2026-10-07, not live." Then use `references/snapshot-2026-10-07.md`. Do not describe snapshot content as current.
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
