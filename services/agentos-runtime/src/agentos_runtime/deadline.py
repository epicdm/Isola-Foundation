"""Which deadline this sidecar actually enforces for one request.

Closes def-agentos-sidecar-ignores-caller-deadline-2026-08-27.

THE DEFECT. agent.py ran
`asyncio.wait_for(agent.arun(...), timeout=settings.request_timeout_s)` using
ONLY this process's own configured ceiling, and the wire contract carried no
caller deadline at all. Node computes its own, tighter deadline
(`Math.min(request.timeoutMs, options.timeoutMs)` in
agentos-execution-provider.ts) and abandons the call when it fires — but
abandoning an HTTP call does not stop the work behind it. The sidecar kept
executing, and kept spending provider tokens, for a caller that was gone.

WHY REMAINING MILLISECONDS AND NOT AN ABSOLUTE DEADLINE. The two containers
have no guaranteed clock sync. An epoch timestamp would be interpreted against
THIS process's clock, so a few seconds of skew silently turns a 30s budget
into an already-expired one, or into an unbounded one — and it does it
quietly, which is the dangerous kind of wrong (CLAUDE.md Law 12). A duration
means the same thing on both sides of the hop with no shared reference at all.

WHY THE LOCAL MAXIMUM STILL WINS WHEN IT IS TIGHTER. Honouring the caller's
deadline must not become letting the caller SET the deadline. The operator's
AGENTOS_REQUEST_TIMEOUT_S is a policy ceiling on this process; a caller can
only ever ask for less. That is also why an absurdly large value needs no
special case: `min()` against the local ceiling already bounds it.

WHY FINITENESS IS CHECKED BEFORE POSITIVITY. `float("nan")` parses, and every
comparison against NaN is false, so `nan <= 0` is false and NaN sails straight
through a positivity check into `asyncio.wait_for`, where this runtime raises
`ValueError: cannot convert float NaN to integer` from inside the event loop —
an unstructured framework crash, which is exactly what a deadline exists to
replace with a structured outcome. That is not theoretical: it was found by
adversarial review of settings.py's own timeout parsing and fixed there
(commit 47288bf). This module reproduces that ordering deliberately. `-inf`
matters for the mirror-image reason: it IS `<= 0`, so a positivity-first
resolver would label a malformed value "expired" and hide what really arrived.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# Which of the two bounds actually applied. Carried into the failure reason so
# an operator reading a log can tell a caller-imposed cut-off from a local
# policy one — the two have completely different remedies.
CALLER_SUPPLIED = "caller_supplied"
SIDECAR_LOCAL_MAX = "sidecar_local_max"


@dataclass(frozen=True)
class DeadlineResolution:
    """Exactly two terminal shapes, like AgentRunOutcome: either a usable
    deadline in seconds, or a named refusal. `effective_s` and `refusal` are
    never both set and never both absent.
    """

    effective_s: float | None
    bound: str | None
    refusal: str | None


def resolve_effective_deadline(
    *,
    caller_deadline_ms: float | None,
    local_max_s: float,
) -> DeadlineResolution:
    """The EARLIER of this process's own configured maximum and the caller's
    remaining budget — or a refusal, when the caller's value cannot be used.

    `caller_deadline_ms` is REMAINING MILLISECONDS as measured by the caller at
    the moment it transmitted, never an absolute timestamp (see module
    docstring). `None` means the envelope carried none, which is bounded by
    the local maximum rather than refused: that is fail-safe, because the local
    maximum is never wider than local policy.
    """
    # Defensive: settings.py refuses to BOOT with a non-finite or non-positive
    # AGENTOS_REQUEST_TIMEOUT_S, so this can only fire if a future edit removes
    # that guard. A fail-closed rule needs a mechanism to fail with (Law 26's
    # corollary), and "ran with no usable ceiling at all" is the one outcome
    # that must never be reachable.
    if not math.isfinite(local_max_s) or local_max_s <= 0:
        return DeadlineResolution(
            effective_s=None, bound=None, refusal="sidecar_local_max_unusable"
        )

    if caller_deadline_ms is None:
        return DeadlineResolution(
            effective_s=local_max_s, bound=SIDECAR_LOCAL_MAX, refusal=None
        )

    # FINITENESS FIRST — see the module docstring. Reordering these two checks
    # reintroduces a bug this repo has already paid for once.
    if not math.isfinite(caller_deadline_ms):
        return DeadlineResolution(
            effective_s=None, bound=None, refusal="caller_deadline_not_finite"
        )

    if caller_deadline_ms <= 0:
        # ALREADY OVER BUDGET. Refused before any model execution begins:
        # starting a run whose deadline has passed spends provider tokens on
        # an answer that can never be delivered.
        return DeadlineResolution(
            effective_s=None, bound=None, refusal="caller_deadline_expired"
        )

    caller_s = caller_deadline_ms / 1000.0
    if caller_s < local_max_s:
        return DeadlineResolution(effective_s=caller_s, bound=CALLER_SUPPLIED, refusal=None)
    # Equal counts as the local bound: on a tie neither is looser, and naming
    # the local one keeps the attribution in the failure reason honest.
    return DeadlineResolution(effective_s=local_max_s, bound=SIDECAR_LOCAL_MAX, refusal=None)
