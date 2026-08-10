# epic-portal guard fixture — isolated integration proof

This fixture has been **executed end-to-end and passed**. See
[EXECUTION-RECORD.md](./EXECUTION-RECORD.md) for the sanitized record of the
verified runs, including the real integration defect the first execution
exposed and the fix that followed. `launch.ps1` remains available as an
**optional interactive reproduction path** — it is not required work.

## Verified history (summary)

- Initial headless execution at `cc3ea1233a2fa2281a51625fc666bd4577180d14`
  exposed a real defect: the PostToolUse hook emitted `updatedToolOutput` as
  a bare object, which Claude Code applied and then crashed consuming
  (MCP tool output must be a content-block array). Fail-closed in direction
  — nothing leaked — but the projection never reached the model.
- The defect was fixed at `dc979630adace6055e373e96a0ecba14af4363d7` and the
  corrected fixture was rerun successfully.
- **All four fixture claims passed** (approval gate, outright deny, matcher
  reach, exact projection with canary exclusion).
- The TTY-only `/hooks` and `/permissions` views could not be rendered in
  the redirected-pipe execution environment; they were replaced by
  settings/hook debug-load evidence plus behavioral proof, which is
  stronger (it shows the rules and hook actually firing, not just listed).

## Scope — what this fixture does and does not cover

This fixture tests **the permission backstop and the PostToolUse output
projection**. Specifically, the four verified claims:

1. `mcp__epic-portal__execute_query` requires approval (the `ask` rule fires).
2. `mcp__epic-portal__execute_mutation` / `execute_destructive` are denied
   outright, before any approval prompt.
3. A `listProjects` call reaches the exact real PostToolUse matcher
   (`mcp__epic-portal__execute_query`) and gets projected.
4. Nested synthetic credentials attached to the fixture response never reach
   what Claude shows — only `name` and `createdAt` survive.

**The production PreToolUse procedure allowlist is NOT exercised by this
fixture.** That guard (`isola-guard.js` and its policy module) is covered by
`.claude/hooks/selftest.js` in the main workspace, which spawns it directly
the way Claude Code does. It is deliberately absent here: the PreToolUse
stack carries real infrastructure paths, a real host address and real asset
identifiers as policy constants, and copying it in would violate this
fixture's placeholder-only requirement. Its absence here does not weaken the
real production guard, which remains registered in the main workspace's
`.claude/settings.json` unchanged.

## What this is

- `server/epic-portal-fixture-server.js` — a placeholder-only local stdio MCP
  server. No production URL, token, or registration anywhere in it. It
  advertises `search_procedures`, `execute_query`, `execute_mutation`, and
  `execute_destructive` under the exact server name `epic-portal`, so the real
  hook matcher and the real permission rules are exercised for real. The
  mutation/destructive tools ARE implemented (trivially) — they exist so a
  session can actually attempt to call them, which is what proves the deny
  rule blocks them, not because they're expected to ever run.
- `workspace/.claude/hooks/isola-easypanel-output-guard.js` — an exact copy of
  this PR's PostToolUse hook. It has **no external dependencies** (no
  `require()` calls at all), so this single file is the entire hook payload
  the fixture needs.
- `workspace/.claude/settings.json` — the epic-portal permission rules
  (`deny` on mutation/destructive, `ask` on `mcp__epic-portal__*`, no allow
  rule) plus the PostToolUse registration. No PreToolUse registration.
- `mcp-config.template.json` — shows the exact registered shape for review.
  Not consumed directly; `launch.ps1` generates the real
  `mcp-config.generated.json` (git-ignored) next to it at run time, with the
  server path resolved to this checkout's actual absolute path — nothing
  machine-specific is committed.
- `launch.ps1` — one-command interactive launcher. Resolves every path itself
  from its own location. Verified to construct exactly the documented
  invocation (proven against a stub `claude` that recorded its argv).
- `EXECUTION-RECORD.md` — the committed, sanitized record of the verified
  headless execution.

## Optional interactive reproduction

Not required — the claims below are already verified (see
EXECUTION-RECORD.md). To reproduce interactively anyway:

```powershell
.\launch.ps1
```

Run it from anywhere; it resolves its own paths from `$PSScriptRoot` and
invokes:

```
claude --setting-sources project --permission-mode default --strict-mcp-config --mcp-config <generated-config>
```

Then, in the fresh session:

1. Run `/hooks` — confirm `isola-easypanel-output-guard.js` shows as loaded
   for PostToolUse with matcher `mcp__epic-portal__execute_query`.
2. Run `/permissions` — confirm `mcp__epic-portal__*` requires approval
   (ask), and `mcp__epic-portal__execute_mutation` /
   `execute_destructive` show as denied.
3. Ask Claude to call `execute_mutation` or `execute_destructive` with any
   procedure name. Expected: refused outright — no approval prompt appears.
4. Ask Claude to call `execute_query` with procedure `listProjects` and empty
   input; approve the permission prompt when it appears (that prompt firing
   IS itself a pass signal for step 2).
5. Check the result Claude shows against the exact expected value below.
6. Ask Claude: "did the result contain any string starting with
   `FIXTURE_CANARY_`?" — the honest answer should be no. (The canary is
   generated fresh by the fixture server each run and printed to the local
   terminal by the fixture server's own stderr — Claude itself should never
   see or report it.)

## Exact expected model-visible result

The hook returns the projection as a single text content block whose text is
(and this was verified character-for-character in the recorded execution):

```json
{"procedure":"listProjects","result":[{"name":"fixture-project","createdAt":"2026-01-01T00:00:00.000Z"}]}
```

No `nestedSecret`, no `token`, no `password`, no canary, and no additional
field of any kind may survive.

## Managed settings caveat

`--setting-sources project` restricts which settings FILES load for a
session — but managed/enterprise policy settings, if any exist on the
machine, can still apply on top regardless of this flag. In the recorded
execution, the managed-settings location was checked by Claude Code and none
existed; on a different machine that could differ.

## Still not proven by this fixture

- The production PreToolUse procedure allowlist (out of scope here — see
  **Scope** above; covered by `.claude/hooks/selftest.js`).
- Whether the real production epic-portal server itself behaves identically
  to this fixture (it's a placeholder, not a live call to the real service).
- Upstream telemetry on the real EasyPanel/epic-portal side — unreachable
  from this fixture or from Claude Code at all.
- `PostToolUseFailure` behavior (a tool call that errors) — not exercised.

## Cleanup

- `mcp-config.generated.json` is git-ignored — safe to leave or delete;
  `launch.ps1` regenerates it every run.
- Nothing here touches or references the real epic-portal registration,
  URL, or token at any point.
