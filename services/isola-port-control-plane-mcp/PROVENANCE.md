# Provenance

- Upstream: `isola-port-control-plane-mcp`, deepseek `/home/epicdm/isola-port-control-plane-mcp`, commit `fe39521` (2026-07-16, "fix(portClient): always re-check token freshness before reuse"), exported with `git archive` (read-only). The live deepseek service (pm2 `port-io-mcp`, 127.0.0.1:8890) is NOT modified by this change.
- Adapted 2026-10-07 by the Internal Agent lane for the host03 Hermes (plan `plan-internal-agent-hermes-host03-canonical-2026-10-07`): stdio transport, credential files, five more allowlisted blueprints, `read_record`/`list_records`, value-level secret scrub, stricter free-text phone mask. The read-only chokepoint (`guardedRequest`) is unchanged except for the `envFallback` constructor option.
- Tests: 76 pass, 1 skipped (POSIX credential-file-mode warning; skipped on Windows). All offline against a local mock; the mock's response shapes are assumed from the existing client code and have not yet been checked against the live Port API.
- No credentials are stored in this directory. Credentials are supplied at run time as files (`PORT_CLIENT_ID_FILE`, `PORT_CLIENT_SECRET_FILE`).
