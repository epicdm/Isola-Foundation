# MCP plan — approved connections for Isola engineering

Inventoried 2026-07-25 from the live session. Classification is a **trust and blast-radius
judgement**, not a statement of what the server can technically do.

| Class | Meaning |
|---|---|
| **Read-only** | Cannot change Isola state. Safe to leave connected. |
| **Controlled write** | Can write, but only to systems where writes are recoverable and audited. |
| **Production-sensitive** | Can affect live customer-facing state. Keep, but gate every mutating call. |
| **Rejected / not trusted** | Do not connect for Isola engineering work. |

## Approved core set

| Server | Class | Rationale and limits |
|---|---|---|
| **Port.io** (`mcp__claude_ai_Port_IO__*`) | Controlled write | The authority for product truth. Writes are the point. Never put secrets in a Port field. Do not mark packets Done/Accepted — acceptance is the owner's. |
| **ssh-deepseek** (`mcp__ssh-deepseek__*`) | **Production-sensitive** | Direct access to every live checkout and service. Every call passes `isola-guard`; builds in live checkouts, secret dumps, destructive ops and Meta mutations are blocked, restarts require confirmation. Prefer `ssh-read-lines` / `ssh-search-code` over `remote-ssh` for inspection. |
| **Context7** (`mcp__context7__*`) | Read-only | Library/API documentation. Preferred over web search for framework questions. |
| **claude-in-chrome** | Read-only in practice | Browser automation for UAT evidence and screenshots. Never use it to drive a production admin surface or submit a real payment. |

## Requested but not yet connected

| Server | Class | Recommendation |
|---|---|---|
| **GitHub MCP** | Controlled write | **Worth adding.** Today PR work goes through the `gh` CLI. A scoped GitHub MCP (read PRs/issues/checks; no admin, no settings, no branch-protection changes) would make `/isola-pr-review` and release verification cleaner. Requires a token with `repo` + `workflow`; note the repo's GitHub identity is `epicdm` and it is the sole admin. Until connected, `gh` remains the path. |
| **Sentry / monitoring** | Read-only | **Worth adding when monitoring exists.** There is currently no error-monitoring service wired to Isola. Connect read-only once one exists; it would give `/isola-incident` real signal instead of log spelunking. |
| **Replit MCP** | Production-sensitive | **Retired as a deploy path** — see the correction below. Read-only inspection only; never trigger a deploy. |

### Correction, 2026-09-02 — the Vercel/Replit row was wrong, and prescriptively so

The row above previously read: *"**Vercel** … Only relevant to `app.isola.epic.dm`. The
main app deploys via Replit, not Vercel. Keep **disconnected** for Isola engineering."*

Both halves were wrong by the time they mattered, and the guidance would have blocked real
work — a session following it would have kept the Vercel MCP disconnected and been unable
to execute the 2026-09-02 deploy-hook dispatch at all.

- **The customer PWA deploys via Vercel, not Replit.** `isola-connect`
  (`epicdm/isola-connect-3fb9b312`) is a Vercel project serving `app.isola.epic.dm`.
  `[measured 2026-09-02]`
- **Replit is retired as a deploy path** — `decision-no-further-replit-publish-2026-08-12`,
  `dec-correction-foundation-replit-retired-deploy-model-stale-2026-08-29`. See CLAUDE.md §6.

**Current standing:** the Vercel MCP is **connected and in scope** for the PWA. It remains
**production-sensitive** — treat reads (`list_deployments`, `get_project`, domain inspect)
as normal, and gate anything that mutates: `deploy_to_vercel`, domain add/remove/move, and
billing tools stay outside an engineering packet unless a dispatch names them. Deploy-hook
creation and secret storage were executed on 2026-09-02 under an explicit owner dispatch,
which is the bar.

For where the PWA actually lives and how the sign-in redirect resolves, see
`docs/isola/PERSONAL-LINE-TOPOLOGY.md`.

## Connected but out of scope for engineering work

Leave connected for other workflows; do not use them inside an Isola engineering packet
without an explicit reason.

| Server | Class | Note |
|---|---|---|
| Gmail, Google Calendar, Google Drive | Controlled write | Customer/owner communications. Sending mail is customer contact — owner-only. |
| Figma | Read-only | Design source; fine for UI convergence reference. |
| Telegram plugin | Production-sensitive | Reaches the owner's real channel. Never use it to relay unverified findings. |
| IcePanel | Read-only | Architecture diagrams. |
| Vibe Prospecting | **Rejected for engineering** | Prospecting/enrichment tool. No engineering use; it touches third-party personal data. Do not invoke from an engineering session. |

## Rules for adding any MCP server

1. **Do not connect a server merely because it is available.** Every server is added
   context, added attack surface, and added ways to touch production by accident.
2. Prefer read-only scopes. If a write scope is needed, name the specific tool that needs
   it and why the write is recoverable.
3. Never grant a server credentials that exceed what one packet needs.
4. Third-party servers outside this table are **not trusted** until reviewed — an MCP
   server can see every argument it is passed, including anything an agent pastes.
5. Record the addition in Port with the scope granted and who authorized it.

## Subagent access

Subagents inherit only the tools listed in their frontmatter. Current grants:

- `production-verifier` — the only agent with any deepseek access, and only read-shaped
  inspection; every call still passes the guard.
- `port-reconciler` — the only agent with Port write access.
- All other agents — local filesystem and `git` reads only. No agent has Replit, Vercel,
  Gmail, Telegram or browser access.
