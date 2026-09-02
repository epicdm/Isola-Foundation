# Clawith upgrade — required checks

**Status:** OPERATIONAL RUNBOOK. Run every check here after **any** Clawith version bump,
before the upgraded version carries customer traffic.

> No such runbook existed before 2026-08-13. This file was created to hold check 1, which
> closes a real fragility without forking Clawith (CLAUDE.md law 2). Add to it; do not
> replace it with a fork.

---

## Why these checks exist rather than a patch

Clawith is an engine this programme does not fork. `/home/epicdm/clawith-v1110` tracks
`upstream https://github.com/dataelement/clawith.git`, and `backend/app/services/llm/failover.py`
is **unmodified since tag `v1.11.0`** — verified 2026-08-13 with
`git diff v1.11.0 -- backend/app/services/llm/failover.py` returning empty.

A fork would be a patch re-applied on every upgrade forever, and this programme loses things
between sessions. A runbook line costs one command per upgrade and cannot silently disappear.

---

## Check 1 — a provider 402 must still classify as retryable

**Why.** All five agents share one primary model (`deepseek/deepseek-v4-pro`). A 402
"Insufficient Balance" is the failure that actually took the estate down on 2026-08-13, and
the only thing that keeps a conversation alive is failover to the fallback model
(`openai/gpt-4o-mini`). Failover fires only when `is_retryable_error()` says the error is
retryable.

**The fragility.** `classify_error()` in `backend/app/services/llm/failover.py` has **no 402
branch** — grep the whole `services/llm/` tree for `402`, `insufficient`, `balance`,
`payment required`, `quota` or `credit` and you get nothing (verified against upstream `main`,
2026-08-13). A 402 survives as retryable through **two implicit paths**, neither of which
names it:

1. the `[llm error]` / `[llm call error]` / `[error]` prefix branch returns `RETRYABLE`; and
2. the function's final default returns `UNKNOWN`, which `is_retryable_error()` treats as
   retryable because it tests `!= NON_RETRYABLE` rather than `== RETRYABLE`.

Either can be removed by an ordinary refactor — tightening that comparison to `== RETRYABLE`
is a one-character change that silently ends 402 failover. Nothing in the codebase would fail.

**So this check asserts the OUTCOME, never a branch.** A check that looked for a 402 case
would pass on a version that has no 402 handling at all, and fail on a version that fixed it
differently. Both are wrong answers.

### Run it

```bash
ssh epicdm@66.118.37.12 'sudo docker exec clawith-v1110-backend-1 python - <<PY
from app.services.llm.failover import classify_error, FailoverErrorType
from app.services.llm.caller import is_retryable_error

RAW = "[LLM Error] HTTP 402: {\"error\":{\"message\":\"Insufficient Balance\",\"code\":\"invalid_request_error\"}}"

cls = classify_error(Exception(RAW))
retryable = is_retryable_error(RAW)

print("classify_error :", cls)
print("is_retryable   :", retryable)
assert cls != FailoverErrorType.NON_RETRYABLE, "REGRESSION: a 402 now classifies NON_RETRYABLE"
assert retryable is True, "REGRESSION: is_retryable_error() no longer accepts a 402"
print("PASS - a 402 still fails over")
PY'
```

**Pass:** prints `PASS`.
**Fail:** either assertion trips. **Do not carry customer traffic on that version.** A 402
then returns the provider error as the reply text, which Foundation contains
(`lib/provider-failure.ts`) but only by deflecting and escalating — every affected customer
gets a non-answer and a human handoff.

### Also confirm the fallback is still wired

```bash
ssh epicdm@66.118.37.12 'sudo docker exec clawith-v1110-postgres-1 sh -c '"'"'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -A -F"|" -c "SELECT name, (primary_model_id IS NOT NULL) AS has_primary, (fallback_model_id IS NOT NULL) AS has_fallback, (primary_model_id = fallback_model_id) AS self_fallback FROM agents ORDER BY name;"'"'"''
```

**Pass:** every row `has_fallback = t` and `self_fallback = f`. A fallback pointing at the
same provider as the primary is not a fallback — it fails to the same outage.

---

## Check 2 — the token-cap notice must not be returned as reply text

`call_llm()` in `backend/app/services/llm/caller.py` returns the daily/monthly quota notice
**as the agent's reply** when a cap is exceeded, addressing the customer as if they were the
administrator. Foundation contains this (`lib/provider-failure.ts`, rule
`token_quota_notice`), but the containment is keyed on the notice's wording.

After an upgrade, confirm the wording has not changed:

```bash
ssh epicdm@66.118.37.12 'sudo docker exec clawith-v1110-backend-1 grep -n "token usage has reached the limit" /app/app/services/llm/caller.py'
```

**Pass:** the string is present and unchanged.
**Fail (string changed):** update the `token_quota_notice` pattern in
`artifacts/isola/lib/provider-failure.ts` **before** the version carries traffic, or the
notice reaches customers again.
**Fail (string absent):** confirm whether upstream fixed it. If so, record that and consider
retiring the rule — but keep the rule until the fix is verified in the deployed build, not
just in the changelog.

**Standing constraint until Foundation's containment is published:** no token cap on EMA or
`EPIC Front Desk 6737`. `max_tokens_per_day = NULL` is the only thing protecting the
customer-facing agents.

---

## Check 3 — persona files are still read live

Agent personas live at `backend/agent_data/<agent_id>/soul.md`, bind-mounted from the host to
`/data/agents` in the container. They are re-read per call (`build_agent_context` inside
`call_llm`, no cache), so an edit takes effect on the next turn with no restart.

Confirm the mount and the backend after an upgrade — read the file **as the process sees it**,
never from the host:

```bash
ssh epicdm@66.118.37.12 'sudo docker exec clawith-v1110-backend-1 python -c "
from app.config import get_settings
s = get_settings()
print(\"STORAGE_BACKEND :\", s.STORAGE_BACKEND)
print(\"AGENT_DATA_DIR  :\", s.AGENT_DATA_DIR)
"; sudo docker exec clawith-v1110-backend-1 sha256sum /data/agents/81b38cd6-9fba-4cc8-8f87-1bce1a4aa162/soul.md'
```

**Pass:** `STORAGE_BACKEND = local`, and the hash matches the host file.
**Fail:** if `STORAGE_BACKEND` becomes `s3` with `STORAGE_LOCAL_FALLBACK_ENABLED=true`, host
edits become **intermittently** live — S3 first, the bind mount only on miss — while every
host-side check still passes. That is worse than a clean failure and no host-side verification
detects it.
