"""Shared-secret authentication for the Node -> sidecar boundary.

Verified against current FastAPI docs (fastapi.tiangolo.com/reference/security,
2026-08): `HTTPBearer` + `Depends` is the current, documented pattern for
extracting an `Authorization: Bearer <token>` header and failing with 401
before the endpoint body runs. This dependency is wired into the
`/v1/agent-run` route so an invalid or missing secret is rejected BEFORE any
Agno logic is touched, per the architecture ruling's "authenticated
server-to-server calls" requirement.

This is deliberately NOT the same mechanism as AgentOS's own
`authorization=True` / `authorization_config` (JWT-based, guards AgentOS's own
mounted control-plane routes). Node holds a flat shared secret, not a JWT, so
this route gets its own, simpler dependency.
"""

from __future__ import annotations

import hmac

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from agentos_runtime.settings import Settings

_bearer_scheme = HTTPBearer(auto_error=False)


def constant_time_equals(a: str, b: str) -> bool:
    """Never a plain `==` on a secret — timing differences on a bearer
    comparison are a real side channel, however small the practical risk here.
    """
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def make_verify_shared_secret(settings: Settings):
    """Returns a FastAPI dependency closed over `settings`, so the secret is
    read once at startup (settings.py) and never re-read per request.
    """

    async def verify_shared_secret(
        credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
    ) -> None:
        if credentials is None or credentials.scheme.lower() != "bearer":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="missing or malformed Authorization header",
                headers={"WWW-Authenticate": "Bearer"},
            )
        if not constant_time_equals(credentials.credentials, settings.shared_secret):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid shared secret",
                headers={"WWW-Authenticate": "Bearer"},
            )

    return verify_shared_secret
