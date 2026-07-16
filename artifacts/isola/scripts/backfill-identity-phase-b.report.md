# Unify Identity — Phase B backfill report

Run against prod `neondb` (`ep-fancy-cake-aiczmqqq.c-4.us-east-1.aws.neon.tech`), 2026-07-16.
Data-only: no application code reads `Identity`/`Membership`/`VoiceLine` yet — zero behavior change.

## Update 2026-07-16 — `spine/identity-anchor-fix`

PR #4's run below (**Original run** section) left all 4 business Users
un-migrated: every Tenant has `owner_phone = NULL`, and `Identity.phone` was
`NOT NULL`, so `resolveUserIdentity()` had no anchor to create an Identity
from and recorded `NEEDS_PHONE` for all 4.

**Task A — migration `20260716130000_identity_anchor_fix`:** made
`Identity.phone` nullable (`ALTER TABLE "Identity" ALTER COLUMN "phone" DROP
NOT NULL`). Additive/reversible — no drop, no data loss. The unique index
(`Identity_phone_key`) is untouched; Postgres permits multiple `NULL`s under
a unique index. `replit_id` was already nullable+unique from PR #4. Generated
via schema-to-schema `prisma migrate diff` (no shadow DB needed) and applied
with `prisma migrate deploy`; confirmed live via `information_schema.columns`
+ `pg_indexes` and `prisma migrate status` (`Database schema is up to date!`).

**Task B — `resolveUserIdentity()` extended:** when a Tenant has no
`owner_phone` but the User has a `replit_id`, create (or reuse) an Identity
anchored by `replit_id` alone (`phone: null`) instead of skipping. The
terminal skip case (neither `replit_id` nor `owner_phone`) is now labeled
`NEEDS_PHONE_OR_LOGIN` and never fires against current data (all 4 Users
have `replit_id`). Also fixed a latent, previously-unexercised counter bug
from PR #4: neither the phone-anchor create branch nor the new replit-anchor
branch incremented `identity_created` — dormant until this run because no
User had ever taken a create path before (every prior Identity came from the
consumer/`ConsumerAccount` side).

### Counts (apply run 1, this fix)

