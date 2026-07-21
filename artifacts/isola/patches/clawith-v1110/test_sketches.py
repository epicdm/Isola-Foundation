# NOT EXECUTED — no local Python/Clawith/MCP environment is available in this
# repo checkout. These are drafted test sketches for the two unapplied
# patches in this directory (isola_bridge.py.diff,
# mcp-isola-customer-tools-server.py.diff). They must be run for real inside
# each project's own test suite/CI before either patch is applied or
# deployed, per the mandate's stop line (no SSH-write, no deploy from here).
#
# Two independent suites are sketched below because the two patched files
# live in two different remote projects/repos (clawith-v1110 backend vs.
# mcp-isola-customer-tools). Import paths are illustrative, not verified.

# ============================================================================
# Suite 1 — backend/app/api/isola_bridge.py (BridgeMessageIn + caller_directive)
# ============================================================================
import pytest


class TestBridgeMessageInAcceptsEscalationFields:
    def test_conversation_ref_and_correlation_id_are_optional(self):
        """A pre-existing caller that never sends conversation_ref/
        correlation_id (e.g. any client not yet updated) must still validate —
        additive fields, not a breaking change to the bridge contract."""
        body = BridgeMessageIn(agent_id=SOME_AGENT_ID, phone="+17671234567", text="hi")
        assert body.conversation_ref is None
        assert body.correlation_id is None

    def test_conversation_ref_and_correlation_id_round_trip(self):
        body = BridgeMessageIn(
            agent_id=SOME_AGENT_ID,
            phone="+17671234567",
            text="hi",
            conversation_ref="opaque-ref-abc",
            correlation_id="corr-123",
        )
        assert body.conversation_ref == "opaque-ref-abc"
        assert body.correlation_id == "corr-123"


class TestCallerDirectiveEscalationInstruction:
    async def test_valid_bridge_minting_includes_escalation_instruction_with_ref(self, bridge_client):
        """When Foundation supplies a conversation_ref, the per-turn
        caller_directive handed to the agent runtime must include the
        escalate_to_human instruction, quoting the exact ref value, and must
        instruct the agent never to repeat/disclose/describe it."""
        resp = await bridge_client.post(
            "/isola/bridge/message",
            json={
                "agent_id": str(SOME_AGENT_ID),
                "phone": "+17671234567",
                "text": "I want to talk to a person",
                "conversation_ref": "opaque-ref-abc",
                "correlation_id": "corr-123",
            },
            headers={"X-Isola-Secret": TEST_SECRET},
        )
        assert resp.status_code in (200, 504)  # settled or timed out, both fine for this assertion
        directive = captured_runtime_instruction()  # test double / spy on enqueue_chat_runtime call
        assert "opaque-ref-abc" in directive
        assert "escalate_to_human" in directive
        assert "never repeat" in directive or "never" in directive

    async def test_no_ref_no_escalation_instruction(self, bridge_client):
        """When no conversation_ref is minted for this turn (e.g. no
        ClawithBinding resolved on the Foundation side), the caller_directive
        must NOT mention escalate_to_human at all — nothing to reference."""
        resp = await bridge_client.post(
            "/isola/bridge/message",
            json={"agent_id": str(SOME_AGENT_ID), "phone": "+17671234567", "text": "hi"},
            headers={"X-Isola-Secret": TEST_SECRET},
        )
        directive = captured_runtime_instruction()
        assert "escalate_to_human" not in directive

    async def test_response_echoes_correlation_id(self, bridge_client):
        resp = await bridge_client.post(
            "/isola/bridge/message",
            json={
                "agent_id": str(SOME_AGENT_ID),
                "phone": "+17671234567",
                "text": "hi",
                "correlation_id": "corr-999",
            },
            headers={"X-Isola-Secret": TEST_SECRET},
        )
        assert resp.json()["correlation_id"] == "corr-999"

    async def test_unauthorized_number_or_agent_unaffected_by_new_fields(self, bridge_client):
        """Existing 404 agent_not_found path must be unchanged by the additive
        fields — they must not be required, and must not be read before the
        agent lookup."""
        resp = await bridge_client.post(
            "/isola/bridge/message",
            json={
                "agent_id": str(NONEXISTENT_AGENT_ID),
                "phone": "+17671234567",
                "text": "hi",
                "conversation_ref": "opaque-ref-abc",
            },
            headers={"X-Isola-Secret": TEST_SECRET},
        )
        assert resp.status_code == 404
        assert resp.json()["error"] == "agent_not_found"

    async def test_malformed_bridge_payload_rejected_before_directive_construction(self, bridge_client):
        """conversation_ref/correlation_id must be typed str | None — a
        non-string value (e.g. an integer or nested object) must fail
        FastAPI/pydantic validation (422) rather than reach caller_directive
        string interpolation."""
        resp = await bridge_client.post(
            "/isola/bridge/message",
            json={"agent_id": str(SOME_AGENT_ID), "phone": "+17671234567", "text": "hi", "conversation_ref": 12345},
            headers={"X-Isola-Secret": TEST_SECRET},
        )
        assert resp.status_code == 422


