"""The caller-deadline resolver, tested as a pure function.

Closes def-agentos-sidecar-ignores-caller-deadline-2026-08-27 at the unit
level; tests/test_caller_deadline_route.py closes it at the route level (Law
20: test the PATH, not only the pieces — so both layers exist).

THE DEFECT THIS PROTECTS AGAINST. agent.py ran
`asyncio.wait_for(agent.arun(...), timeout=settings.request_timeout_s)` using
ONLY this process's own configured deadline, and the envelope carried no
caller deadline at all. When Node's deadline was the tighter one, Node gave up
at (say) 1.2s while this sidecar kept executing for the full 55s — still
consuming provider tokens for a caller that was already gone.

The finiteness discipline below is deliberately the SAME shape settings.py
already uses for AGENTOS_REQUEST_TIMEOUT_S, and for the same measured reason:
`float("nan")` parses cleanly and EVERY comparison against NaN is false, so a
positivity check (`<= 0`) cannot see it. Check finiteness BEFORE positivity.
That exact bug was found and fixed once in settings.py; the assertions here
pin the ORDER so its shape cannot be reintroduced on this path.
"""

from __future__ import annotations

import pytest

from agentos_runtime.deadline import resolve_effective_deadline

LOCAL_MAX_S = 55.0


def test_missing_caller_deadline_falls_back_to_the_local_maximum():
    # Safely bounded, not fail-open: the fallback is this process's OWN
    # configured ceiling, which can never be wider than the local policy.
    resolution = resolve_effective_deadline(caller_deadline_ms=None, local_max_s=LOCAL_MAX_S)
    assert resolution.refusal is None
    assert resolution.effective_s == LOCAL_MAX_S
    assert resolution.bound == "sidecar_local_max"


def test_caller_deadline_wins_when_it_is_the_tighter_one():
    resolution = resolve_effective_deadline(caller_deadline_ms=1200, local_max_s=LOCAL_MAX_S)
    assert resolution.refusal is None
    assert resolution.effective_s == pytest.approx(1.2)
    assert resolution.bound == "caller_supplied"


def test_local_maximum_wins_when_IT_is_the_tighter_one():
    # POSITIVE TWIN of the test above. Without it, "the tighter wins" would be
    # satisfied equally by a resolver that always returned the caller's value.
    resolution = resolve_effective_deadline(caller_deadline_ms=90_000, local_max_s=LOCAL_MAX_S)
    assert resolution.refusal is None
    assert resolution.effective_s == LOCAL_MAX_S
    assert resolution.bound == "sidecar_local_max"


def test_an_absurdly_excessive_caller_deadline_cannot_widen_the_local_ceiling():
    # A caller cannot buy more budget by asking for more: the local maximum is
    # the bound, so an absurd value is bounded rather than refused.
    resolution = resolve_effective_deadline(
        caller_deadline_ms=10**12, local_max_s=LOCAL_MAX_S
    )
    assert resolution.refusal is None
    assert resolution.effective_s == LOCAL_MAX_S
    assert resolution.bound == "sidecar_local_max"


def test_an_exactly_equal_deadline_is_attributed_to_the_local_maximum():
    # A tie is not the caller winning: neither bound is looser, and naming the
    # local one keeps the attribution honest in the failure reason.
    resolution = resolve_effective_deadline(
        caller_deadline_ms=LOCAL_MAX_S * 1000, local_max_s=LOCAL_MAX_S
    )
    assert resolution.refusal is None
    assert resolution.bound == "sidecar_local_max"


@pytest.mark.parametrize("expired", [0, -1, -5_000, -0.5])
def test_an_already_expired_deadline_is_refused(expired):
    resolution = resolve_effective_deadline(
        caller_deadline_ms=expired, local_max_s=LOCAL_MAX_S
    )
    assert resolution.effective_s is None
    assert resolution.refusal == "caller_deadline_expired"


@pytest.mark.parametrize(
    "raw", [float("nan"), float("inf"), float("-inf")]
)
def test_a_non_finite_deadline_is_refused_and_is_NOT_misreported_as_expired(raw):
    """The ORDER of the checks is the assertion.

    If positivity were tested first, `nan <= 0` would be false (every NaN
    comparison is), NaN would sail through as a valid deadline and reach
    `asyncio.wait_for`, where this runtime raises
    `ValueError: cannot convert float NaN to integer` from inside the event
    loop — an unstructured framework crash, which is exactly what a deadline
    exists to replace with a structured outcome. And `-inf <= 0` IS true, so a
    positivity-first resolver would label it "expired" and hide that the input
    was malformed. Asserting the refusal NAME, not merely that a refusal
    happened, is what pins the ordering.
    """
    resolution = resolve_effective_deadline(caller_deadline_ms=raw, local_max_s=LOCAL_MAX_S)
    assert resolution.effective_s is None
    assert resolution.refusal == "caller_deadline_not_finite"


def test_POSITIVE_CONTROL_a_valid_deadline_is_still_accepted_and_applied():
    """Without this, every refusal above would pass equally against a resolver
    that had simply learned to refuse everything — the sabotage-without-a-
    control failure CLAUDE.md Law 28's corollary names.
    """
    resolution = resolve_effective_deadline(caller_deadline_ms=250, local_max_s=LOCAL_MAX_S)
    assert resolution.refusal is None
    assert resolution.effective_s == pytest.approx(0.25)
    assert resolution.bound == "caller_supplied"


@pytest.mark.parametrize("bad_local", [float("nan"), float("inf"), 0, -1])
def test_a_broken_local_maximum_refuses_rather_than_running_unbounded(bad_local):
    """settings.py already refuses to BOOT with such a value, so this can only
    fire if a future edit removes that guard. A fail-closed rule needs a
    mechanism to fail with (Law 26's corollary): running with no usable
    ceiling at all is the one outcome that must never be reachable.
    """
    resolution = resolve_effective_deadline(caller_deadline_ms=1000, local_max_s=bad_local)
    assert resolution.effective_s is None
    assert resolution.refusal == "sidecar_local_max_unusable"
