"""The ENTIRE wire contract for POST /v1/agent-run.

Mirrors services/isola-runtime/src/agentos-execution-provider.ts's
`AgentOsRunEnvelope` exactly — five fields, `extra="forbid"` so a body
carrying anything else (an Odoo/Chatwoot/host credential, a stray field from
a future Node change nobody reviewed here) is REJECTED as malformed rather
than silently accepted and ignored. That is the type-system enforcement the
architecture spec asks for: not a convention two call sites have to remember.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Exposure = Literal["INTERNAL", "PUBLIC"]


class AgentRunEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    correlationId: str = Field(min_length=1)
    tenantId: str = Field(min_length=1)
    templateId: str = Field(min_length=1)
    exposure: Exposure
    # THE SERVER-AUTHORITATIVE INSTRUCTION SOURCE, resolved by Node (the
    # compiled-in template charter, or the Paperclip charter when the template
    # is bound in PAPERCLIP_INSTRUCTIONS_MAP). Required: a run whose
    # instructions the caller could omit would silently fall back to this
    # service's own compiled-in copy, which is the drift this field removes.
    # It is a DISTINCT field from `context` and the two are never merged.
    systemPrompt: str = Field(min_length=1)
    context: str
    # THE CALLER'S REMAINING BUDGET, IN MILLISECONDS. Server-derived by Node
    # (`Math.min(request.timeoutMs, options.timeoutMs)` — the template's
    # declared timeout, RUNTIME_MODEL_TIMEOUT_MS and AGENTOS_TIMEOUT_MS), never
    # read from a customer's request body: a caller able to name its own
    # deadline could widen the effective policy ceiling of a process it has no
    # right to configure.
    #
    # A DURATION, NOT A TIMESTAMP. The two containers have no guaranteed clock
    # sync, and an absolute epoch interpreted against the wrong clock fails
    # silently in both directions — arriving already expired, or arriving with
    # hours of budget. A duration means the same thing on both sides of the hop.
    #
    # OPTIONAL, and absence is bounded rather than refused: an envelope with no
    # deadline falls back to this process's own AGENTOS_REQUEST_TIMEOUT_S,
    # which is never wider than local policy (see deadline.py). Typed `float`
    # rather than `int` on purpose — the type is the outer gate (a non-numeric
    # value is rejected by the contract, by field name only), and deadline.py
    # then applies the finiteness-before-positivity check, because JSON's
    # bare `NaN`/`Infinity` tokens parse cleanly through `json.loads` and would
    # otherwise reach `asyncio.wait_for` and crash the event loop.
    deadlineMs: float | None = None


class AgentRunUsage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    promptTokens: int | None = None
    completionTokens: int | None = None
    cachedPromptTokens: int | None = None


class AgentRunResponse(BaseModel):
    """`status` is the ONLY field Node treats as authoritative — anything other
    than the literal string "completed" is treated as failed, per
    agentos-execution-provider.ts. `reason` is included on a non-completed
    response purely for operator log correlation; Node never surfaces it to a
    customer.
    """

    model_config = ConfigDict(extra="forbid")

    status: Literal["completed", "error"]
    content: str | None = None
    model: str | None = None
    usage: AgentRunUsage | None = None
    reason: str | None = None
