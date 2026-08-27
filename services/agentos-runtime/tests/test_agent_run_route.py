"""End-to-end tests against the real `/v1/agent-run` route (main.app), with
`run_operations_coordinator` monkeypatched so nothing here requires a live
model credential or network access.

Test category mapping:
  1. Valid service authentication
  2. Invalid/missing service authentication (rejected before Agno logic runs)
  3. Tenant refusal (sidecar side, independent of Node's own check)
  4. Template refusal
  5. Exposure refusal
  7. Dependency unavailable (model backend unreachable -> clear failure)
  8. Failed AgentOS run (non-completed terminal status)
  9. Malformed/ambiguous response is never produced by THIS side — covered by
     asserting the response always validates against AgentRunResponse
  11. Correlation propagation (echoed back is not required by the contract,
      but the SAME id must appear in the log line the sidecar emits — see
      test_logging_redaction.py, which is where that assertion lives)
"""

from __future__ import annotations

from agentos_runtime.agent import AgentRunOutcome

VALID_BODY = {
    "correlationId": "corr-1",
    "tenantId": "8D3dp3z",
    "templateId": "epic-staff-operations-coordinator@v1",
    "exposure": "INTERNAL",
    "context": "the run context text",
}


def _auth_headers(secret: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {secret}"}


def test_valid_auth_and_eligible_request_completes(client, app_module, monkeypatch, base_env):
    async def fake_run(context_text: str) -> AgentRunOutcome:
        assert context_text == VALID_BODY["context"]
        return AgentRunOutcome(
            completed=True,
            content="the answer",
            model="deepseek-chat",
            prompt_tokens=10,
            completion_tokens=5,
            cached_prompt_tokens=0,
        )

    monkeypatch.setattr(app_module, "run_operations_coordinator", fake_run)

    res = client.post(
        "/v1/agent-run",
        json=VALID_BODY,
        headers=_auth_headers(base_env["shared_secret"]),
    )
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "completed"
    assert body["content"] == "the answer"
    assert body["usage"]["promptTokens"] == 10


def test_missing_auth_is_rejected_before_agno_logic(client, app_module, monkeypatch):
    called = {"count": 0}

    async def fake_run(context_text: str) -> AgentRunOutcome:
        called["count"] += 1
        return AgentRunOutcome(completed=True, content="should never run")

    monkeypatch.setattr(app_module, "run_operations_coordinator", fake_run)

    res = client.post("/v1/agent-run", json=VALID_BODY)
    assert res.status_code == 401
    assert called["count"] == 0


def test_invalid_secret_is_rejected(client, base_env):
    res = client.post(
        "/v1/agent-run",
        json=VALID_BODY,
        headers=_auth_headers("totally-wrong-value"),
    )
    assert res.status_code == 401


def test_wrong_tenant_is_refused_before_agno_logic(client, app_module, monkeypatch, base_env):
    called = {"count": 0}

    async def fake_run(context_text: str) -> AgentRunOutcome:
        called["count"] += 1
        return AgentRunOutcome(completed=True, content="should never run")

    monkeypatch.setattr(app_module, "run_operations_coordinator", fake_run)

    body = {**VALID_BODY, "tenantId": "some-other-tenant"}
    res = client.post("/v1/agent-run", json=body, headers=_auth_headers(base_env["shared_secret"]))
    assert res.status_code == 403
    assert "tenant_refused" in res.json()["detail"]
    assert called["count"] == 0


def test_wrong_template_is_refused(client, base_env):
    body = {**VALID_BODY, "templateId": "some-other-template@v1"}
    res = client.post("/v1/agent-run", json=body, headers=_auth_headers(base_env["shared_secret"]))
    assert res.status_code == 403
    assert "template_refused" in res.json()["detail"]


def test_wrong_exposure_is_refused(client, base_env):
    body = {**VALID_BODY, "exposure": "PUBLIC"}
    res = client.post("/v1/agent-run", json=body, headers=_auth_headers(base_env["shared_secret"]))
    assert res.status_code == 403
    assert "exposure_refused" in res.json()["detail"]


def test_dependency_unavailable_returns_clear_failure_not_fabricated_answer(
    client, app_module, monkeypatch, base_env
):
    async def fake_run(context_text: str) -> AgentRunOutcome:
        return AgentRunOutcome(
            completed=False,
            failure_reason="dependency_unavailable (ConnectionError)",
        )

    monkeypatch.setattr(app_module, "run_operations_coordinator", fake_run)

    res = client.post("/v1/agent-run", json=VALID_BODY, headers=_auth_headers(base_env["shared_secret"]))
    assert res.status_code == 200  # the SIDECAR answered; the RUN failed
    body = res.json()
    assert body["status"] == "error"
    assert body["content"] is None
    assert "dependency_unavailable" in body["reason"]


def test_agno_non_completed_status_is_treated_as_failed(client, app_module, monkeypatch, base_env):
    async def fake_run(context_text: str) -> AgentRunOutcome:
        return AgentRunOutcome(completed=False, failure_reason="agno_non_completed_status (ERROR)")

    monkeypatch.setattr(app_module, "run_operations_coordinator", fake_run)

    res = client.post("/v1/agent-run", json=VALID_BODY, headers=_auth_headers(base_env["shared_secret"]))
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "error"
    assert body["content"] is None


def test_response_body_always_matches_the_declared_schema(client, app_module, monkeypatch, base_env):
    """A body missing a required field, or an extra field, would fail FastAPI's
    own response_model validation — this is the type-system enforcement the
    architecture spec asks for, made concrete: it is not POSSIBLE for this
    route to emit an ambiguous or malformed body, because pydantic would
    refuse to serialize one.
    """
    async def fake_run(context_text: str) -> AgentRunOutcome:
        return AgentRunOutcome(completed=True, content="ok")

    monkeypatch.setattr(app_module, "run_operations_coordinator", fake_run)

    res = client.post("/v1/agent-run", json=VALID_BODY, headers=_auth_headers(base_env["shared_secret"]))
    body = res.json()
    assert set(body.keys()) == {"status", "content", "model", "usage", "reason"}


def test_healthz_is_unauthenticated_and_reveals_nothing(client):
    # AgentOS's own built-in /health route (get_health_router) — no Authorization
    # header sent, and it must still answer 200: it is one of AgentOS's own
    # DEFAULT excluded_route_paths. No template id, tenant or config value is
    # asserted here on purpose — this only proves it is REACHABLE unauthenticated.
    res = client.get("/health")
    assert res.status_code == 200
    body_text = res.text.lower()
    for leak in ("8d3dp3z", "epic-staff-operations-coordinator", "shared_secret", "jwt"):
        assert leak not in body_text


def test_malformed_envelope_missing_required_field_is_rejected(client, base_env):
    body = {k: v for k, v in VALID_BODY.items() if k != "tenantId"}
    res = client.post("/v1/agent-run", json=body, headers=_auth_headers(base_env["shared_secret"]))
    assert res.status_code == 422


def test_envelope_rejects_unexpected_extra_fields(client, base_env):
    # The envelope type is the enforcement: an extra field (e.g. something
    # that looks like a credential) is refused outright, never silently
    # accepted and ignored.
    body = {**VALID_BODY, "odooApiKey": "should-never-be-a-field"}
    res = client.post("/v1/agent-run", json=body, headers=_auth_headers(base_env["shared_secret"]))
    assert res.status_code == 422