# ============================================================================
# Suite 2 — mcp-isola-customer-tools/server.py (escalate_to_human tool)
# ============================================================================
import responses  # or respx/httpretty — illustrative only, matching whatever
                   # mocking library the MCP project's own test suite already uses


class TestEscalateToHumanTool:
    def test_missing_reference_short_circuits_without_calling_spine(self):
        """Empty/whitespace conversation_ref must fail fast locally and never
        hit the network — mirrors the spine's own 'conversation_ref required'
        check, but the tool should never depend on the spine to catch this."""
        result = escalate_to_human(conversation_ref="", reason="customer asked")
        assert result == {"escalated": False, "error": "conversation_ref_required", "correlation_id": None}
        assert len(responses.calls) == 0

    def test_valid_mcp_escalation_returns_escalated_true(self):
        responses.add(
            responses.POST, f"{SPINE_URL}/api/customer/escalate",
            json={"ok": True, "status": "escalated", "correlation_id": "corr-1"}, status=200,
        )
        result = escalate_to_human(conversation_ref="opaque-ref-abc", reason="customer asked for a human")
        assert result == {"escalated": True, "status": "escalated", "correlation_id": "corr-1"}
        sent = json.loads(responses.calls[0].request.body)
        assert sent == {"conversation_ref": "opaque-ref-abc", "summary": "customer asked for a human"}

    def test_expired_reference_surfaced_honestly(self):
        responses.add(
            responses.POST, f"{SPINE_URL}/api/customer/escalate",
            json={"ok": False, "error": "unknown_or_expired_conversation_ref", "correlation_id": "corr-2"}, status=404,
        )
        result = escalate_to_human(conversation_ref="stale-ref", reason="")
        assert result["escalated"] is False
        assert result["error"] == "unknown_or_expired_conversation_ref"

    def test_reference_for_another_agent_tenant_binding_or_inbox_surfaces_ref_scope_mismatch(self):
        responses.add(
            responses.POST, f"{SPINE_URL}/api/customer/escalate",
            json={"ok": False, "error": "ref_scope_mismatch", "correlation_id": "corr-3"}, status=403,
        )
        result = escalate_to_human(conversation_ref="wrong-scope-ref", reason="")
        assert result["escalated"] is False
        assert result["error"] == "ref_scope_mismatch"
        # This must never be silently swallowed or reworded as success.

    def test_binding_unresolved_surfaced_honestly(self):
        responses.add(
            responses.POST, f"{SPINE_URL}/api/customer/escalate",
            json={"ok": False, "error": "binding_unresolved", "correlation_id": "corr-4"}, status=409,
        )
        result = escalate_to_human(conversation_ref="some-ref", reason="")
        assert result == {"escalated": False, "error": "binding_unresolved", "correlation_id": "corr-4"}

    def test_malformed_conversation_ref_surfaced_honestly(self):
        responses.add(
            responses.POST, f"{SPINE_URL}/api/customer/escalate",
            json={"ok": False, "error": "malformed_conversation_ref", "correlation_id": "corr-5"}, status=400,
        )
        result = escalate_to_human(conversation_ref="wrong-purpose-ref", reason="")
        assert result["escalated"] is False
        assert result["error"] == "malformed_conversation_ref"

    def test_replay_returns_already_escalated_not_a_duplicate_success(self):
        """Calling the tool twice with the same still-valid ref must surface
        the spine's idempotent already_escalated status honestly, not a bare
        'escalated' repeated as if a second handoff/note occurred."""
        responses.add(
            responses.POST, f"{SPINE_URL}/api/customer/escalate",
            json={"ok": True, "status": "escalated", "correlation_id": "corr-6"}, status=200,
        )
        responses.add(
            responses.POST, f"{SPINE_URL}/api/customer/escalate",
            json={"ok": True, "status": "already_escalated", "correlation_id": "corr-6"}, status=200,
        )
        first = escalate_to_human(conversation_ref="idem-ref", reason="")
        second = escalate_to_human(conversation_ref="idem-ref", reason="")
        assert first["status"] == "escalated"
        assert second["status"] == "already_escalated"
        assert second["escalated"] is True  # still a true/confirmed handoff state, just not a new one

    def test_never_claims_handoff_on_non_200_without_ok_true(self):
        """Defensive: even an unexpected 200 with ok missing/false must not be
        read as a successful handoff."""
        responses.add(
            responses.POST, f"{SPINE_URL}/api/customer/escalate",
            json={"weird": "shape"}, status=200,
        )
        result = escalate_to_human(conversation_ref="some-ref", reason="")
        assert result["escalated"] is False

    def test_no_tenant_account_inbox_or_binding_id_accepted_by_tool_signature(self):
        """The tool signature itself is the enforcement point: it has no
        parameters for tenant_id/account_id/inbox_id/binding_id/conversation_id,
        so there is no code path by which the calling agent could supply one."""
        import inspect
        sig = inspect.signature(escalate_to_human)
        assert set(sig.parameters) == {"conversation_ref", "reason"}
