# Migrations — the release invariant

**A production migration must be backward-compatible with the release that is
currently live.**

This is not a style preference. Since
`decision-run-prisma-migrate-in-build-phase-2026-08-07`, `prisma migrate deploy`
runs in the Replit deployment **build phase**, not at runtime startup:

```
1. package / install / preflight
2. api-server build + staging
3. isola build + staging
4. BUILD_PREFLIGHT / BUILD_IDENTITY / staged-entrypoint assertions
5. prisma migrate deploy          ← last step of the build phase
6. image / runtime packaging      ← promotion happens after this
```

Migrations run at step 5. Promotion happens at step 6, and **can fail**. The
old release keeps serving traffic when it does. So between step 5 and a
successful step 6 there is always a window — sometimes permanent, if promotion
never succeeds — where the **new schema is live under the old code**.

That window is why the invariant exists. A migration that the currently-serving
release cannot tolerate turns a failed promotion into an outage, instead of a
no-op that leaves the previous release running.

## What this rules out in a single migration

- Dropping or renaming a column, table or enum value the live release still reads.
- Adding a `NOT NULL` column with no default, where the live release inserts rows
  without it.
- Narrowing a type, or adding a constraint the live release's writes would violate.
- Any change whose correctness depends on the new application code already running.

## The shape that is always safe

Split it across releases — expand, then contract:

1. **Expand.** Add the new column/table as nullable or defaulted. Both the old
   and new code work against this schema. Ship and promote it.
2. **Migrate + dual-write/backfill** in application code, once that code is live.
3. **Contract.** Only in a *later* release, once nothing reads the old shape,
   drop or tighten it.

## Why migrations do not run at runtime

The runtime container has no workspace `node_modules` — every `node_modules`
path is excluded by `.replitignore`, so `node_modules/.bin/prisma` does not
exist there. A real publish proved it: `start:prod` began with
`prisma migrate deploy` and the runtime answered `sh: 1: prisma: not found`.
This also means migrations no longer run on every Autoscale cold start, which
is the correct behaviour regardless — Autoscale may start many instances.

Repository rules that still apply unchanged: never `prisma db push`, never edit
`_prisma_migrations`, never `migrate resolve`. See `CLAUDE.md` §2.
