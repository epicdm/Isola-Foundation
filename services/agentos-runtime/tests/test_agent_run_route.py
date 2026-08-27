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

SERVER_PROMPT = "SERVER-AUTHORITATIVE CHARTER: you are the operations coordinator."

VALID_BODY = {
    "correlationId": "corr-1",
    "tenantId": "8D3dp3z",
    "templateId": "epic-staff-operations-coordinator@v1",
    "exposure": "INTERNAL",
    "systemPrompt": SERVER_PROMPT,
    "context": "the run context text",
}


def _auth_headers(secret: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {secret}"}


def test_valid_auth_and_eligible_request_completes(client, app_module, monkeypatch, base_env):
    async def fake_run(context_text: str, system_prompt: str) -> AgentRunOutcome:
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

    async def fake_run(context_text: str, system_prompt: str) -> AgentRunOutcome:
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

    async def fake_run(context_text: str, system_prompt: str) -> AgentRunOutcome:
        called["count"] += 1
        return AgentRunOutcome(completed=True, content="should never run")

    monkeypatch.setattr(app_module, "run_operations_coordinator", fake_run)

    body = {**VALID_BODY, "tenantId": "some-other-tenant"}
    res = client.post("/v1/agent-run", json=body, headers=_auth_headers(base_env["shared_secret"]))
    assert res.status_code == 403
    assert "tenant_refused" in res.json()["detail"]
    assert called["count"] == 0


def test_regression_forged_tenant_is_refused_when_sidecar_is_configured_for_another(
    base_env, monkeypatch, tmp_path
):
    """The Codex finding, end to end on the Python side.

    The sidecar is configured for a DIFFERENT tenant; the envelope forges the
    historically-allowlisted value. It must be refused before any Agno logic.
    """
    from conftest import fresh_import

    monkeypatch.setenv("AGENTOS_TENANT_ID", "a-different-configured-tenant")
    module = fresh_import("agentos_runtime.main")

    called = {"count": 0}

    async def fake_run(context_text: str, system_prompt: str) -> AgentRunOutcome:
        called["count"] += 1
        return AgentRunOutcome(completed=True, content="should never run")

    monkeypatch.setattr(module, "run_operations_coordinator", fake_run)

    from fastapi.testclient import TestClient

    with TestClient(module.app) as c:
        res = c.post(
            "/v1/agent-run",
            json=VALID_BODY,  # tenantId "8D3dp3z"
            headers=_auth_headers(base_env["shared_secret"]),
        )

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
    async def fake_run(context_text: str, system_prompt: str) -> AgentRunOutcome:
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
    async def fake_run(context_text: str, system_prompt: str) -> AgentRunOutcome:
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
    async def fake_run(context_text: str, system_prompt: str) -> AgentRunOutcome:
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
    res = client.get("/healthz")
    assert res.status_code == 200
    body_text = res.text.lower()
    for leak in ("8d3dp3z", "epic-staff-operations-coordinator", "shared_secret", "jwt"):
        assert leak not in body_text


def test_malformed_envelope_missing_required_field_is_rejected(client, base_env):
    # Carries a secret-shaped run context so the 422 body can be checked for
    # it: FastAPI's DEFAULT validation handler echoes the rejected input,
    # which on THIS route would mean writing the whole run context into an
    # HTTP response. main.py installs a field-names-only handler instead.
    planted_context_secret = "-".join(["not", "a", "real", "credential", "ctx"]) + "-" + "0" * 16
    body = {k: v for k, v in VALID_BODY.items() if k != "tenantId"}
    body["context"] = f"run context carrying {planted_context_secret}"

    res = client.post("/v1/agent-run", json=body, headers=_auth_headers(base_env["shared_secret"]))

    assert res.status_code == 422
    # The ASSERTION THAT MATTERS: the submitted value never comes back.
    assert planted_context_secret not in res.text
    # Positive control — the response is not simply empty, and it does name
    # the offending FIELD, so this is redaction rather than a broken handler.
    payload = res.json()
    assert payload["detail"] == "request body failed validation"
    assert "tenantId" in payload["fields"]


def test_envelope_rejects_unexpected_extra_fields(client, base_env):
    # The envelope type is the enforcement: an extra field (e.g. something
    # that looks like a credential) is refused outright, never silently
    # accepted and ignored — AND its value is never echoed back.
    planted_secret = "-".join(["not", "a", "real", "credential", "extra"]) + "-" + "0" * 16
    body = {**VALID_BODY, "odooApiKey": planted_secret}

    res = client.post("/v1/agent-run", json=body, headers=_auth_headers(base_env["shared_secret"]))

    assert res.status_code == 422
    # Previously this test asserted ONLY the status code, so it passed
    # vacuously on the very thing it was written to check.
    assert planted_secret not in res.text
    payload = res.json()
    assert payload["detail"] == "request body failed validation"
    # The field NAME is reported (that is useful and non-sensitive); the value
    # is not. This is also the positive control for the assertion above.
    assert "odooApiKey" in payload["fields"]


def test_validation_error_body_never_carries_submitted_values(client, base_env):
    """Broader shape check: several bad fields at once, none of their VALUES
    may appear anywhere in the response.
    """
    planted = {
        "ctx": "-".join(["not", "a", "real", "credential", "a"]) + "-" + "0" * 16,
        "extra": "-".join(["not", "a", "real", "credential", "b"]) + "-" + "0" * 16,
    }
    body = {
        **VALID_BODY,
        "context": planted["ctx"],
        "exposure": "NOT_A_VALID_EXPOSURE",
        "surpriseField": planted["extra"],
    }

    res = client.post("/v1/agent-run", json=body, headers=_auth_headers(base_env["shared_secret"]))

    assert res.status_code == 422
    for value in planted.values():
        assert value not in res.text
    assert "NOT_A_VALID_EXPOSURE" not in res.text
