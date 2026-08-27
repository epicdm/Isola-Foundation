"""The private AgentOS sidecar's ASGI entrypoint.

Boot sequence, and why the order matters:
  1. `load_settings()` — raises `ConfigError` and crashes the process before a
     single route is registered if the shared secret, the JWT verification
     key, or an allowlist constant is missing. This IS the "startup refusal"
     mechanism the architecture ruling requires: importing this module with
     required hardening absent never reaches step 2.
  2. A plain `FastAPI()` — OUR `base_app`, with OUR one custom route
     (`/v1/agent-run`) added directly to it, authenticated by OUR shared-secret
     dependency. No CORS middleware is added (default: none), and the app is
     never told to bind 0.0.0.0 — see settings.py's DEFAULT_HOST.
  3. `AgentOS(..., base_app=app, on_route_conflict="error", authorization=True,
     authorization_config=..., telemetry=False)` — verified against Context7's
     current agno docs (2026-08-27): `on_route_conflict` takes
     "preserve_agentos" | "preserve_base_app" | "error" (confirmed on the
     installed agno==3.0.1 signature too); `authorization`/`authorization_config`
     gate AgentOS's OWN mounted control-plane routes (session/agent
     introspection) via JWT — a SEPARATE mechanism from our shared-secret
     dependency on `/v1/agent-run`, which Node calls with a flat bearer token,
     not a JWT. `telemetry=False` is a real, current, per-instance AgentOS
     parameter (confirmed: "telemetry can be disabled on a per-instance basis
     for agents, teams, workflows, evals, and AgentOS" — note `AGNO_TELEMETRY`
     env var does NOT cover AgentOS, so this must be the explicit kwarg).
  4. `app = agent_os.get_app()` — the final ASGI app uvicorn serves.
"""

from __future__ import annotations

import time

from fastapi import Depends, FastAPI, HTTPException, Request, status as http_status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from agentos_runtime.agent import build_agent, make_run_operations_coordinator
from agentos_runtime.allowlist import evaluate_eligibility
from agentos_runtime.logging_utils import configure_logging, log_run_event
from agentos_runtime.schemas import AgentRunEnvelope, AgentRunResponse, AgentRunUsage
from agentos_runtime.security import make_verify_shared_secret
from agentos_runtime.settings import load_settings

configure_logging()

# STEP 1 — fail closed before anything else exists.
settings = load_settings()

# STEP 2 — our base_app and our one custom, shared-secret-authenticated route.
base_app = FastAPI(title="isola-agentos-sidecar", docs_url=None, redoc_url=None)

verify_shared_secret = make_verify_shared_secret(settings)
run_operations_coordinator = make_run_operations_coordinator(settings)


# No custom /health route here: AgentOS's own `get_app()` already registers
# one (`get_health_router(health_endpoint="/health")`), and `/health` is one
# of its OWN DEFAULT excluded_route_paths (agno.os.middleware.jwt
# .AuthMiddleware._get_default_excluded_routes()) — unauthenticated, reveals
# nothing. Defining a second one here would collide with `on_route_conflict=
# "error"` (the deliberately strict setting this service uses), so the
# container healthcheck / orchestrator liveness probe below targets AgentOS's
# built-in `/health` instead of a route this file owns.


@base_app.exception_handler(RequestValidationError)
async def _validation_error_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    """FastAPI's DEFAULT 422 body echoes the rejected input back to the caller.

    That is a redaction hole on this route specifically: the envelope carries
    `context` (the whole run context) and `extra="forbid"` means a request
    carrying a credential-shaped extra field is rejected BY NAME AND VALUE —
    so the default handler would write both into an HTTP response and, via
    any upstream access log, potentially into a log line too. Enumerate the
    SHAPES, not just the copies (CLAUDE.md Law 26's corollary): a secret can
    sit in a field value just as easily as in a query string.

    This handler emits FIELD NAMES ONLY. `exc.errors()` entries also carry
    `input` (the submitted value) and `msg`/`ctx` (which can quote it); none
    of those are read here — only `loc`.
    """
    fields = sorted(
        {
            ".".join(str(part) for part in error.get("loc", ()) if part != "body")
            for error in exc.errors()
        }
        - {""}
    )
    return JSONResponse(
        # Literal 422 rather than the starlette constant: `HTTP_422_UNPROCESSABLE_ENTITY`
        # is deprecated in the pinned starlette in favour of
        # `HTTP_422_UNPROCESSABLE_CONTENT`, and naming either one couples this
        # handler to a rename that does not change the status code.
        status_code=422,
        content={
            "detail": "request body failed validation",
            "fields": fields,
        },
    )


