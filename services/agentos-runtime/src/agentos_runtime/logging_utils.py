"""Redacted correlation logging.

Per the architecture ruling: "redacted OpenTelemetry correlation" — Phase A
implements the redaction discipline as structured JSON logging (one line per
event) rather than wiring a live OTel exporter, which has nowhere safe to
send spans in this sandboxed worktree. The field list below is exhaustive on
purpose: correlation id, timing, the selected template id, and terminal
status. NEVER the run-context body, the model prompt, the model's raw
response content, or any secret. `test_logging_redaction.py` asserts this by
feeding an obviously secret-shaped string through a real request and
asserting it never appears in captured log output — the same shape of test
CLAUDE.md requires for every redaction claim on this estate (Law 26's
corollary: "a secret can sit anywhere in a request line").
"""

from __future__ import annotations

import json
import logging
import sys
import time
from dataclasses import dataclass, field

logger = logging.getLogger("agentos_runtime")


def configure_logging(stream=None) -> None:
    handler = logging.StreamHandler(stream or sys.stdout)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.handlers.clear()
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False


@dataclass
class RunLogFields:
    correlation_id: str
    template_id: str
    started_at: float = field(default_factory=time.monotonic)


def log_run_event(
    *,
    correlation_id: str,
    template_id: str,
    status: str,
    duration_ms: float,
    detail: str | None = None,
) -> None:
    """The ONLY fields ever logged for a run. `detail` is a short, pre-built
    category string (e.g. "agentos_tenant_refused: ...", "agno_non_completed_status
    (ERROR)") — never a raw exception message from the model provider, never
    the run context, never the model's answer.
    """
    line = {
        "event": "agent_run",
        "correlationId": correlation_id,
        "templateId": template_id,
        "status": status,
        "durationMs": round(duration_ms, 3),
    }
    if detail is not None:
        line["detail"] = detail
    logger.info(json.dumps(line, sort_keys=True))
