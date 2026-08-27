"""The server-side AgentOS allowlist.

This is INDEPENDENT of, and in addition to, the allowlist enforced by
services/isola-runtime/src/agentos-allowlist.ts. The architecture ruling
(dec-agentos-private-python-service-behind-node-isola-runtime-2026-08-22,
Option A) requires the sidecar to make its own decision rather than trust
Node's — "server-side selection" means this file, not a comment saying Node
already checked. The three constants below are IDENTICAL in value to the
Node-side constants; they are declared twice on purpose (two independent
enforcement points), not imported across the process boundary.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Exposure = Literal["INTERNAL", "PUBLIC"]

AGENTOS_ALLOWED_TENANT = "8D3dp3z"
AGENTOS_ALLOWED_TEMPLATE_ID = "epic-staff-operations-coordinator@v1"
AGENTOS_ALLOWED_EXPOSURE: Exposure = "INTERNAL"


@dataclass(frozen=True)
class EligibilityResult:
    eligible: bool
    reason: str | None = None


def evaluate_eligibility(
    *, tenant_id: str | None, template_id: str | None, exposure: str | None
) -> EligibilityResult:
    """Fail closed on anything that is not an EXACT match.

    Unlike the Node-side check, this function does not special-case "not the
    gated template" as a distinct outcome — from the sidecar's point of view
    EVERY request that reaches it is, by construction, a request for the one
    agent this process runs. Any request whose declared tenant, template id
    or exposure is not the exact allowlisted value is refused; there is no
    other agent here to fall through to.
    """
    if template_id != AGENTOS_ALLOWED_TEMPLATE_ID:
        return EligibilityResult(
            eligible=False,
            reason=(
                f"agentos_template_refused: this sidecar only serves "
                f"{AGENTOS_ALLOWED_TEMPLATE_ID}, got {template_id!r}"
            ),
        )
    if tenant_id != AGENTOS_ALLOWED_TENANT:
        return EligibilityResult(
            eligible=False,
            reason=(
                f"agentos_tenant_refused: this sidecar only serves tenant "
                f"{AGENTOS_ALLOWED_TENANT}, got {tenant_id!r}"
            ),
        )
    if exposure != AGENTOS_ALLOWED_EXPOSURE:
        return EligibilityResult(
            eligible=False,
            reason=(
                f"agentos_exposure_refused: this sidecar only serves exposure "
                f"{AGENTOS_ALLOWED_EXPOSURE}, got {exposure!r}"
            ),
        )
    return EligibilityResult(eligible=True)