@base_app.post("/v1/agent-run", response_model=AgentRunResponse)
async def agent_run(
    envelope: AgentRunEnvelope,
    _auth: None = Depends(verify_shared_secret),
) -> AgentRunResponse:
    started = time.monotonic()

    # SERVER-SIDE ALLOWLIST — independent of, and in addition to, Node's own
    # check. Refused BEFORE any Agno logic runs.
    eligibility = evaluate_eligibility(
        tenant_id=envelope.tenantId,
        template_id=envelope.templateId,
        exposure=envelope.exposure,
        configured_tenant_id=settings.tenant_id,
    )
    if not eligibility.eligible:
        duration_ms = (time.monotonic() - started) * 1000
        log_run_event(
            correlation_id=envelope.correlationId,
            template_id=envelope.templateId,
            status="refused",
            duration_ms=duration_ms,
            detail=eligibility.reason,
        )
        raise HTTPException(status_code=http_status.HTTP_403_FORBIDDEN, detail=eligibility.reason)

    outcome = await run_operations_coordinator(envelope.context)
    duration_ms = (time.monotonic() - started) * 1000

    if not outcome.completed:
        log_run_event(
            correlation_id=envelope.correlationId,
            template_id=envelope.templateId,
            status="error",
            duration_ms=duration_ms,
            detail=outcome.failure_reason,
        )
        return AgentRunResponse(status="error", reason=outcome.failure_reason)

    log_run_event(
        correlation_id=envelope.correlationId,
        template_id=envelope.templateId,
        status="completed",
        duration_ms=duration_ms,
    )
    return AgentRunResponse(
        status="completed",
        content=outcome.content,
        model=outcome.model,
        usage=AgentRunUsage(
            promptTokens=outcome.prompt_tokens,
            completionTokens=outcome.completion_tokens,
            cachedPromptTokens=outcome.cached_prompt_tokens,
        ),
    )


def _mount_agent_os(app: FastAPI) -> FastAPI:
    from agno.os import AgentOS
    from agno.os.config import AuthorizationConfig

    # Registered with AgentOS's own control-plane (session/agent listing) so
    # it has something to introspect. This does NOT change how
    # `/v1/agent-run` above answers a request — that route calls
    # `run_operations_coordinator` directly and never goes through AgentOS's
    # own HTTP surface.
    agent = build_agent(settings)

    agent_os = AgentOS(
        id="isola-agentos-sidecar",
        description="Private AgentOS sidecar for epic-staff-operations-coordinator@v1",
        agents=[agent],
        base_app=app,
        on_route_conflict="error",
        authorization=True,
        authorization_config=AuthorizationConfig(
            verification_keys=[settings.jwt_verification_key],
            algorithm="HS256",
        ),
        telemetry=False,
    )
    final_app = agent_os.get_app()
    _exempt_self_authenticating_route(final_app, "/v1/agent-run")
    return final_app


def _exempt_self_authenticating_route(app: FastAPI, path: str) -> None:
    """`/v1/agent-run` authenticates itself (`verify_shared_secret`, a FastAPI
    dependency) — the same rationale AgentOS documents for excluding an
    interface that "verifies the authenticity of their own inbound requests"
    (agno/os/app.py) from its central JWT layer. AgentOS's constructor has no
    parameter accepting a caller-supplied `excluded_route_paths` for a plain
    `base_app` route (it derives that list only from `self.interfaces` /
    MCP-auth providers — see agno/os/app.py), so this appends to the ALREADY
    -INSTALLED `AuthMiddleware`'s own `excluded_route_paths` list in place, on
    the one instance AgentOS installed. Defensive by construction: if a future
    agno release renames the attribute, this silently does nothing rather than
    raising an AttributeError that would crash startup — the route then keeps
    its OWN shared-secret dependency as its only gate, which is a strictly
    SMALLER problem than the reverse (accidentally exempting a route that
    should be JWT-gated).
    """
    for entry in getattr(app, "user_middleware", []):
        if getattr(entry.cls, "__name__", "") != "AuthMiddleware":
            continue
        kwargs = getattr(entry, "kwargs", None) or getattr(entry, "options", None)
        if not isinstance(kwargs, dict):
            continue
        excluded = kwargs.get("excluded_route_paths")
        if excluded is None:
            # AgentOS passed `excluded_route_paths=None` (no interfaces / no MCP
            # auth configured — see agno/os/app.py), so `AuthMiddleware.__init__`
            # would fall back to its OWN `_get_default_excluded_routes()`. That
            # method takes no argument other than `self` and reads no instance
            # state (verified by reading agno==3.0.1's source), so calling it
            # unbound reproduces the exact same default list, which this then
            # extends — never replaces — with our one additional path.
            try:
                excluded = entry.cls._get_default_excluded_routes(None)
            except Exception:
                # Fails closed: `/v1/agent-run` still has ITS OWN shared-secret
                # dependency as a gate even if this best-effort exemption can't
                # be applied on some future agno release.
                return
            kwargs["excluded_route_paths"] = excluded
        if isinstance(excluded, list) and path not in excluded:
            excluded.append(path)


# STEP 3 + 4.
app = _mount_agent_os(base_app)
