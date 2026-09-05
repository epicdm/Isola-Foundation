# Release-lane procedure registry — Isola-Foundation / host03

Per `dec-c360-ops-procedure-registry-2026-09-05` and the Isola Agent Contract's
procedure-registry discipline: **an action performed a second way is a defect.**
Every procedure here was registered because the same operation was hand-rolled
more than once in this release lane, and each one carries its own proof step
so a stale procedure fails loudly instead of lying.

`isola-guard.js`'s `ad-hoc-fixture-teardown` rule refuses any new file that
writes `litePlanSubscription` state or `sipPasswordHash` directly, outside
`scripts/ops/` or real application source (`app/lib`, `app/api`). If you hit
that refusal, you are looking for one of the scripts below, not a new file.

This registry is split across two repos because each script imports and runs
against the repo whose modules and live substrate it actually needs — there is
no single checkout that has both. Each side's INDEX cross-references the
other.

## Registered here (Isola-Foundation / host03, Chatwoot + release-lane infra)

| Script | Governs | Why it exists |
|---|---|---|
| [`chatwoot-token-verify.ps1`](./chatwoot-token-verify.ps1) (+ [`chatwoot-token-verify-remote.sh`](./chatwoot-token-verify-remote.sh) companion) | Confirming `CHATWOOT_SERVICE_TOKEN` actually resolved on a live Foundation/C360 container | Was checked ad hoc, three different ways, across the PR #121/#122 promotion (boot-log grep, one-off DB query, one-off curl) — none of the three alone is proof; the token can be present in one layer and dead in another. |
| [`ancestry-check.ps1`](./ancestry-check.ps1) | Verifying a commit is a real ancestor of a target branch, from a machine with real `gh`/git history (host03 and deepseek have neither) | The deploy guard below requires this check's verdict be computed off-host and embedded as a Docker label before a build is trusted. Written once here so both the C360 and bff-v2 deploy guards call the same logic instead of two hand-rolled `gh api compare` calls. PowerShell, not bash — measured 2026-09-05 that WSL/Git-Bash calling `gh.exe` via interop hangs indefinitely on this machine, while the same `gh api` call runs natively from PowerShell in under a second; see the script's own header. |
| [`c360-remote-build.sh`](./c360-remote-build.sh) + [`c360-deploy.sh`](./c360-deploy.sh) | Building and deploying the Customer 360 UAT stack on host03, with an ancestry-verified guard | `dec-c360-deploy-ancestry-guard-2026-09-05`'s two-file guard (GUARD A: build-id-match against last-recorded state; GUARD B: refuses an image whose `isola.ancestry-verified` label is missing or not `YES`) existed only as loose per-build files on host03 with SHA hand-substituted at the top each time and no canonical copy anywhere — registered here 2026-09-05, parameterized to take the commit sha as an argument instead. Deploy this file's content to host03 (it must run there — see the script's own header) rather than hand-editing a fresh copy per build. |

## Registered in `epicdm/isolav2` (bff-v2, Lite fixtures)

See that repo's own `scripts/ops/INDEX.md` for the authoritative descriptions.
Named here so this side of the registry is discoverable without switching
repos:

| Script | Governs |
|---|---|
| `fixture-reset.ts` | Expiring a Lite fixture account's active plan subscriptions between test runs. |
| `fixture-credential-swap-smoke-test.ts` | Temporarily swapping a fixture's `sipPasswordHash`, calling one or more authenticated endpoints, restoring, and independently re-verifying the restore. |

Both were hand-rolled three separate times in one session
(`fixture_purchase.ts`, `fixture_purchase2.ts`, `fixture_purchase3.ts`) before
being registered — see that repo's INDEX for the full history.

## Adding a new procedure

Register here (or in the other repo, whichever owns the substrate the
procedure touches) instead of writing a one-off when:
- the same operation shape has been hand-written more than once, or
- the operation reads or mutates a governed-domain shape
  (`AD_HOC_FIXTURE_TEARDOWN_RE` in `.claude/hooks/lib/isola-topology.js`), or
- a future lane will predictably need to do this again.

A registered procedure must: take arguments rather than hardcoding a target,
refuse to run against anything off an explicit fixture/target allowlist where
the substrate is customer-facing, and end with an independent re-read that
fails loudly (non-zero exit, explicit `FAIL:` line) if the expected end state
was not actually reached — never trust a mutation's own return value as proof.
