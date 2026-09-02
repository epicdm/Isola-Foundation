"""The caller deadline, exercised through the REAL `/v1/agent-run` route.

Closes def-agentos-sidecar-ignores-caller-deadline-2026-08-27 at the route
level. tests/test_deadline_resolution.py covers the resolver as a pure
function; this file covers the path a request actually takes, because a suite
that only calls functions directly does not prove the route works (CLAUDE.md
Law 20 — measured by VOICE 2026-08-18 at 13/13 green on a path no test ever
traversed).

`run_operations_coordinator` is monkeypatched throughout, so nothing here
needs a live model credential or a socket. The fakes deliberately SLEEP: the
property under test is that something running longer than the deadline is
stopped, which cannot be observed against a fake that returns instantly.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import time
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from agentos_runtime.agent import AgentRunOutcome
from conftest import fresh_import

SERVER_PROMPT = "SERVER-AUTHORITATIVE CHARTER: you are the operations coordinator."

VALID_BODY = {
    "correlationId": "corr-deadline-1",
    "tenantId": "8D3dp3z",
    "templateId": "epic-staff-operations-coordinator@v1",
    "exposure": "INTERNAL",
    "systemPrompt": SERVER_PROMPT,
    "context": "the run context text",
}


def _auth_headers(secret: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {secret}"}


@contextmanager
def _sidecar(monkeypatch, *, local_max_s: str):
    """A freshly-imported app whose OWN configured maximum is `local_max_s`.

    `main.py` reads configuration at import time (that is the startup-refusal
    mechanism), so a test that needs a different ceiling must re-import rather
    than reuse a module cached from another test's environment.
    """
    monkeypatch.setenv("AGENTOS_REQUEST_TIMEOUT_S", local_max_s)
    module = fresh_import("agentos_runtime.main")
    with TestClient(module.app) as client:
        yield module, client


@contextmanager
def _capture_agentos_log():
    """Same technique as test_logging_redaction.py: the `agentos_runtime`
    logger sets `propagate = False` and binds its own handler at import time,
    so only a handler attached directly to it sees these records.
    """
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    logger = logging.getLogger("agentos_runtime")
    logger.addHandler(handler)
    try:
        yield stream
    finally:
        logger.removeHandler(handler)


def _slow_runner(state: dict, *, sleep_s: float):
    """A coordinator that takes `sleep_s` to answer and RECORDS whether it was
    allowed to finish. `ran_to_completion` is the assertion that matters: an
    await that is merely abandoned still runs to completion on the same loop.
    """

    async def run(context_text: str, system_prompt: str) -> AgentRunOutcome:
        state["started"] = True
        try:
            await asyncio.sleep(sleep_s)
        except asyncio.CancelledError:
            state["cancelled"] = True
            raise
        state["ran_to_completion"] = True
        return AgentRunOutcome(completed=True, content="answered after the deadline")

    return run


def _fresh_state() -> dict:
    return {"started": False, "cancelled": False, "ran_to_completion": False, "calls": 0}


def _counting_runner(state: dict):
    async def run(context_text: str, system_prompt: str) -> AgentRunOutcome:
        state["calls"] += 1
        return AgentRunOutcome(completed=True, content="the answer", model="deepseek-chat")

    return run


# ---------------------------------------------------------------------------
# Which deadline wins
# ---------------------------------------------------------------------------


def test_the_callers_deadline_wins_when_it_is_tighter_than_the_sidecars(base_env, monkeypatch):
    """THE DEFECT ITSELF. Node's deadline is 80ms; this sidecar's own ceiling
    is 30s. Before the fix the envelope had nowhere to carry Node's deadline,
    so the run continued for the full local ceiling with no caller left.
    """
    state = _fresh_state()
    with _sidecar(monkeypatch, local_max_s="30") as (module, client):
        monkeypatch.setattr(module, "run_operations_coordinator", _slow_runner(state, sleep_s=3.0))
        started = time.monotonic()
        res = client.post(
            "/v1/agent-run",
            json={**VALID_BODY, "deadlineMs": 80},
            headers=_auth_headers(base_env["shared_secret"]),
        )
        elapsed = time.monotonic() - started

    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "error"
    assert "deadline_exceeded" in body["reason"]
    # Names WHICH bound applied, so an operator reading the log can tell a
    # caller-imposed cut-off from a local-policy one.
    assert "caller_supplied" in body["reason"]
    assert elapsed < 2.0, "the caller's 80ms deadline did not actually fire"
    assert state["ran_to_completion"] is False


def test_the_sidecars_own_maximum_still_wins_when_IT_is_tighter(base_env, monkeypatch):
    """POSITIVE TWIN. A tighter LOCAL value must still win — otherwise "honour
    the caller's deadline" would have quietly become "let the caller set the
    deadline", which is the policy-ceiling widening this fix must not create.
    """
    state = _fresh_state()
    with _sidecar(monkeypatch, local_max_s="0.08") as (module, client):
        monkeypatch.setattr(module, "run_operations_coordinator", _slow_runner(state, sleep_s=3.0))
        started = time.monotonic()
        res = client.post(
            "/v1/agent-run",
            json={**VALID_BODY, "deadlineMs": 30_000},
            headers=_auth_headers(base_env["shared_secret"]),
        )
        elapsed = time.monotonic() - started

    body = res.json()
    assert body["status"] == "error"
    assert "sidecar_local_max" in body["reason"]
    assert elapsed < 2.0
    assert state["ran_to_completion"] is False


def test_an_absurdly_excessive_caller_deadline_is_bounded_by_the_local_maximum(
    base_env, monkeypatch
):
    state = _fresh_state()
    with _sidecar(monkeypatch, local_max_s="0.08") as (module, client):
        monkeypatch.setattr(module, "run_operations_coordinator", _slow_runner(state, sleep_s=3.0))
        started = time.monotonic()
        res = client.post(
            "/v1/agent-run",
            json={**VALID_BODY, "deadlineMs": 10**12},
            headers=_auth_headers(base_env["shared_secret"]),
        )
        elapsed = time.monotonic() - started

    body = res.json()
    assert body["status"] == "error"
    assert "sidecar_local_max" in body["reason"]
    assert elapsed < 2.0


def test_a_missing_deadline_falls_back_to_the_local_maximum(base_env, monkeypatch):
    """Fail SAFE, not fail open: an envelope with no deadline is still bounded
    — by this process's own ceiling, which is never wider than local policy.
    """
    state = _fresh_state()
    with _sidecar(monkeypatch, local_max_s="0.08") as (module, client):
        monkeypatch.setattr(module, "run_operations_coordinator", _slow_runner(state, sleep_s=3.0))
        res = client.post(
            "/v1/agent-run",
            json=VALID_BODY,  # no deadlineMs at all
            headers=_auth_headers(base_env["shared_secret"]),
        )

    body = res.json()
    assert body["status"] == "error"
    assert "sidecar_local_max" in body["reason"]


# ---------------------------------------------------------------------------
# Refusals — each with its positive control
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("expired", [0, -1, -30_000])
def test_an_already_expired_deadline_is_refused_before_any_execution_begins(
    base_env, monkeypatch, expired
):
    """Do not start work that is already over budget. The call counter is the
    proof: a refusal that still ran the model would have spent the tokens the
    refusal exists to save.
    """
    state = _fresh_state()
    with _sidecar(monkeypatch, local_max_s="30") as (module, client):
        monkeypatch.setattr(module, "run_operations_coordinator", _counting_runner(state))
        res = client.post(
            "/v1/agent-run",
            json={**VALID_BODY, "deadlineMs": expired},
            headers=_auth_headers(base_env["shared_secret"]),
        )

    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "error"
    assert body["content"] is None
    assert "caller_deadline_expired" in body["reason"]
    assert state["calls"] == 0


@pytest.mark.parametrize("raw", ["NaN", "Infinity", "-Infinity"])
def test_a_non_finite_deadline_fails_closed_before_any_execution_begins(
    base_env, monkeypatch, raw
):
    """Refused by NAME, not merely refused: `-Infinity` would be labelled
    "expired" by any resolver that checked positivity before finiteness, and
    `NaN` would sail through such a resolver entirely.

    The body is sent as RAW TEXT rather than through the client's `json=`
    helper, and that detail is the point. httpx serializes with
    `allow_nan=False` and refuses to send these values at all — so a test
    written the convenient way measures the CLIENT's refusal and never reaches
    the server (the harness-not-the-system failure of CLAUDE.md Law 11). The
    server side has no such protection: Starlette parses a body with
    `json.loads`, which accepts the bare tokens `NaN`, `Infinity` and
    `-Infinity` happily. Any peer that is not httpx — including a hand-rolled
    client or a proxy that re-serializes — can put one on the wire.
    """
    state = _fresh_state()
    body = json.dumps({k: v for k, v in VALID_BODY.items()})
    body = body[:-1] + f', "deadlineMs": {raw}}}'
    with _sidecar(monkeypatch, local_max_s="30") as (module, client):
        monkeypatch.setattr(module, "run_operations_coordinator", _counting_runner(state))
        res = client.post(
            "/v1/agent-run",
            content=body,
            headers={
                **_auth_headers(base_env["shared_secret"]),
                "content-type": "application/json",
            },
        )

    body = res.json()
    assert body["status"] == "error"
    assert "caller_deadline_not_finite" in body["reason"]
    assert state["calls"] == 0


def test_a_non_numeric_deadline_is_rejected_by_the_envelope_contract(base_env, monkeypatch):
    # The wire contract is the first gate: a value that is not a number at all
    # never reaches the resolver, and its VALUE is never echoed back (main.py's
    # field-names-only validation handler).
    state = _fresh_state()
    with _sidecar(monkeypatch, local_max_s="30") as (module, client):
        monkeypatch.setattr(module, "run_operations_coordinator", _counting_runner(state))
        res = client.post(
            "/v1/agent-run",
            json={**VALID_BODY, "deadlineMs": "not-a-number"},
            headers=_auth_headers(base_env["shared_secret"]),
        )

    assert res.status_code == 422
    assert "deadlineMs" in res.json()["fields"]
    assert "not-a-number" not in res.text
    assert state["calls"] == 0


def test_POSITIVE_CONTROL_a_valid_deadline_still_completes_the_run(base_env, monkeypatch):
    """Without this, every refusal above would pass equally against a route
    that had learned to refuse every request carrying a deadline at all.
    """
    state = _fresh_state()
    with _sidecar(monkeypatch, local_max_s="30") as (module, client):
        monkeypatch.setattr(module, "run_operations_coordinator", _counting_runner(state))
        res = client.post(
            "/v1/agent-run",
            json={**VALID_BODY, "deadlineMs": 20_000},
            headers=_auth_headers(base_env["shared_secret"]),
        )

    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "completed"
    assert body["content"] == "the answer"
    assert state["calls"] == 1


def test_POSITIVE_CONTROL_an_envelope_with_no_deadline_still_completes(base_env, monkeypatch):
    # Control for the fallback test above: the fallback bounds the run, it does
    # not refuse it.
    state = _fresh_state()
    with _sidecar(monkeypatch, local_max_s="30") as (module, client):
        monkeypatch.setattr(module, "run_operations_coordinator", _counting_runner(state))
        res = client.post(
            "/v1/agent-run",
            json=VALID_BODY,
            headers=_auth_headers(base_env["shared_secret"]),
        )

    assert res.json()["status"] == "completed"
    assert state["calls"] == 1


# ---------------------------------------------------------------------------
# Cancellation — the point of the whole fix
# ---------------------------------------------------------------------------


def test_a_deadline_breach_CANCELS_the_execution_rather_than_abandoning_it(
    base_env, monkeypatch
):
    """ABANDONING AN AWAIT IS NOT CANCELLING THE WORK.

    A response returned while the coroutine keeps running on the same event
    loop still burns provider tokens for a caller that is gone — which is the
    defect, not the fix. Two assertions separate the two outcomes:

      (a) the coroutine observed `CancelledError` (it was cancelled, not
          merely left behind), and
      (b) after waiting LONGER than the work would have taken, it still has
          not reached its completion line. If it had merely been abandoned,
          the loop would have finished it during that wait and set the flag.

    The wait happens INSIDE the TestClient block on purpose: the portal's
    event loop is still alive there, so an abandoned coroutine really would
    have had the time and the loop it needed to finish.
    """
    state = _fresh_state()
    with _sidecar(monkeypatch, local_max_s="30") as (module, client):
        monkeypatch.setattr(module, "run_operations_coordinator", _slow_runner(state, sleep_s=0.6))
        res = client.post(
            "/v1/agent-run",
            json={**VALID_BODY, "deadlineMs": 60},
            headers=_auth_headers(base_env["shared_secret"]),
        )
        assert state["started"] is True
        assert state["cancelled"] is True
        assert state["ran_to_completion"] is False
        # Longer than the work itself would have needed, on a live loop.
        time.sleep(1.2)
        assert state["ran_to_completion"] is False

    assert res.json()["status"] == "error"


def test_POSITIVE_CONTROL_the_same_runner_DOES_reach_completion_when_left_alone(
    base_env, monkeypatch
):
    """The control for the cancellation test. Without it, `ran_to_completion
    is False` would pass against a harness in which that flag could never be
    set at all — the vacuous-absence failure of CLAUDE.md Law 19.
    """
    state = _fresh_state()
    with _sidecar(monkeypatch, local_max_s="30") as (module, client):
        monkeypatch.setattr(module, "run_operations_coordinator", _slow_runner(state, sleep_s=0.2))
        res = client.post(
            "/v1/agent-run",
            json={**VALID_BODY, "deadlineMs": 20_000},
            headers=_auth_headers(base_env["shared_secret"]),
        )

    assert res.json()["status"] == "completed"
    assert state["ran_to_completion"] is True
    assert state["cancelled"] is False


# ---------------------------------------------------------------------------
# The surrounding guarantees must survive
# ---------------------------------------------------------------------------


def test_a_deadline_breach_keeps_correlation_and_the_structured_outcome(base_env, monkeypatch):
    """A breach must produce the SAME structured shape every other run failure
    produces — never an unstructured framework exception escaping as a 500.
    """
    state = _fresh_state()
    # ORDER MATTERS, and getting it wrong made this test fail against a working
    # implementation: importing `main` runs `configure_logging()`, which calls
    # `logger.handlers.clear()`. A capture handler attached BEFORE the import is
    # silently discarded, and the test then reports "no correlated log line"
    # about a service that logged one perfectly well.
    with _sidecar(monkeypatch, local_max_s="30") as (module, client):
        with _capture_agentos_log() as stream:
            monkeypatch.setattr(
                module, "run_operations_coordinator", _slow_runner(state, sleep_s=3.0)
            )
            res = client.post(
                "/v1/agent-run",
                json={**VALID_BODY, "correlationId": "corr-breach-42", "deadlineMs": 60},
                headers=_auth_headers(base_env["shared_secret"]),
            )

    assert res.status_code == 200
    # The declared response schema, exactly — pydantic would refuse to
    # serialize anything else, and this pins that it still applies on this path.
    assert set(res.json().keys()) == {"status", "content", "model", "usage", "reason"}

    lines = [line for line in stream.getvalue().strip().splitlines() if line]
    events = [json.loads(line) for line in lines]
    breach = [e for e in events if e.get("correlationId") == "corr-breach-42"]
    assert breach, "the breach emitted no correlated log line"
    assert breach[-1]["status"] == "error"
    assert "deadline_exceeded" in breach[-1]["detail"]
    # Redaction still holds on this new path: the run context never reaches a log.
    assert VALID_BODY["context"] not in stream.getvalue()


def test_a_deadline_refusal_is_still_refused_when_the_allowlist_would_refuse_first(
    base_env, monkeypatch
):
    """ORDER OF GATES. The tenant/template/exposure allowlist stays the FIRST
    gate: a request that is both ineligible and past its deadline must be
    refused as ineligible (403), never quietly reclassified as a timeout.
    """
    state = _fresh_state()
    with _sidecar(monkeypatch, local_max_s="30") as (module, client):
        monkeypatch.setattr(module, "run_operations_coordinator", _counting_runner(state))
        res = client.post(
            "/v1/agent-run",
            json={**VALID_BODY, "tenantId": "some-other-tenant", "deadlineMs": -1},
            headers=_auth_headers(base_env["shared_secret"]),
        )

    assert res.status_code == 403
    assert "tenant_refused" in res.json()["detail"]
    assert state["calls"] == 0
