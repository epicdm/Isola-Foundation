"""Configuration, loaded and validated once at process start.

Mirrors the `_FILE` convention already used by services/isola-runtime's
entrypoint.sh (`FOO_FILE=/run/secrets/foo` -> `FOO=<contents>`), so the same
Swarm-secret packaging story covers both services without inventing a second
mechanism. Unlike the Node service (which does the `_FILE` -> value expansion
in a shell shim outside the app's module graph), this module reads the file
itself: Python has no equivalent constraint pinning filesystem access to one
module, and a settings loader reading its own secret file at startup is the
idiomatic FastAPI/pydantic-settings shape.

FAIL CLOSED ON BOOT. `load_settings()` raises `ConfigError` — never returns a
settings object with an invented or partially-missing mandatory value — for:
  - the shared secret authenticating Node's calls to this service
  - the JWT verification key backing AgentOS's own `authorization_config`
  - a malformed or empty AgentOS allowlist constant (defensive self-check)

The one deliberate exception, mirroring services/isola-runtime/src/config.ts's
own `bootWarnings` (MODEL_API_KEY unset is a WARNING there, not a boot
refusal), is the upstream model credential: this service starts without one
and fails closed, per-request, with a clear `dependency_unavailable` error —
see agent.py. Phase A ships with no live model credential available in this
sandbox; that is an explicit, documented Phase B TODO, not a silent gap.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from agentos_runtime.allowlist import (
    AGENTOS_ALLOWED_EXPOSURE,
    AGENTOS_ALLOWED_TEMPLATE_ID,
    AGENTOS_ALLOWED_TENANT,
)


class ConfigError(RuntimeError):
    """Raised at import/startup time. There is no request-time recovery from this."""


def _read_file_env(env: dict[str, str], name: str) -> str | None:
    """`NAME` directly, or `NAME_FILE` read from disk. Trailing newlines stripped —
    the same trap services/isola-runtime's entrypoint.sh documents: a bearer
    token with a trailing newline fails authentication in a way that is very
    hard to see in a log.
    """
    direct = env.get(name)
    if direct is not None and direct.strip() != "":
        return direct.strip()

    path_str = env.get(f"{name}_FILE")
    if path_str is None or path_str.strip() == "":
        return None

    path = Path(path_str.strip())
    try:
        content = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(
            f"{name}_FILE points at {path_str}, which is not readable: {exc}. "
            "Refusing to start with a silently absent credential."
        ) from exc

    value = content.strip()
    if value == "":
        raise ConfigError(f"{name}_FILE at {path_str} is empty. Refusing to start.")
    return value


@dataclass(frozen=True)
class Settings:
    # Authenticates services/isola-runtime -> this sidecar. Same VALUE as
    # Node's AGENTOS_SHARED_SECRET (via AGENTOS_SHARED_SECRET_FILE there too).
    shared_secret: str
    # Backs AgentOS's own `authorization_config` (its control-plane routes,
    # separate from our custom /v1/agent-run route's shared-secret check).
    jwt_verification_key: str
    # THE TENANT THIS SIDECAR SERVES — operator configuration, the authority.
    # Mirrors the Node side's AGENTOS_TENANT_ID: the envelope's `tenantId` must
    # MATCH this, and may never select a different one. Required, so the
    # sidecar can never fall back to comparing against a compiled-in constant.
    tenant_id: str
    # Model access. `None` is an ACCEPTED state at boot (see module docstring)
    # — every /v1/agent-run request fails closed with a clear error instead.
    model_api_key: str | None
    model_base_url: str
    model_id: str
    request_timeout_s: float
    host: str
    port: int


DEFAULT_MODEL_BASE_URL = "https://api.deepseek.com"
# Same model id services/isola-runtime's registry.ts declares for this exact
# template (`model: "deepseek-chat"`) — same provider, same brain, a
# separately-pinned, separately file-backed credential.
DEFAULT_MODEL_ID = "deepseek-chat"
DEFAULT_REQUEST_TIMEOUT_S = 55.0
# Container-internal only. Never 0.0.0.0 by policy decision here, even though
# the binding itself cannot enforce network isolation — that is the Compose /
# stack file's job in Phase B. Deploy-time misconfiguration of the container
# network is out of scope for this process, but this process never ASSUMES
# it is reachable from outside one either (no CORS, no public-facing default).
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8700


def load_settings(env: dict[str, str] | None = None) -> Settings:
    e = dict(os.environ if env is None else env)

    shared_secret = _read_file_env(e, "AGENTOS_SHARED_SECRET")
    if shared_secret is None:
        raise ConfigError(
            "AGENTOS_SHARED_SECRET (or AGENTOS_SHARED_SECRET_FILE) is unset. "
            "This sidecar cannot authenticate its caller without it, and it will "
            "not start unauthenticated — refusing rather than serving every request 401."
        )

    jwt_verification_key = _read_file_env(e, "AGENTOS_JWT_VERIFICATION_KEY")
    if jwt_verification_key is None:
        raise ConfigError(
            "AGENTOS_JWT_VERIFICATION_KEY (or AGENTOS_JWT_VERIFICATION_KEY_FILE) is "
            "unset. AgentOS is required to run with authorization=True "
            "(dec-agentos-private-python-service-behind-node-isola-runtime-2026-08-22); "
            "starting it without a verification key would mean shipping that flag "
            "with nothing behind it."
        )

    tenant_id = _read_file_env(e, "AGENTOS_TENANT_ID")
    if tenant_id is None:
        raise ConfigError(
            "AGENTOS_TENANT_ID is unset. It is the tenant this sidecar serves, and it must "
            "be chosen by the operator: without it the only remaining way to pick a tenant "
            "would be the request envelope, which is exactly the client-side selection this "
            "setting exists to remove. Expected value: the AGENTOS_ALLOWED_TENANT constant "
            "in allowlist.py."
        )

    # Defensive self-check on the hardcoded allowlist constants (see
    # allowlist.py's own docstring on why these are literals, not env-derived).
    # This can only fail if a future edit accidentally empties one of them —
    # but a fail-closed rule needs a mechanism to fail with, and this is it.
    for name, value in (
        ("AGENTOS_ALLOWED_TENANT", AGENTOS_ALLOWED_TENANT),
        ("AGENTOS_ALLOWED_TEMPLATE_ID", AGENTOS_ALLOWED_TEMPLATE_ID),
        ("AGENTOS_ALLOWED_EXPOSURE", AGENTOS_ALLOWED_EXPOSURE),
    ):
        if not value:
            raise ConfigError(f"allowlist constant {name} is empty; refusing to start.")

    model_api_key = _read_file_env(e, "AGENTOS_MODEL_API_KEY")

    timeout_raw = e.get("AGENTOS_REQUEST_TIMEOUT_S")
    try:
        request_timeout_s = (
            float(timeout_raw) if timeout_raw not in (None, "") else DEFAULT_REQUEST_TIMEOUT_S
        )
    except ValueError as exc:
        raise ConfigError(
            f"AGENTOS_REQUEST_TIMEOUT_S={timeout_raw!r} is not a number."
        ) from exc
    if request_timeout_s <= 0:
        raise ConfigError("AGENTOS_REQUEST_TIMEOUT_S must be a positive number.")

    port_raw = e.get("AGENTOS_PORT")
    try:
        port = int(port_raw) if port_raw not in (None, "") else DEFAULT_PORT
    except ValueError as exc:
        raise ConfigError(f"AGENTOS_PORT={port_raw!r} is not an integer.") from exc

    return Settings(
        shared_secret=shared_secret,
        jwt_verification_key=jwt_verification_key,
        tenant_id=tenant_id,
        model_api_key=model_api_key,
        model_base_url=(e.get("AGENTOS_MODEL_BASE_URL") or DEFAULT_MODEL_BASE_URL).rstrip("/"),
        model_id=e.get("AGENTOS_MODEL_ID") or DEFAULT_MODEL_ID,
        request_timeout_s=request_timeout_s,
        host=e.get("AGENTOS_HOST") or DEFAULT_HOST,
        port=port,
    )
