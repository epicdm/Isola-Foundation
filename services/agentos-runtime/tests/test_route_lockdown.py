"""`/v1/agent-run` must be the ONLY model-execution entrance.

Agno's `AgentOS.get_app()` unconditionally registers built-in routers,
including `POST /agents/{agent_id}/runs`, `.../runs/{run_id}/continue` and
`POST /teams/{team_id}/runs` — fully-functional execution entrances that
bypass the shared-secret check, the tenant/template/exposure allowlist,
correlation logging and the deadline. `enforce_single_execution_entrance`
removes them structurally before the app serves.

These tests enumerate the ACTUAL registered routes rather than trusting the
lockdown to have worked, and include a SABOTAGE CONTROL proving the
enumeration can actually detect a violation (without it, the assertions could
pass vacuously against a scan that never matches anything).
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# NOTE: `agentos_runtime.main` cannot be imported at module scope — it reads
# its configuration at IMPORT time and refuses without it, which is the
# startup-refusal mechanism itself. Every use below goes through the
# `app_module` fixture (or imports after `base_env` has set the environment).

# Route shapes that can invoke a model, or resume/fork one that did.
EXECUTION_ROUTE_MARKERS = (
    "/runs",
    "/continue",
    "/agents",
    "/teams",
    "/workflows",
    "/sessions",
    "/schedules",
    "/approvals",
    "/evals",
)


def registered_paths(app, app_module) -> set[str]:
    """Uses the app's OWN flattening enumerator — FastAPI 0.141.1 stores
    included routers as lazy wrappers, so a top-level-only scan would be blind
    to every nested route.
    """
    return app_module.all_registered_paths(app)


def test_only_allowlisted_paths_are_registered(app_module):
    paths = registered_paths(app_module.app, app_module)
    assert paths == set(app_module.ALLOWED_PATHS), f"unexpected surface: {sorted(paths - set(app_module.ALLOWED_PATHS))}"


def test_no_registered_route_can_invoke_a_model(app_module):
    offenders = [
        p
        for p in registered_paths(app_module.app, app_module)
        if any(marker in p for marker in EXECUTION_ROUTE_MARKERS)
    ]
    assert offenders == [], f"alternate execution routes still registered: {offenders}"


def test_the_one_execution_entrance_is_still_registered(app_module):
    # Positive control: the lockdown must not have removed everything.
    assert "/v1/agent-run" in registered_paths(app_module.app, app_module)
    assert "/healthz" in registered_paths(app_module.app, app_module)


def test_sabotage_control_the_scan_detects_an_added_execution_route(app_module):
    """THE CONTROL THAT MAKES THE TESTS ABOVE MEANINGFUL.

    Register a synthetic second execution route and assert the same
    enumeration FAILS. Without this, a scan that silently matched nothing
    would report a locked-down surface forever.
    """
    app = app_module.app

    @app.post("/agents/{agent_id}/runs")
    async def _synthetic_execution_route(agent_id: str) -> dict[str, str]:  # pragma: no cover
        return {"agent_id": agent_id}

    try:
        paths = registered_paths(app, app_module)
        assert paths != set(app_module.ALLOWED_PATHS), "the enumeration failed to notice a new route"
        offenders = [
            p for p in paths if any(marker in p for marker in EXECUTION_ROUTE_MARKERS)
        ]
        assert offenders, "the execution-route scan failed to notice an execution route"
    finally:
        # Restore the locked-down surface for any later test in this module.
        app_module.enforce_single_execution_entrance(app)

    assert registered_paths(app, app_module) == set(app_module.ALLOWED_PATHS)


@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", "/agents/some-agent/runs"),
        ("POST", "/agents/some-agent/runs/some-run/continue"),
        ("POST", "/teams/some-team/runs"),
        ("POST", "/workflows/some-workflow/runs"),
        ("GET", "/sessions"),
        ("GET", "/agents"),
        ("GET", "/config"),
        ("GET", "/info"),
        ("GET", "/metrics"),
        ("GET", "/memories"),
        ("GET", "/knowledge"),
        ("GET", "/traces"),
        ("GET", "/evals"),
        ("GET", "/schedules"),
        ("GET", "/approvals"),
        ("GET", "/service-accounts"),
        ("GET", "/components"),
        ("GET", "/"),
        ("GET", "/docs"),
        ("GET", "/openapi.json"),
        ("GET", "/health"),
    ],
)
def test_every_alternate_route_category_is_gone(client, app_module, method, path):
    """Probe each discovered Agno route category over HTTP AND structurally.

    Two assertions, because either alone would be weak:
      - it must not EXECUTE (never a 2xx), and
      - the path must be genuinely ABSENT from the registered set, not merely
        guarded. That second one is the property the PM required: the control
        must not depend on possession of a credential.

    The HTTP status here is 401 rather than 404 only because Agno's blanket
    auth middleware runs BEFORE routing and answers first. Removing that
    confound is what `test_lockdown_removes_the_route_itself_not_just_access`
    below does, on an app with no middleware in the way.
    """
    res = client.request(method, path)
    assert res.status_code >= 400, f"{method} {path} EXECUTED ({res.status_code})"
    assert path not in registered_paths(app_module.app, app_module)


def test_execution_probe_with_a_valid_shared_secret_never_executes(client, base_env):
    # Possession of the shared secret must not open an alternate entrance.
    res = client.post(
        "/agents/some-agent/runs",
        json={"message": "run something"},
        headers={"Authorization": f"Bearer {base_env['shared_secret']}"},
    )
    assert res.status_code >= 400
    assert "run_id" not in res.text and "content" not in res.text


def test_lockdown_removes_the_route_itself_not_just_access(app_module):
    """THE DECISIVE ONE: no middleware in the way, so the 404 can only mean the
    route is genuinely absent — not that a credential check answered first.

    This is the property the PM required: the control must be structural, not
    dependent on network position or on holding a JWT.
    """
    app = FastAPI()

    @app.post("/agents/{agent_id}/runs")
    async def _runs(agent_id: str) -> dict[str, str]:  # pragma: no cover
        return {"agent_id": agent_id}

    # POSITIVE CONTROL: it really does execute before the lockdown. Without
    # this, the 404 afterwards could just mean the route never worked.
    with TestClient(app) as c:
        assert c.post("/agents/x/runs").status_code == 200

    app_module.enforce_single_execution_entrance(app)

    with TestClient(app) as c:
        assert c.post("/agents/x/runs").status_code == 404


def test_lockdown_is_idempotent_and_reports_what_it_removed(app_module):
    # Applied to a fresh app with a mix of allowed and disallowed routes.
    app = FastAPI()

    @app.get("/healthz")
    async def _health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/agents/{agent_id}/runs")
    async def _runs(agent_id: str) -> dict[str, str]:  # pragma: no cover
        return {"agent_id": agent_id}

    enforce = app_module.enforce_single_execution_entrance
    removed = enforce(app)
    assert "/agents/{agent_id}/runs" in removed
    assert registered_paths(app, app_module) == {"/healthz"}

    # Second application removes nothing further.
    assert enforce(app) == []
    assert registered_paths(app, app_module) == {"/healthz"}

    with TestClient(app) as c:
        assert c.post("/agents/x/runs").status_code == 404
        assert c.get("/healthz").status_code == 200
