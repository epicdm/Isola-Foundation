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
