# WS4 — Provisioning state machine

Status: **design artifact**. The state machine is implemented and tested in the
portal (`packages/backend/apps/isola_provisioning/` in `epicdm/isola-portal`);
the cross-system execution described in §4 is **held** pending the NocoBase gate.

Authority: `decision-one-authoritative-chatwoot-processor-2026-08-11` and
`decision-ws4-orchestrator-and-nocobase-token-consumer-2026-08-11`.

---

## 1. The property this exists to guarantee

> The portal must never display progress it cannot evidence.

Everything below follows from that. It is not a UI concern — a customer who is
told "provisioning 80% complete" while nothing has been created has been
misled, and an operator who sees green while a system is unreachable cannot do
their job.

Three invariants, enforced in `ProvisioningStep.transition()` and covered by
tests, not by convention:

| Invariant | Enforcement |
|---|---|
| A step reaches `SUCCEEDED` only with an `external_ref` — the identifier the **target system** returned | `transition()` raises `InvalidStepTransition` without one |
| A step is `BLOCKED` only with a stated `blocked_reason` | `transition()` raises without one |
| Transitions follow an explicit table; `PENDING → SUCCEEDED` is impossible and `SUCCEEDED` is terminal | `ALLOWED_STEP_TRANSITIONS` |

## 2. Step states

| State | Meaning | Counts as complete? |
|---|---|---|
| `PENDING` | Not attempted, and nothing prevents attempting it | No |
| `BLOCKED` | Deliberately cannot be attempted; `blocked_reason` says why | **No** |
| `IN_PROGRESS` | Claimed and running; carries a correlation id | No |
| `SUCCEEDED` | The target system confirmed it; `external_ref` holds its id | Yes |
| `FAILED` | Attempted and failed; `detail` carries a non-secret category | No |
| `SKIPPED` | Deliberately not required for this tenant | Yes |

**Why `BLOCKED` and not `PENDING` for held work.** `PENDING` reads to a customer
as "queued, about to happen". `BLOCKED` with a reason is the truthful state for
work that cannot start, and it is what makes the status surface honest while
WS4 is gated. `HELD_STEPS` in `constants.py` is the single switch: delete an
entry and that step becomes runnable.

### Transition table

```
PENDING      → BLOCKED | IN_PROGRESS | SKIPPED
BLOCKED      → PENDING | IN_PROGRESS | SKIPPED
IN_PROGRESS  → SUCCEEDED | FAILED | BLOCKED
FAILED       → IN_PROGRESS | BLOCKED | SKIPPED      (retry allowed)
SUCCEEDED    → (terminal)
SKIPPED      → PENDING
```

## 3. Run states

Derived from the steps by `recompute_state()` — **never set directly**, so the
run cannot disagree with its own steps.

| Run state | Condition |
|---|---|
| `FAILED` | any step `FAILED` |
| `SUCCEEDED` | every step in {`SUCCEEDED`, `SKIPPED`} |
| `IN_PROGRESS` | any step `IN_PROGRESS`, or some complete and work remains |
| `BLOCKED` | at least one step `BLOCKED` **and** no step is actionable |
| `NOT_STARTED` | otherwise |

`progress_percent = completed_steps / total_steps`, where blocked steps stay in
the **denominator**. A held journey therefore cannot render as complete.

## 4. The steps

| # | Key | Owner system | Currently |
|---|---|---|---|
| 1 | `company_profile` | portal | **runnable** |
| 2 | `nocobase_tenant` | nocobase | HELD |
| 3 | `paperclip_company` | paperclip | HELD |
| 4 | `paperclip_employee` | paperclip | HELD |
| 5 | `chatwoot_workspace` | chatwoot | HELD |
| 6 | `gateway_binding` | isola-gateway | HELD |

Step 1 is the only one the portal can complete alone. Its `external_ref` is the
`CompanyProfile` id — the confirming system genuinely *is* the portal there, so
the "success needs a reference" rule holds without pretending a remote system
was involved.

Steps 2–6 are executed by **Activepieces** reading approved state from
**NocoBase**. Step 6 must go through the Isola Registry/Gateway validation
contract rather than writing a binding directly — Activepieces must not
duplicate routing or exposure policy.

## 5. Ordering and dependencies

Strictly sequential as listed. Every step after 1 depends on the control-plane
tenant record existing, and `gateway_binding` additionally requires both the
workspace and the AI employee to exist and be verified.

The gateway independently refuses, at boot, a duplicate `(account, inbox)` pair
and any binding whose exposure is not exactly `PUBLIC` — both proven deployed
on 2026-08-11. So step 6 cannot create an unsafe binding even if this state
machine were wrong about ordering.

## 6. What is NOT modelled here, deliberately

- **Retry scheduling.** Activepieces owns sequencing and retry; see
  `WS4-IDEMPOTENCY-AND-ROLLBACK-CONTRACTS.md`.
- **Policy.** Exposure classification, routing and binding policy belong to the
  Registry/Gateway.
- **Billing.** Out of scope for this packet.

## 7. Open items

- Steps 2–6 have no executor yet; they are declared and held.
- Compensation actions per step are specified in the contracts document but not
  implemented, because implementing them requires the held systems.
