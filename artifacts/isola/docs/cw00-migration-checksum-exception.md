# CW00 — the one edited applied migration

`20260725210000_chatwoot_binding_account_inbox_mode_unique` was edited **after** it had already
been applied to production. That is normally forbidden. It was done once, under a narrowly-scoped
owner exception granted 2026-07-26, and it is **not a precedent**.

| | |
|---|---|
| Applied to production | `2026-07-25 22:21:50.144659+00` → `.399674+00`, 1 step, no rollback |
| Production ledger checksum (permanent) | `a67295d73829ac254daa326e71d2cfb3eaf4660e387115df50cd8d59b64f8882` |
| Repaired repository checksum | `4ef385fab8ab9439005952666954285bde7ff953f6acc2bc7ccda9ca232345be` |

## Why

The original migration named production's exact rows in hard preconditions. That made it safe to
run unattended via `start:prod` — and unreplayable everywhere else. Measured: applying the real
25-migration history to an empty database failed here with *"expected 1 or 2 ChatwootBinding rows
on account 5 / inbox 3 / a2, found 0"*. 24 migrations applied, the unique index was never created.

Consequences before the repair:

* **Development could never converge.** `heliumdb` sat one migration behind, with the CW00 index
  absent, and no way to apply it.
* **Migration-only disaster recovery was broken.** A rebuild from migrations alone could not reach
  production's schema.
* **Replit's publish-time dev→prod schema diff proposed removing the production index**, because
  development lacked it. The same mechanism had already been caught once, on 2026-07-22, against
  `EscalationRef`.

## What changed

Four changes, all inside the migration:

1. The `n_key NOT IN (1,2)` abort became a branch classification, so an environment with no
   reviewed rows proceeds instead of failing.
2. The production identity assertions are gated on **whether the dedupe actually ran**, not on
   whether the door is populated. Production still gets the full check.
3. The index post-check asserts the exact **shape** — `indisunique`, `indisvalid`, `indisready`,
   non-partial, owning table, and exact column order — not just the name. `CREATE UNIQUE INDEX IF
   NOT EXISTS` keys on the name alone, so a same-named non-unique or wrong-column index would
   otherwise pass as success with the containment silently absent.
4. Partial presence of production's identity set fails closed rather than being treated as neutral.

Recognised shapes: production first run · production re-run · environment-neutral. Anything else
aborts before any DML or DDL.

## Why the checksum divergence is permanent

Prisma offers no supported way to refresh an applied migration's checksum — `migrate resolve
--applied` on an already-applied migration returns `P3008`. Production's ledger therefore keeps the
original value for the life of that database.

Measured behaviour of Prisma 6.19.3:

| Command | Behaviour with an edited applied migration |
|---|---|
| `migrate status` | does not re-verify applied checksums — clean |
| `migrate deploy` | does not re-verify applied checksums — no-op, later migrations still apply |
| `migrate dev` | **reports the migration as modified and offers to reset the database** |

The `migrate dev` warning is expected. **Decline the reset.** Do not suppress Prisma warnings
globally — that would hide the next real drift.

## The guard

`scripts/src/guard-cw00-checksum-exception.ts` permits exactly this one migration with exactly this
one checksum pair, and fails closed on anything else:

```bash
pnpm --filter ./scripts run guard-cw00-checksum        # uses DATABASE_URL
```

It also recognises **line-ending-only** differences as identical content rather than drift.
Production's ledger contains two such rows — `20260720070638_add_notification_outbox` and
`20260722203000_repair_escalation_ref_schema_drift` — whose checksums were written from Windows
(CRLF) checkouts while the repository stores LF. Those are not drift, and a guard that cried wolf
on them would be switched off.

## The preflight is mandatory

Because the in-migration identity assertion is now conditional, and because the migration will
never re-run in production, `prisma/preflight/20260725210000_cw00_binding_uniqueness_preflight.sql`
is the **only** thing that re-proves production identity. Run it read-only before any deploy. A
clean `migrate status` is not a substitute: status proves the ledger, not the rows.

## Standing lesson

The preconditions that made this migration safe to run unattended are exactly what made it
unreplayable. **Any precondition-guarded repair migration inherits that trade.** Write such guards
environment-conditionally from the start: strict where the reviewed identity is present, structural
everywhere else.
