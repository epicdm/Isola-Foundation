"""The one Agno agent this sidecar runs.

Model choice (Phase A): `agno.models.deepseek.DeepSeek`, pointed at the SAME
provider services/isola-runtime already uses for this exact template
(`model: "deepseek-chat"` in registry.ts) — not the missing/broken
`codex_local` credential (def-staff-ops-coordinator-codex-credential-lost-in-
reseed-2026-08-19, explicitly out of scope per
dec-agentos-ai1-reality-reset-sidecar-first-2026-08-27), and not any OpenAI
credential. The credential is file-backed and separately pinned from Node's
own MODEL_API_KEY (see settings.py's AGENTOS_MODEL_API_KEY /
AGENTOS_MODEL_API_KEY_FILE) — a compromise of one does not hand over the
other.

`agno.models.deepseek.DeepSeek` subclasses `OpenAILike`, which imports the
`openai` SDK package at import time even though no OpenAI credential is ever
used — that import is why `openai` is a pinned dependency below, not because
this service talks to OpenAI.

No live model credential is available in this sandboxed Phase-A worktree.
Every test in this repo mocks `run_operations_coordinator` (or the
`build_agent` factory) rather than requiring one — see tests/test_agent_run_route.py.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from agentos_runtime.prompt import OPERATIONS_COORDINATOR_PROMPT
from agentos_runtime.settings import Settings


@dataclass(frozen=True)
class AgentRunOutcome:
    """The ONLY two terminal shapes this module produces. There is no partial
    or ambiguous state: either the run completed with usable content, or it
    failed for a named reason. `failed` covers a missing credential, a
    dependency (model backend) that could not be reached, and a run Agno
    itself reports as non-`RunStatus.completed` — all three collapse to the
    same shape here, exactly as ExecutionResult does on the Node side.
    """

    completed: bool
    content: str | None = None
    model: str | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    cached_prompt_tokens: int | None = None
    failure_reason: str | None = None


class AgentRunner(Protocol):
    async def __call__(self, context_text: str) -> AgentRunOutcome: ...


def build_agent(settings: Settings):
    """Constructs the Agno Agent. Imported lazily inside this function (not at
    module scope) so importing `agentos_runtime.agent` — e.g. from a test that
    only wants `AgentRunOutcome` — never requires `agno`/`openai` to be
    importable in a stripped-down test environment. The route module still
    imports agno at startup, which is the correct place for that dependency
    to be mandatory.
    """
    from agno.agent import Agent
    from agno.models.deepseek import DeepSeek

    model = DeepSeek(
        id=settings.model_id,
        api_key=settings.model_api_key,
        base_url=settings.model_base_url,
    )
    return Agent(
        model=model,
        instructions=[OPERATIONS_COORDINATOR_PROMPT],
        markdown=True,
        telemetry=False,
    )


def make_run_operations_coordinator(settings: Settings) -> AgentRunner:
    """Returns the async callable the FastAPI route calls. Closed over
    `settings` so a missing model credential is checked once per call without
    re-reading configuration, and so the Agent is built lazily on first use
    (never at import time — a missing credential must not crash the whole
    process, only fail the one code path that needs it).
    """
    agent = None

    async def run(context_text: str) -> AgentRunOutcome:
        nonlocal agent

        if settings.model_api_key is None:
            # FAIL CLOSED, per-request, exactly like services/isola-runtime's
            # own MODEL_API_KEY-unset behaviour (a bootWarning there, a 502 on
            # every call) — this is the documented, correctly-wired
            # configuration point the Phase-A spec explicitly allows to lack a
            # live credential. Never fabricate an answer here.
            return AgentRunOutcome(
                completed=False,
                failure_reason="dependency_unavailable: AGENTOS_MODEL_API_KEY is not configured",
            )

        try:
            if agent is None:
                agent = build_agent(settings)

            from agno.run.base import RunStatus

            run_output = await agent.arun(context_text)

            status = getattr(run_output, "status", None)
            if status != RunStatus.completed:
                return AgentRunOutcome(
                    completed=False,
                    failure_reason=f"agno_non_completed_status ({status})",
                )

            content = getattr(run_output, "content", None)
            if not isinstance(content, str) or content.strip() == "":
                return AgentRunOutcome(
                    completed=False,
                    failure_reason="agno_completed_with_no_usable_content",
                )

            metrics = getattr(run_output, "metrics", None)
            return AgentRunOutcome(
                completed=True,
                content=content,
                model=settings.model_id,
                prompt_tokens=getattr(metrics, "input_tokens", None) if metrics else None,
                completion_tokens=getattr(metrics, "output_tokens", None) if metrics else None,
                cached_prompt_tokens=getattr(metrics, "cached_tokens", None) if metrics else None,
            )
        except Exception as exc:  # noqa: BLE001 — deliberately broad: ANY
            # exception from the model backend (connection refused, timeout,
            # malformed response, auth failure at the provider) is a
            # dependency failure, never a fabricated answer, and never
            # re-raised into a 500 that might carry provider-specific detail
            # (a URL, a header) into a log. Only the exception class name is
            # kept — the same discipline services/isola-runtime's model.ts
            # uses for its own provider errors.
            return AgentRunOutcome(
                completed=False,
                failure_reason=f"dependency_unavailable ({type(exc).__name__})",
            )

    return run
