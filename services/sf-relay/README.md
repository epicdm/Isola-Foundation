# Isola sf-relay r4 candidate

Candidate derived from the deployed v3 source archive identified as commit
`3cb84eaa0e7db4e6e609bff8475b242f46076ff5` (tree
`24a89c8f747e1e0ddc77fb129453fdd96ca929ae`). This is a source candidate only;
it has not been promoted or deployed.

## Preserved v3 behavior

- HMAC-signed Chatwoot webhook validation and fast acknowledgement.
- Account/inbox event scope, Chatwoot status as the human-ownership authority,
  assignment to the configured escalation team with account/inbox/team readback,
  and the unbacked-handoff promise guard.
- Explicit customer request, human silence, confirmed delivery and handback behavior.

The original 41-test v3 relay suite is retained byte-for-byte. R4 adds durable
signed SeldonFrame conversation-capability continuity bound to the Chatwoot
account/inbox/conversation and configured SeldonFrame workspace/agent. The
encrypted binding is stored as a Chatwoot conversation custom attribute and
read back before use. No second relay, inbox, CRM or agent is introduced.

## Personal Line assertion/context candidate

The isolated Codex successor adds `src/pl-concierge-assertion.js` and wires the
existing `src/relay.js` to mint a fresh, short-lived PL assertion only after
authenticated Chatwoot conversation/contact readback. Sender identity comes
from the matching WhatsApp contact-inbox `source_id`, never the contact phone
field or arbitrary webhook phone. The deployed `source_id` semantics still
need Lane A's authenticated inbox readback before enabling the key.

The relay sends an additional short-lived signed context envelope in the
`x-isola-relay-context` header to the existing native public-agent endpoint.
It is not placed in `channel_meta` or customer text. The Uplink source candidate
verifies and forwards the signed proof through MCP request `_meta`, separate
from model tool arguments. Lane A's MCP action service must also verify the
proof before forwarding its embedded assertion to the existing PL concierge
service.

When `PL_CONCIERGE_ASSERTIONS_ENABLED=1`, add protected mounted files and IDs:
`PL_CONCIERGE_ASSERTION_KEY_FILE`, `PL_CONCIERGE_ASSERTION_KID`,
`PL_CONCIERGE_CONTEXT_KEY_FILE`, `PL_CONCIERGE_CONTEXT_KID`, and the verified
`PL_CONCIERGE_PHONE_NUMBER_ID`. Also set `SF_ESCALATION_READBACK_ENABLED=1`
and provide a protected `SF_TOKEN_FILE` for authenticated current-turn
conversation/tool-result readback. The relay verifies workspace, agent,
visitor session, and Chatwoot channel/conversation binding before sending a
canonical offer. Without readback, Personal Line responses fail closed to
human handoff; model text is never used as the canonical offer. Context key
file content is shared with the
Uplink app's separate `UPLINK_RELAY_CONTEXT_KEY_FILE`; IDs must match. Never
print, store in Port, or bake key values into an image. Do not enable until
Lane A has confirmed credential rotation, protected mounts, workspace/inbox/agent scope, contact
`source_id` semantics, and service verification. `SF_TOKEN_FILE` contains a
workspace bearer credential (`wst_`) and is not natively least-privilege or
read-only; restrict file/host access and do not describe it otherwise.

The relay's optional `resolveConfirmation` dependency is deliberately absent
from the default server wiring. Therefore assertions never carry
`act=pl.confirm_signup` by default. Do not infer a confirmed plan from customer
text or model output. Current service source has no verified persisted
offer-selection binding in the provision gate; Lane A must resolve that exact
service gap before implementing a resolver. No button representation is
claimed; use a verified numbered reply only after the matching pending offer is
durably checked.

Each PL assertion nonce is one-use. The assertion attached to one authenticated
inbound event must not be replayed for multiple native tool calls in the same
model turn. The host03 action service must verify the signed event context and
mint a fresh assertion for each actual concierge HTTP action, or enforce and
test a single-action-per-event contract. Preserve the conversation/message
binding and concierge idempotency; never weaken nonce replay protection.

## Strict-mode configuration

Set `SF_REQUIRE_CONVERSATION_CAPABILITY=1`, `SF_WORKSPACE_ID`,
`SF_AGENT_ID` (the exact native agent UUID), `SF_AGENT_SLUG`, and
`SF_ESCALATION_READBACK_ENABLED` explicitly (`0` or `1`). The signed relay
context and encrypted conversation binding both include `SF_AGENT_ID`; a
missing/malformed ID fails startup or claim verification, and a different ID
cannot reuse an existing visitor conversation capability.
Set `SF_CONVERSATION_STATE_KEY_FILE` to a protected mounted random key file
(minimum 32 characters). Keep Chatwoot HMAC and bot API credentials in their
existing protected files. Configure `CHATWOOT_ESCALATION_TEAM_ID` and/or a
verified `CHATWOOT_OWNER_USER_ID`; team assignment is preferred when configured.

For the current Personal Line v13 agent, the PL action connector exposes
`pl_present_offer`; its durable tool result is read back before the relay
posts the exact `customer_message` as a separate Chatwoot message. Therefore
`PL_CONCIERGE_ASSERTIONS_ENABLED=1` requires
`SF_ESCALATION_READBACK_ENABLED=1` plus `SF_TOKEN_FILE`, even if the agent has
no escalation tool. The workspace bearer token must be protected; never reuse
operator MCP credentials as a customer runtime tool credential. Explicit
customer requests still go through Chatwoot team assignment/readback.

For the existing host03 staging run, the active v3.4 plan identifies workspace
`48467787-a471-4260-8265-a9893e2b2cae` and agent
`4c47c17f-f26a-46a7-a2e4-aa6f58a305b6`. Lane A must read back the staged
agent's actual slug and verify all three values before binding. Do not use the
production workspace `2a62ca68-5d6b-41bd-aea5-28a0aaba7fc8` or production
agent `a5e7235d-9fe1-409a-b824-d7810fc13ab1` for staging. These IDs are
environment-specific, not interchangeable. Keep inboxes 7, 8, 12 and 16
unchanged unless the staging runbook explicitly identifies a disposable target.
Do not modify inboxes 7, 8, 12 or 16.

## Validation

Run without dependency installation:

```powershell
node test/relay.test.js
node test/conversation-capability.test.js
```

The new tests use mock Chatwoot and Uplink endpoints only. They do not send
WhatsApp messages, call a model provider, change Meta routing or deploy an image.
