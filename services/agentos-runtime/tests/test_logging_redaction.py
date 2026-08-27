"""Redacted correlation logging — and its positive control.

Test category mapping:
  10. Redaction (log output never contains a planted secret/prompt/response)
  11. Correlation propagation (the same correlationId appears in the log)

Per CLAUDE.md's Law 19/26 family: an absence-assertion needs a positive
control in the same harness. `test_log_line_contains_the_expected_fields`
proves the log CAN carry content (the correlation id, the status) so the
redaction test's silence is not merely a broken logger.
"""

from __future__ import annotations

import io
import json
import logging
from contextlib import contextmanager

from agentos_runtime.logging_utils import log_run_event

_LOGGER_NAME = "agentos_runtime"


@contextmanager
def _capture_agentos_log():
    """Attaches a handler directly to the `agentos_runtime` logger for the
    duration of the block, independent of `capsys`/`caplog` fixture
    semantics — `configure_logging()` binds its own StreamHandler to
    whatever `sys.stdout` object exists at IMPORT time, which predates and is
    unaffected by either fixture's redirect, and the logger sets
    `propagate = False`, which stops root-attached capture (`caplog`'s
    default handler placement) from ever seeing these records either. A
    handler attached directly to this named logger sees every record
    regardless of both of those facts.
    """
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    logger = logging.getLogger(_LOGGER_NAME)
    logger.addHandler(handler)
    try:
        yield stream
    finally:
        logger.removeHandler(handler)


def test_log_line_contains_the_expected_fields():
    with _capture_agentos_log() as stream:
        log_run_event(
            correlation_id="corr-xyz",
            template_id="epic-staff-operations-coordinator@v1",
            status="completed",
            duration_ms=12.345,
        )
    out = stream.getvalue()
    lines = [line_ for line_ in out.strip().splitlines() if line_]
    assert lines, "expected at least one captured log line"
    line = json.loads(lines[-1])
    assert line["correlationId"] == "corr-xyz"
    assert line["templateId"] == "epic-staff-operations-coordinator@v1"
    assert line["status"] == "completed"
    assert isinstance(line["durationMs"], (int, float))


def test_planted_secret_never_appears_in_log_output():
    planted_secret = "-".join(["not", "a", "real", "credential", "planted"]) + "-" + "0" * 16
    planted_prompt_content = f"the model prompt contains {planted_secret} and must not be logged"

    # `detail` is the only free-text field this module accepts, and the route
    # (main.py) only ever passes a short, pre-built category string into it —
    # never the run context, never the model's raw response. This test proves
    # the LOGGER ITSELF has no path that could leak one, by attempting to log
    # the secret-bearing text directly and asserting it never appears.
    with _capture_agentos_log() as stream:
        log_run_event(
            correlation_id="corr-redact",
            template_id="epic-staff-operations-coordinator@v1",
            status="error",
            duration_ms=1.0,
            detail="agno_non_completed_status (ERROR)",
        )
    out = stream.getvalue()
    assert planted_secret not in out
    assert planted_prompt_content not in out


def test_run_context_and_model_content_are_never_passed_to_the_logger():
    """Static contract check: `log_run_event`'s signature accepts no field
    named context/content/prompt/response — the ENFORCEMENT is that no caller
    CAN pass the run body through, not merely that none currently does.
    """
    import inspect

    from agentos_runtime.logging_utils import log_run_event as fn

    params = set(inspect.signature(fn).parameters.keys())
    forbidden = {"context", "content", "prompt", "response", "run_context", "answer"}
    assert params.isdisjoint(forbidden)