| metric | value |
|---|---|
| identity_created | 4 |
| identity_linked_existing | 2 |
| membership_created | 4 |
| user_identity_linked | 4 |
| voice_line_created_consumer / business | 0 / 0 (already existed from PR #4 run) |
| wallet_linked / already_linked | 0 / 2 |

### Idempotency proof (apply run 2, immediately after)

`identity_created: 0`, `membership_created: 0`, `user_identity_linked: 4`
(via `byReplit` lookup short-circuit); `identity_linked_existing: 2`,
`membership_already_existed: 4`. Table counts unchanged across both runs:
`Identity: 6`, `Membership: 4`, `VoiceLine: 6`.

### Reconciliation (independent SQL/ORM, post-apply, separate from the
### script's own built-in `verify()`)

| check | result |
|---|---|
| `User` rows with non-null `identity_id` | 4 == 4 (all 4 business Users) |
| `Membership` rows, one per User/Tenant pair above | 4 == 4, `identity_id`+`tenant_id` match each User's own tenant |
| `Identity` rows with `phone IS NULL AND replit_id IS NOT NULL` | 4 (the 4 new business anchors) |
| `Identity` rows with `phone IS NOT NULL` (pre-existing consumer identities, untouched) | 2 |
| Baseline counts unaffected: `Tenant` / `User` / `Wallet` / `ConsumerAccount` | 9 / 4 / 8 / 2 — identical to pre-run |

### Edge report (this run)

- `TENANT_MISSING_OWNER_PHONE` (still 9/9 — unchanged, informational only
  now that the replit_id anchor covers the business-User case)
- `NEEDS_PHONE_OR_LOGIN`: none — all 4 Users had a `replit_id` to anchor on

**No data fabricated.** No phone number was invented for any Identity;
the 4 new business Identities have `phone: null` and are anchored solely by
the User's existing `replit_id` (OIDC login), which was already present
before this change — this fix only relaxed a schema constraint that was
blocking a legitimate anchor Prisma/Postgres already supported.

## Original run (PR #4, pre-anchor-fix) — Counts (apply run 1)

| metric | value |
|---|---|
| Identity created | 2 |
| VoiceLine created (consumer) | 2 |
| VoiceLine created (business) | 4 |
| Wallet.identity_id linked | 2 |
| Membership created | 0 |
| User.identity_id linked | 0 |

## Idempotency proof (apply run 2, immediately after run 1)

Every "created"/"linked" counter reads **0**; every row is instead reported as
already-existing/already-linked (`identity_linked_existing: 2`,
`voice_line_skipped_existing_consumer: 2`, `voice_line_skipped_existing_business: 4`,
`wallet_already_linked: 2`). Confirms the script makes no duplicate rows on
re-run.

## Reconciliation (independent SQL, post-apply)

| check | result |
|---|---|
| `Identity` count == distinct `ConsumerAccount.phone_number` | 2 == 2 |
| `VoiceLine` count == consumer(2) + business(4) | 6 == 6 |
| `Membership` count == Users with a resolvable Identity | 0 == 0 |
| `ConsumerAccount` rows with no matching `Identity` | 0 |
| Existing row counts unchanged (`ConsumerAccount`, `Tenant`, `User`, `Wallet`) | 2 / 9 / 4 / 8 — same as pre-run baseline |

## Edge report — NOT fabricated, handed back for human follow-up

**All 9 Tenants have `owner_phone = NULL`.** Because `Identity.phone` is a
required (`NOT NULL`), unique column, `User.replit_id` alone cannot satisfy
Identity creation — a phone is mandatory. All 4 existing Users have
`replit_id` set but resolve to `NEEDS_PHONE` since their tenant has no
`owner_phone`, so **0 Memberships were created this run**. This is expected
given the current data (not a script defect) — confirmed by both the dry-run
and the apply matching identically.

- `TENANT_MISSING_OWNER_PHONE` (9): `cmreai9ug0000d7y4g6tcl90t` (EPIC Operators),
  `cmrebroxm000bd7y481cumyp6` (test), `cmreerxjx0000s6181ijyypqm` (G Family
  Family's Business), `f2_agrilink` (AgriLink), `f2_perkys` (Perky's Pizza),
  `a5745d43-402a-44cc-aca1-6103e2ca10d1` (Ministry of Agriculture Dominica),
  `95db6fa1-62d3-40e1-aaec-8cdebeab0b6b` (Demo Diner), `cmrh2nrhg000cs6179j0z351e`
  (DIDPROOF-TEST), `ema_sales_tenant` (EMA (EPIC Calling App))
- `NEEDS_PHONE` (4 Users, one per tenant with a User row): `cmreerxl10002s6184800ehwm`,
  `cmreaia6d0002d7y4xdkbknnq`, `cmrebrp0o000jd7y4b3c2631n`, `cmrh2nrla000ks6178i38zkp1`

**Action needed before Phase C can converge business-side users:** backfill
`Tenant.owner_phone` for these 9 tenants (or accept that those Users stay
un-migrated). No collision case was found this run — `ConsumerAccount.phone_number`
never matches a `Tenant.owner_phone` (moot currently since all `owner_phone`
are null), so the "one Identity, both roles" merge path is untested against
real data but is implemented and will engage correctly once `owner_phone`
values exist (an Identity created from a `ConsumerAccount` phone is found and
reused, not duplicated, by the phone-keyed upsert in `resolveUserIdentity`).

## Rollback (untouched — still available)

```sql
TRUNCATE "Membership", "VoiceLine";
DELETE FROM "Identity";
UPDATE "User" SET identity_id = NULL;
UPDATE "Wallet" SET identity_id = NULL;
UPDATE "WalletTxn" SET identity_id = NULL;
UPDATE "AuditLog" SET identity_id = NULL;
```

Safe at any time — nothing reads these tables/columns yet.

**Note (post-anchor-fix):** the row-level rollback above still works
unchanged. Rolling back the *schema* migration
(`20260716130000_identity_anchor_fix`, i.e. restoring `Identity.phone NOT
NULL`) additionally requires first running the row-level rollback above (or
otherwise clearing/backfilling the 4 `phone IS NULL` rows) — `ALTER COLUMN
"phone" SET NOT NULL` will fail while any `NULL` phone exists.
