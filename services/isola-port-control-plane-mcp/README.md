# isola-port-control-plane-mcp

A private, **read-only** remote MCP (Model Context Protocol) server that lets
ChatGPT (or any other MCP client) inspect Isola's Port.io control plane —
release board, gates, blockers, decisions, and pilot readiness — without any
risk of it mutating anything.

## Why this exists

Port.io is Isola's project/build tracker (the "brain"). Giving an external
AI client the ability to *read* it is useful (status checks, "what's
blocking the release," "what did we decide"). Giving it the ability to
*write* to it is not something we want to risk, even accidentally, even if
the underlying Port API credential were misconfigured with write scope.

So this server enforces read-only-ness **in code**, at the HTTP client
layer (see `src/portClient.ts` — the `guardedRequest()` chokepoint), not by
trusting that the Port credential handed to it is correctly scoped. See
`docs/SECURITY-REVIEW.md` for the full threat model.

## What it exposes

10 MCP tools, all read-only, all funneled through:
read-only Port client -> entity-type allowlist -> redaction -> audit log
-> pagination/size-cap -> response.

1. `get_release_board` — derived Release Train 01 board (Port has no
   `release_gate` blueprint; this server composes it from
   `build_task`/`requirement`/`defect`/`epic_project` entities).
2. `list_open_gates` — board rows that are not green/done.
3. `get_gate_evidence(gate_id)` — evidence + staleness (>7 days) for a gate.
4. `list_open_blockers` — open defects + P0-MVP backlog tasks, ranked.
5. `list_decisions` — all `decision` entities, newest first.
6. `list_release_tasks` — `build_task` entities where status != Done.
7. `list_pilot_readiness` — honest state; pilot candidates are always an
   empty structured list (none named in Port yet); never customer content.
8. `list_recent_port_activity` — Port audit log if available, else a
   fallback derived from allowlisted-blueprint entities by `$updatedAt`.
9. `get_entity(id, blueprint)` — single entity, blueprint must be
   allowlisted, governance-metadata fields only, post-redaction.
10. `search_port(query)` — contains-match search via Port's
    `POST /v1/entities/search` (the one allowlisted search POST),
    restricted server-side to allowlisted blueprints.

## Known live Port facts this server was built against

(Verified live by a prior session; this server does not re-query Port to
"confirm" these — see code comments in `src/releaseTrain01.ts`.)

- Blueprints: `decision` (14 entities), `build_task` (251 entities),
  `requirement` (14 entities), `defect` (21 entities).
- Confirmed entity ids: `bt-release-control-implementation` (Backlog),
  `bt-device-b-external-p8` (Backlog), `bt-clawith-staging-credential`
  (Backlog), `bt-pilot-consent-execution` (Backlog), `bt-pr22-disposition`
  (Backlog), `req-p00-unified-wa-send-gate` (Verified),
  `req-p00-external-p8-evidence` (Blocked),
  `decision-d29-pstn-not-whatsapp-optin` (exists),
  `defect-w2-unconsented-wa-send-2026-06-12` (exists).
- Port org is EU-hosted: default `PORT_API_BASE_URL` is `https://api.port.io`.
  A US-org alternative exists at `https://api.us.port.io` — set the env var
  if this server is ever pointed at a US-hosted Port org. Do not guess;
  wrong region = auth/lookup failures.

## Running locally

```bash
npm install
npm run build
MCP_BEARER_TOKEN=<your-generated-token> \
PORT_CLIENT_ID=<port-client-id> \
PORT_CLIENT_SECRET=<port-client-secret> \
npm start
```

- `MCP_BEARER_TOKEN` is **required**. There is no default; if unset, every
  request is rejected (fail closed). Generate one yourself, e.g.
  `openssl rand -hex 32`.
- `PORT_CLIENT_ID` / `PORT_CLIENT_SECRET` are optional. If absent (or if
  Port is unreachable), every tool degrades gracefully and returns
  `{"status":"port_unavailable_or_stale", "detail": "..."}` instead of
  throwing or crashing.
- `PORT_API_BASE_URL` optional, defaults to `https://api.port.io`.
- `PORT` optional, defaults to `8890`. Server binds to `127.0.0.1` only.

Once running:

```bash
curl http://127.0.0.1:8890/healthz
# {"ok":true}
```

The MCP endpoint is `http://127.0.0.1:8890/mcp` (Streamable HTTP
transport). All requests to `/mcp` require `Authorization: Bearer
<MCP_BEARER_TOKEN>` or receive `401`.

## Running tests

```bash
npm test
```

Runs the full Vitest suite (mocked Port fixtures — no live Port
credentials required). See the project handoff report for the actual
pass/fail table from the last run (47/47 passing at time of writing).

## Deploy notes

This server is **localhost-bind-only** (`127.0.0.1:8890`) by design. It is
NOT internet-facing on its own. To expose it as
`https://portmcp.epic.dm/mcp` for ChatGPT's custom-connector UI, a human
must add:

- an nginx (or equivalent) reverse proxy terminating TLS and forwarding
  to `127.0.0.1:8890`,
- DNS for `portmcp.epic.dm`,
- process supervision (systemd/pm2/etc. — this repo intentionally does
  NOT touch any existing pm2/nginx setup; see hard boundaries below).

See `docs/CHATGPT-PORT-CONNECTION-HANDOFF.md` for the full connection
handoff and `docs/SECURITY-REVIEW.md` for the threat model.

## Hard boundaries this codebase respects

- Never writes to Port (enforced in code, see `src/portClient.ts`).
- Never touches `/opt/bff-v2` or any pm2/nginx/DNS configuration.
- No secrets committed anywhere — all credentials are env-var only.
- Ephemeral test runs are localhost-only, backgrounded, and killed +
  verified gone.

## Repo layout

```
src/
  portClient.ts     read-only-enforced Port HTTP client (the chokepoint)
  redact.ts         PII redaction + entity-type allowlist
  audit.ts          append-only JSONL audit log (data/audit.log)
  auth.ts           bearer auth, rate limiting, pagination, size cap
  releaseTrain01.ts static gate definitions mapped to real Port entity ids
  tools.ts          the 10 MCP tools
  server.ts         MCP Streamable HTTP server + /healthz
test/               Vitest suite (mocked Port, no live creds needed)
docs/
  CHATGPT-PORT-CONNECTION-HANDOFF.md
  SECURITY-REVIEW.md
data/audit.log      append-only audit trail (gitignored; created at runtime)
```


## Internal Agent mode (stdio)

A second transport for an EPIC-internal agent (Hermes). Same tool set, same
read-only client, allowlist, scrub, audit and size caps as the HTTP server, but:
**no network listener and no HTTP bearer** - the process boundary is the
authentication (only the parent that spawned the process holds its stdin/stdout).
Never bridge this process's stdio onto a socket.

```bash
npm ci && npm run build
npm run start:stdio        # node dist/stdio.js
```

Environment (names only; never commit values):

| Variable | Meaning |
|---|---|
| `PORT_CLIENT_ID_FILE`, `PORT_CLIENT_SECRET_FILE` | Absolute paths to files holding just the value (trailing newline trimmed). Preferred: Hermes strips the env it passes to MCP subprocesses. If set, the file is authoritative; missing/empty/unreadable => fail closed (no fallback to env). On POSIX a warning (path only) is printed to stderr if the file is group/world accessible. |
| `PORT_CLIENT_ID`, `PORT_CLIENT_SECRET` | Used only when the matching `*_FILE` is unset. |
| `PORT_API_BASE_URL` | Default `https://api.port.io`. |
| `PORT_MCP_AUDIT_LOG` | Default `./data/audit.log` (relative to the process cwd). Params hash only, never values. |

Missing credentials: the process still starts and answers `tools/list`; every data
tool returns `{"status":"unavailable","reason":"credentials_not_configured"}`.
stdout carries only MCP frames; diagnostics (credential *source* status only) go to stderr.

### Registering in Hermes (`config.yaml`)

```yaml
mcp_servers:
  port_control_plane:
    command: node
    args: ["/ABS/PATH/isola-port-control-plane-mcp/dist/stdio.js"]
    env:
      PORT_CLIENT_ID_FILE: /ABS/PATH/to/port_client_id
      PORT_CLIENT_SECRET_FILE: /ABS/PATH/to/port_client_secret
      PORT_MCP_AUDIT_LOG: /ABS/PATH/to/audit.log
    tools:
      include:
        - read_record
        - list_records
        - search_port
        - get_entity
        - list_decisions
        - list_open_blockers
        - list_recent_port_activity
```

(`env` holds file paths only, not credential values. Credential files: mode 600, owned by the Hermes user.)

### Tools

`read_record(blueprint, id, offset=0, max_chars=12000)` - one allowlisted record with
free-text fields paged under `texts` (hard cap 20000 chars/field/call; follow
`next_offset`). Scrubbing happens on the whole field before paging.
`list_records(blueprint, status?, title_contains?, sort='updated_desc', limit=25, offset=0)` -
structured scalars only (status, version, severity, launch_criticality, last_reviewed,
captured_at, decided_at, ...), limit capped at 50. Port's search has no sort/limit, so
filtering is re-applied and sorting/paging done server-side over at most the first 1000
matches (`scan_truncated` flags more). The Release Train 01 tools are kept and marked LEGACY.

### Rollback

Remove the `port_control_plane` entry from Hermes `config.yaml` and restart the gateway;
nothing else changes (no listener, no state, no Port writes ever). Revoke/rotate the Port
credential if needed. HTTP mode is unaffected.

### What is NOT exposed

Any write to Port (enforced in `guardedRequest`: only GET, POST `/v1/auth/access_token`,
POST `/v1/entities/search`); any blueprint outside the allowlist (e.g. `customer`,
`contract`); conversation-like fields (`body`, `message`, `transcript`, `content`, `text`);
secret-looking keys; secret-shaped values in any string (bearer/JWT/PEM/key shapes/
assignments/connection strings/unlabelled long hex-base64); unmasked emails and E.164-style
phone numbers in free text; any network listener.
