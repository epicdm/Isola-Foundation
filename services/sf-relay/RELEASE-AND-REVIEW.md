# Uplink relay r4 candidate receipt

## Identity and scope

- Base: deployed relay v3, commit `3cb84eaa0e7db4e6e609bff8475b242f46076ff5`.
- Base tree: `24a89c8f747e1e0ddc77fb129453fdd96ca929ae`.
- Base archive SHA-256: `59B325DD6CB936F06B085A524FF56378D6DC9B3D908C14319BF1C9B9CABC524C`.
- Candidate is isolated source only. No image was built, service changed, inbox bound, Meta callback changed, or customer message sent.
- Staging target from active plan v3.4: Chatwoot account 2 / inbox 11 only if Lane A confirms that is its isolated staging binding; Uplink workspace `48467787-a471-4260-8265-a9893e2b2cae`, agent `4c47c17f-f26a-46a7-a2e4-aa6f58a305b6`, and slug read back from that staged agent. Production is separately bound to workspace `2a62ca68-5d6b-41bd-aea5-28a0aaba7fc8` and agent `a5e7235d-9fe1-409a-b824-d7810fc13ab1`; never use those production IDs for staging.
- Inboxes 7, 8, 12, and 16 are not targets of this candidate.

## Changes from v3

- Retains v3 webhook HMAC verification, account/inbox filtering, human ownership checks, team assignment and assignment readback, truthful handoff backstop, duplicate-delivery behavior, AI silence during human ownership, and handback behavior.
- Adds the r3 signed Uplink conversation-capability transport and encrypted durable binding. The binding is scoped to Chatwoot account, inbox and conversation plus the configured Uplink workspace and agent; it is stored as a Chatwoot conversation custom attribute and read back before proceeding. The relay uses the anonymous public agent turn endpoint, not an operator API token.
- Makes `SF_AGENT_ID` a required UUID and includes it in the signed relay context and encrypted conversation binding. Missing, malformed, or mismatched IDs fail closed.
- Adds authenticated current-turn inspection. The readback verifies workspace, agent, visitor session, current user message, Chatwoot account, inbox, and conversation before the relay may use tool results for customer delivery.
- A successful current-turn `pl-action-adapter__pl_present_offer` result with a matching tool-result ID and expected offer payload is posted as only the adapter's canonical `customer_message`, in a separate Chatwoot message. The model's final prose is suppressed. Missing/malformed/failed readback and unbacked model confirmation-offer text fail closed through existing handoff controls. This closes the finding in Lane A's 2026-10-09 05:17Z receipt that had required verbatim model reproduction; Lane A must still verify actual Chatwoot delivery/readback on the staged image.
- PL assertion mode requires `SF_ESCALATION_READBACK_ENABLED=1` and a protected `SF_TOKEN_FILE` for authenticated conversation/tool-result readback. Lane A must verify permission scope and protected delivery.
- Updates candidate package metadata from the old UAT inbox label to account 2/inbox 11. Historical v3 tests remain unchanged and continue exercising their original UAT scope.

## Expected non-secret configuration

```text
CHATWOOT_ACCOUNT_ID=2
CHATWOOT_INBOX_ID=11
CHATWOOT_ESCALATION_TEAM_ID=8
SF_BASE_URL=https://uplink.epic.dm
SF_WORKSPACE_ID=48467787-a471-4260-8265-a9893e2b2cae
SF_AGENT_ID=4c47c17f-f26a-46a7-a2e4-aa6f58a305b6
SF_AGENT_SLUG=<read back from the existing staging agent>
SF_REQUIRE_CONVERSATION_CAPABILITY=1
SF_ESCALATION_READBACK_ENABLED=1
SF_TOKEN_FILE=<protected least-privilege readback token file>
SF_CONVERSATION_STATE_KEY_FILE=<protected EasyPanel-mounted file>
CHATWOOT_BOT_SECRET_FILE=<existing protected file>
CHATWOOT_BOT_TOKEN_FILE=<existing protected file>
```

Do not populate secret files from this document. Lane A must independently verify account/inbox/team membership, live workspace-agent binding, durable EasyPanel mounts, and the approved production rollback before deployment. Do not attach the bot or alter the phone-level Meta override as part of this source handoff.

## Validation evidence

On Node `v24.12.0`, in the candidate directory, with no dependency installation:

- `node --test --test-isolation=none --test-concurrency=1 test/*.test.js`: 66 passed, 0 failed, 0 skipped.
- The suite includes mock endpoint controls for current-turn readback scope, matching agent identity, canonical offer result parsing, deterministic separate offer delivery, and fail-closed malformed/failed/mismatched cases, as well as the existing continuation, duplicate delivery, assignment/readback, human silence, and handback cases.
- No model-provider calls, WhatsApp delivery, live Chatwoot mutation, staging service build, or image build occurred.

## Remaining delivery gaps

1. Lane A must review this exact superseding package, configure/build it through EasyPanel, verify protected secret mounts and least-privilege current-turn readback access, and independently run account-2/inbox-11 acceptance before any cutover. Verify that the canonical offer is actually posted and read back as a separate outgoing public Chatwoot message before treating confirmation as enabled.
2. The Personal Line native agent is FAQ-only. Its Uplink runtime supports external MCP connector bindings, but no verified provisioning MCP server/tool is currently deployed or bound. Existing `services/mcp-isola-customer-tools` has account lookup and escalation only; the line provisioning sequence is in BFF concierge/provisioner code. Therefore r4 proves relay conversation continuity and handoff behavior only, not line provisioning or customer activation.
3. Owner authorized at most US$0.50 of real-model staging within the existing US$10 aggregate and unchanged expiry. Lane A must bound evaluation, retries, tool calls, and the staging conversation within that sublimit before making calls. This receipt used US$0.00. It does not authorize public WhatsApp activation, real provisioning, Meta changes, or production traffic.

## Rollback

This candidate is not deployed. If a later authorized in-place deployment fails acceptance, revert the relay service image/configuration to the recorded deployed-v3 image and retain the replacement credential plus Chatwoot conversation custom attributes. Do not revoke a replacement credential during rollback; do not delete conversation history or alter Meta's shared callback. Reverting the relay does not restore any phone-level Meta override, so Lane A must leave that override unchanged unless its separate cutover card is authorized.
