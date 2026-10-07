# Paperclip synthetic action test - supported mechanism (prepared 2026-10-07, NOT YET RUN)

Purpose: prove one confirmed internal action end to end using the execution context Paperclip itself issues. No run id is invented, no control is bypassed, nobody is contacted.

## Traced path (from Port records)
Paperclip company 3ed3869b-463c-4876-8e16-ddc058f06cd9, agent 21fa3ed2-9071-4c5f-b71d-014a77c4738d ("EPIC Business Assistant", adapter hermes_gateway, apiBaseUrl http://isola_hermes-agent:8642 = the host03 service repaired in this lane; key matched the service's API_SERVER_KEY by value-blind hash on 2026-09-27; heartbeat off; budget US$10; sessionKeyStrategy issue). Assigning an issue to that agent triggers an automatic wake: Paperclip POSTs /v1/runs on Hermes (202), streams events, and puts the real run id in the prompt. The Hermes paperclip MCP wrapper then requires that run_id on every write (missing -> refused locally; invented -> server 500). Evidence: ev-paperclip-hermes-gateway-bound-2026-09-27, ev-pilot-assistant-agent-configured-2026-09-27, ev-pilot-assistant-first-successful-run-2026-09-27, ev-epi-310-closed-by-ops-manager-timeout-180-stranded-followup-issues-2026-09-29.

## Who does what
- Owner (or Lane A) creates ONE issue in Paperclip (https://isola-ai.saas00.epic.dm, the board UI) and assigns it to "EPIC Business Assistant". This lane has no Paperclip credential and will not use the board token (secret mount; guard) .
- This lane observes: Hermes service logs and session store (wake received, tool calls, run_id usage), then reads the issue back (the agent's own paperclipGetIssue/paperclipListComments output, and a read-only record check if a permitted channel exists).

## Issue text to paste
Title: [SYNTHETIC TEST] Internal Agent acceptance - post one comment and read it back

Description:
This is a synthetic test of the Internal Agent. Nobody is to be contacted. Do not change any other issue.
1. Read this issue with paperclipGetIssue and confirm its identifier.
2. Post exactly ONE comment with paperclipAddComment, using the real run id from your instructions as run_id. The comment must contain: the sentence "Internal Agent acceptance test", the current UTC date as you know it from the run context, and the exact list of tools you have been given (names only).
3. Read the comments back with paperclipListComments. Quote the id and the first line of the comment you posted. Only then say it was posted.
4. Set the issue to done with ONE paperclipUpdateIssue call that includes your disposition comment (reference the comment id from step 3). Use the same run_id.
Rules: if any write times out or errors, do NOT retry it with changed content; re-read the issue state first, then report what you saw and stop. Writes can take 20-95 seconds. State plainly if you could not complete a step.

## Pass criteria
- Hermes log shows one inbound /v1/runs and the run completes; exactly one agent comment with the required sentence; read-back quoted by the agent matches the stored comment; issue status done; no second copy of the comment; no other issue touched; nothing sent to any customer.
- Honest failure is also a result: record the exact error (401/500/timeout) and stop.

## Before running
Check that no other run is active on the service (Paperclip budget, one wake only). Expected cost: one run of roughly 12-15k tokens on the openai-codex login (see ACCEPTANCE-TURNS.md allowance).
