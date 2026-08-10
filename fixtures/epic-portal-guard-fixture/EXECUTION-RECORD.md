# Execution record — epic-portal guard fixture

Sanitized record of the verified isolated integration test. Raw transcripts
and debug logs were retained only in disposable session scratch space and are
deliberately not committed (they contain per-run canary values and
machine-specific paths).

## Environment

| Item | Value |
|---|---|
| Claude Code version | 2.1.225 (native build), same binary for outer and nested sessions |
| Initial code under test | `cc3ea1233a2fa2281a51625fc666bd4577180d14` |
| Corrected code | `dc979630adace6055e373e96a0ecba14af4363d7` |
| Execution date | 2026-08-10 |
| Execution mode | Nested headless sessions (`claude -p`) — the execution environment's stdin/stdout were redirected pipes (no TTY), so the interactive TUI could not render; a headless session is the same session engine (project settings, permission rules, hooks, strict MCP) minus the TUI |

## Launcher argument proof

`launch.ps1` was run against a stub `claude` on PATH that recorded its argv
and exited. Recorded working directory: the fixture `workspace/`. Recorded
arguments, verbatim:

```
--setting-sources project --permission-mode default --strict-mcp-config --mcp-config <absolute path to mcp-config.generated.json>
```

The generated config registered exactly one server, `epic-portal`, as
`node` + this checkout's `server/epic-portal-fixture-server.js` — no URL, no
token, no environment variables. All subsequent nested runs used these same
arguments plus headless-mode flags (`-p`, output/format flags, and a
permission-prompt-tool for the approval run).

## Results

### 1. Ask rule — PASS
With no approval granted, the nested session's attempt to call
`mcp__epic-portal__execute_query` returned the permission error
"Claude requested permissions to use mcp__epic-portal__execute_query, but
you haven't granted it yet" and was recorded in the session's
`permission_denials`. The tool never executed. Debug output confirmed the
deny/ask rules loaded from the fixture's project settings, the
managed-settings location was checked and none existed, and the connected
server identified itself as `epic-portal-fixture 0.0.0-fixture` (the
placeholder, not production).

### 2. Single-call approval method
`--allowedTools` proved insufficient — the `ask` rule takes precedence over
allow-listing, a finding in its own right. The approval was instead granted
through Claude Code's `--permission-prompt-tool` mechanism: a
session-scoped harness tool that allows exactly one
`execute_query(procedure=listProjects)` permission request and denies
everything else, including any second request. This is the headless
equivalent of clicking Approve once. Nothing was persisted: no
`settings.local.json` was created, no "Always allow" anywhere, and no
project entries were added to user-level configuration.

### 3. Defect observed at `cc3ea123…` — then fixed
On the first approved run, the approval was consumed, the tool executed,
and the PostToolUse hook fired and replaced the tool output with the exact
correct projection — then Claude Code crashed consuming the replacement
(`e.reduce is not a function` in its content-block accounting). Root cause:
for an MCP tool, `updatedToolOutput` must be an array of content blocks
(`[{type:"text", text}]`); the hook emitted a bare object. Direction was
fail-closed — the canary never reached the model — but the projection never
arrived either. No unit test could catch this harness-consumption contract;
only the live execution did. Fixed at `dc979630…`: the hook now emits the
projection (and the safe placeholder) as a single text content block, with
the size-bound tests recalibrated for the new envelope and a dedicated
wire-shape test added.

### 4. Corrected projection — PASS (exact)
On the rerun after the fix, the tool result the nested model received was,
character-for-character:

```json
{"procedure":"listProjects","result":[{"name":"fixture-project","createdAt":"2026-01-01T00:00:00.000Z"}]}
```

Only `name` and `createdAt` survived. The fixture server's planted
`nestedSecret` object did not appear anywhere in the model-visible
transcript.

### 5. Canary exclusion — PASS
The fixture server generates a fresh random canary each run and prints it
only to its own stderr (captured out-of-band in the harness debug log as
ground truth). The exact per-run canary value was verified absent from the
entire model-visible transcript in every run — including the defect run,
where the crash still did not leak it. The nested model, asked directly,
answered NO to having seen any `FIXTURE_CANARY_`-prefixed string.

### 6. Deny precedence — PASS, without execution
A direct `tools/list` probe proved the fixture server advertises all four
tools, including `execute_mutation` and `execute_destructive`. A nested run
was then launched with a deliberately maximally permissive
permission-prompt tool (one that approves anything it is asked). Even so,
the two denied tools were absent from the model's tool schema entirely —
the model reported it could not construct a call to them. The server's
distinctive execution-marker string appeared nowhere (they never executed),
and the approval layer was never consulted for them: the deny rules
short-circuit before any approval flow.

## Deviations and limitations

- Headless (`-p`) nested sessions instead of an interactive TUI: forced by
  the redirected-pipe environment (proven, not assumed). The interactive
  path remains available via `launch.ps1`.
- `/hooks` and `/permissions` are TTY-only dialogs and could not be
  rendered; replaced by debug-load evidence (rules applied from project
  settings; hook "replaced tool output") plus behavioral proof.
- The single-call approval used `--permission-prompt-tool` rather than a
  TUI click; the harness approver lived in disposable scratch space and is
  not part of this fixture.
- The defect fix was committed mid-execution (at `dc979630…`) because
  completing the verification required it.
- Not proven by this fixture: production epic-portal behavior, upstream
  telemetry, `PostToolUseFailure` handling, and the production PreToolUse
  allowlist (covered separately by `.claude/hooks/selftest.js`).

## Final local test state

`node .claude/hooks/selftest.js` at the corrected code: **135/135 passing**,
with the production hook and this fixture's hook copy byte-identical.
