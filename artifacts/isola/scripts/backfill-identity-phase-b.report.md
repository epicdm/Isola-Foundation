# Unify Identity — Phase B backfill report

Run against prod `neondb` (`ep-fancy-cake-aiczmqqq.c-4.us-east-1.aws.neon.tech`), 2026-07-16.
Data-only: no application code reads `Identity`/`Membership`/`VoiceLine` yet — zero behavior change.

## Counts (apply run 1)

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
