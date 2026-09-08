# These files are vendored into isola-portal. Read this before you edit them.

**Date:** 2026-09-08 · **Direction:** Isola-Foundation → isola-portal (copy, not move — this repo remains the source)

## Why

The Lumen portal needs the Customer 360 cockpit. Mounting it needed the view to cross a repo
boundary, and the measured dependency closure turned out to be tiny: `workspace-view.tsx` imports
`react`, its own CSS module, `contracts.ts` (**types only, zero imports**) and one value
(`sendBadgeText`) from `send-badge.ts`. **The `@/lib` alias escapes `customer-360/` exactly once, and
it escapes as a `import type`.** None of `route-context.ts`, `service-auth.ts`, `odoo-projection.ts`
or `document-message.ts` — the files that pull `next/server`, `node:crypto`, `@/lib/session` and
`@/lib/permissions` — is in the closure, and `workspace-view.purity.test.ts` enforces that.

A published package was the preferred shape and remains the destination. There is no registry today,
so the ruling was: vendor now, publish later.

## What went across, and where

| This repo | isola-portal |
|---|---|
| `artifacts/isola/components/customer-360/workspace-view.tsx` | `packages/webapp/components/customer-360/workspace-view.tsx` |
| `artifacts/isola/components/customer-360/workspace-view.purity.test.ts` | same path under `packages/webapp/` |
| `artifacts/isola/components/customer-360/customer-360-app.tsx` | same path under `packages/webapp/` |
| `artifacts/isola/components/customer-360/customer-360.module.css` | same path under `packages/webapp/` |
| `artifacts/isola/lib/customer-360/contracts.ts` | `packages/webapp/lib/customer-360/contracts.ts` |
| `artifacts/isola/lib/customer-360/send-badge.ts` | `packages/webapp/lib/customer-360/send-badge.ts` |
| `ACTION_LIFECYCLE_STATES` **only**, out of `artifacts/isola/lib/customer-workspace/contract.ts` | `packages/webapp/lib/customer-workspace/contract.ts` |

The directory layout is mirrored deliberately: `workspace-view.purity.test.ts` resolves its targets
with `join(process.cwd(), 'components', 'customer-360')`, so an identical layout lets it run over
there **unmodified**.

**`customer-360-app.tsx` went across even though the portal will never render it.** The purity test's
positive controls assert that each forbidden pattern IS present in the Chatwoot container — that is
what stops seven absence-assertions passing vacuously in a new repo. The controls are half the test,
so the control's subject had to travel too.

**Only the const was taken from `contract.ts`,** not the file: it has four more `@/lib` type imports
that would have dragged the cascade across. Inlining the derived `ActionLifecycleState` union was
explicitly rejected — that would duplicate a list.

## The part that matters to you

**A CI check in isola-portal compares every one of these files against THIS REPO, byte for byte, and
fails on any difference.**

`packages/webapp/scripts/customer-360-drift-check.mjs`, wired into `.github/workflows/webapp-tests.yml`.
It runs `--self-test` first, which proves it passes on the true copies and fails on a one-byte
alteration, because a drift check nobody has watched fail is a comment.

**So: an edit here is not a local change.** It turns the portal's CI red until someone re-vendors —
which is the intended behaviour. The alternative was a silent fork, and this estate already carries a
committed `templates/employees/.../AGENTS.md` that no longer matches its live content. A stale copy in
git is not a second copy; it is the thing most likely to be mistaken for one.

The portal never edits these files. Its two import edges are resolved by build configuration
(jest `moduleNameMapper` remaps the vendored test's `vitest` import; path aliases will resolve `@/lib`
at mount time) precisely so byte equality stays the mechanism.

## One thing to protect

`customer-360.module.css` declares **69 custom properties**, including `--brand-500`, `--surface-2`,
`--border-strong`, `--text-muted` and `--ok` — every one a token name the portal's Lumen pack also
uses. You already scoped them to `.shell` rather than `:root`, and `CustomerWorkspaceView` applies
`styles.shell` itself so a consumer cannot forget it. **Please keep it that way.** CSS Modules scope
class names, not custom properties, so lifting those declarations to `:root` — a reasonable-looking
move in a Next.js app that owns its whole document — would silently repaint the portal with no error
and no log. The portal now asserts this in `src/design/lumen/__tests__/tokensLumen.spec.ts`, so you
will get a red build rather than a mystery.

— filed by the PAPERCLIP lane, whose substrate is isola-portal. Nothing in this repo was changed
except this note.
