---
name: epic-work-order
description: "Prepare a lane work order and, only when a Paperclip run id exists, record it as a Paperclip issue with read-back."
version: 1.0.0
author: EPIC internal-agent lane
metadata:
  hermes:
    tags: [EPIC, work-order, Paperclip, coordination]
---

# EPIC work order

Use when asked to prepare, file, update or comment on a lane work order / internal task.

## Facts about your write tools (verified in the wrapper source, 2026-10-07)

- `paperclipCreateIssue`, `paperclipAddComment`, `paperclipUpdateIssue` REQUIRE `run_id`: the CURRENT Paperclip run id (a UUID) that appears in your instructions as "Use X-Paperclip-Run-Id ...". Paperclip puts it there only when Paperclip itself started this run.
- In a direct chat with a person (dashboard, API), there is NO run id. Never invent, guess or reuse one: an invented id is rejected with a server error, and a missing id is refused before any request is sent. Do not retry with a changed request.
- `paperclipMe`, `paperclipGetIssue`, `paperclipListComments` are reads and work without a run id.

## Procedure

1. Draft the work order in plain text first, always:
   - Title (one line)
   - Lane / owner (who should do it)
   - Objective and why (one short paragraph; cite the Port ids that justify it)
   - Scope in / scope out (what must not be touched; protected numbers, customer contact, billing, production changes are always out)
   - Acceptance: observable results and the evidence required
   - Rollback or stop condition
   - Source ids and as-of time
2. Show the draft and ask: "File this as a Paperclip issue?" Wait for an explicit yes. A draft the owner has not approved is never filed.
3. If you have a run id in your instructions: call `paperclipCreateIssue` (or `paperclipAddComment` / `paperclipUpdateIssue` for an existing issue) with exactly the approved text and that `run_id`. Then call `paperclipGetIssue` for the returned id and quote back the title, status and the first lines of the description you read. Only after quoting the read-back say it was created. If the read-back differs from the draft, say so.
4. If you have no run id (direct chat): do NOT call any write tool. Say plainly: "I can't file this from a direct chat because Paperclip writes need a run id that Paperclip issues. Here is the approved text to paste into Paperclip, or assign an issue to me in Paperclip and I will update it in that run." Give the final text.
5. If any tool returns an error (401, 403, 500): quote it, name who can fix it, stop. Do not look for another route.

## Do not

Do not create issues for customer contact, payments, telecom routing, Meta changes or production deploys; those need the owner and the owning lane. Do not include secrets or customer personal data in an issue.
