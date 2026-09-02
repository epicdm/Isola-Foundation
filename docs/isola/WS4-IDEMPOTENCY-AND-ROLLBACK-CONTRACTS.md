# WS4 — Idempotency, retry, compensation and rollback contracts

Status: **design artifact**. Not implemented; implementation requires the held
NocoBase and Activepieces surfaces.

These contracts are not invented for WS4. They are the shapes that **survived
deployed fault injection** in WS2 on 2026-08-11 — see
`evidence-ws2-durable-delivery-ledger-2026-08-11` and
`evidence-ws2-crash-window-failpoint-proof-2026-08-11`. Reusing a proven shape
is worth more than designing a fresh one.

---

## 1. Idempotency

### 1.1 The atomic key

Every provisioning action is claimed under a key that is unique by construction
and enforced by the **database**, not by application logic:

```
(tenant_id, run_correlation_id, step_key)
```

Implemented as a `UniqueConstraint` on `(run, key)` in `ProvisioningStep`. Two
concurrent executors cannot both create the same step.

**Why database-enforced.** WS2's ledger uses a Postgres primary key for exactly
this, and the deployed proof showed two simultaneous copies of one event
producing one model run and one reply. An in-process guard cannot make that
claim across processes or restarts.

### 1.2 Natural keys in target systems

Each remote creation must be idempotent **at the destination**, because a retry
after a lost response must not create a second object:

| Step | Idempotency mechanism | Confirmed? |
|---|---|---|
| `nocobase_tenant` | natural key on the tenant record | `UNRESOLVED` — depends on the approved schema |
| `paperclip_company` | company name/external ref lookup before create | `UNRESOLVED` |
| `paperclip_employee` | template + company + exposure lookup before create | `UNRESOLVED` |
| `chatwoot_workspace` | `custom_attributes` marker — **accounts are NOT natively idempotent in Chatwoot**; users ARE a native upsert-by-email; teams are DB-unique on lowercased name; `set_agent_bot` is find-or-new | **Confirmed** — established during WS2 provisioning |
| `gateway_binding` | `(chatwoot_account_id, chatwoot_inbox_id)` refused as a duplicate at gateway boot | **Confirmed deployed** |

Items marked `UNRESOLVED` must be resolved by the read-only contract probe
before any executor is written. **Do not assume a natural key exists.**

### 1.3 Reserve before acting

The WS2 pattern, which the deployed proofs validated:

1. Claim the step atomically (`PENDING`/`FAILED` → `IN_PROGRESS`).
2. Perform the remote call.
3. Record the returned identifier and only then mark `SUCCEEDED`.

A crash between 2 and 3 leaves the step `IN_PROGRESS` with an expired lease —
recoverable, and **never** silently marked done. WS2 proved this exact window
with a deterministic failpoint: the reply was in Chatwoot, the ledger did not
know, and recovery reconciled to exactly one observable reply.

## 2. Retry

| Rule | Value |
|---|---|
| Retryable | transport failures, 5xx, timeouts, explicit rate limits |
| Not retryable | 4xx other than 408/429, validation failures, permission denials |
| Backoff | exponential with jitter, from 2s |
| Cap | 5 attempts per step per run; then `FAILED` and an operator alert |
| Lease | must exceed the slowest legitimate call, or a healthy run gets picked up twice |

The lease rule is not theoretical: the gateway carries a boot warning when
`GATEWAY_LEDGER_LEASE_MS` is not longer than the runtime timeout, for precisely
this failure.

**Reconcile before any resend.** If a call's outcome is unknown, query the
target for the natural key or stamped reference *before* retrying. If the
outcome cannot be determined, **fail closed and alert** — do not retry blind.
WS2 proved a duplicate customer message is worse than a missing one.

## 3. Compensation

Provisioning spans systems with no distributed transaction. Compensation is
per-step and **additive-safe**: prefer retiring over deleting, because deleting
destroys audit history and can orphan customer data.

| Step | Compensation | Destructive? |
|---|---|---|
| `company_profile` | none needed; portal-local and re-editable | no |
| `nocobase_tenant` | mark the record `provisioning_failed`; do **not** delete | no |
| `paperclip_company` | leave in place; reuse on retry | no |
| `paperclip_employee` | `POST /api/agents/{id}/pause` — the proven kill switch | no |
| `chatwoot_workspace` | detach the AgentBot (`set_agent_bot` with no bot); **never** delete inbox, account, user or conversations | no |
| `gateway_binding` | mark the binding `retired`; the gateway then authenticates and declines, proven deployed (conv 35) | no |

**No compensation deletes anything.** Every one is reversible and leaves
history intact.

## 4. Rollback

Rollback of a whole run is the ordered application of each completed step's
compensation, newest first, then the run is marked `FAILED` with a reason.

Rollback must be **idempotent** — compensating an already-compensated step is a
no-op — because rollback itself can crash midway.

### What rollback must never do

- Delete a Chatwoot account, inbox, user or conversation.
- Delete a NocoBase tenant record.
- Delete provisioning history.
- Revive a credential or session that was deliberately invalidated.

## 5. Restart behaviour

A restart mid-run must not duplicate work. On boot the executor:

1. Finds runs with steps `IN_PROGRESS` whose lease has expired.
2. For each, **reconciles before acting** — asks the target system whether the
   work already exists.
3. Resumes only what is genuinely absent.

WS2's recovery sweeper implements exactly this and was proven deployed,
including the case where reconciliation must be asked **first**: once the reply
existed, the inbound message it answered was no longer visible, and asking the
target first was the only thing that resolved it correctly rather than
abandoning the delivery.

## 6. Two-tenant isolation

Every claim, query and compensation is scoped by `tenant_id`, and the key
includes it. Isolation is unit-tested today
(`TestTenantIsolation::test_two_tenants_have_independent_runs`) and must be
re-proven end to end in the 28-point acceptance with two fresh synthetic
tenants.

## 7. Alerting

A stable `alertCode` per condition, so alerting binds to a code and not to
prose — the pattern the gateway already uses:

| Condition | `alertCode` |
|---|---|
| Step failed after the retry cap | `provisioning_step_exhausted` |
| Outcome unresolvable, failed closed | `provisioning_state_unresolved` |
| Compensation failed | `provisioning_compensation_failed` |
| Control plane unreachable at claim time | `control_plane_unavailable` |

## 8. Open items

- Every `UNRESOLVED` natural key in §1.2.
- Executor implementation for steps 2–6.
- Whether Activepieces' native retry is used or retry is modelled explicitly in
  the run — decide **after** the connection type is confirmed against the
  running 0.87.0 instance.
