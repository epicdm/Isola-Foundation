# CCO agent-lane review package — for Lane A — 2026-09-18

**Preserved, not merged, not deployed.** This file is the handoff. AGENT lane
does not merge or deploy this work; Lane A reviews and decides.

## Exact target

- **Repo:** `epicdm/Isola-Foundation`. **Checkout:** shared primary checkout
  `C:\epic-workspace\Isola-Foundation` (per
  `isola-foundation-worktree-2026-09-03`, new AGENT work moves to its own
  worktree from here forward — this branch is left exactly as committed).
- **Branch:** `feat/agent-lane-cco-business-briefing-2026-09-18`.
- **HEAD:** `5b69daa` — working tree on this branch has no uncommitted
  changes to the CCO delta.
- **Bounded delta (the CCO-specific commit range):** `6415dc3..5b69daa`
  (`6415dc3`, `7f403f6`, `681f2a3`, `0eb7fee`, `ad2932e`, `5b68753`,
  `b81d21b`, `5b69daa`) — 22 files, +3422/−24. (`git diff --stat main...HEAD`
  is NOT the right measure here: this checkout's `main` is hundreds of
  commits behind on unrelated services; use the commit range above.)
- **Re-verified this session:** `services/isola-runtime` — `npx vitest run`
  → **447/447 passing, 26/26 files**, matching the commits' own claim
  (independently re-run, not taken on the commit message's word).

## What this delta does

Read-only Odoo business briefing for the internal CCO agent
(`epic-staff-operations-coordinator@v1`), plus a caller-identity mechanism
so the briefing route and the runtime invocation are keyed to a specific
authenticated agent, not a shared class bearer:

- `artifacts/isola/lib/workspace/business-briefing.ts` +
  `app/api/workspace/team/[agentId]/briefing/route.ts` — Odoo company
  authorization derived from the credential's own ACL (fixed in `0eb7fee`
  away from row self-consistency).
- `artifacts/isola/lib/workspace/cco-agent-binding.ts` +
  `cco-invoke.ts` — resolves the owner-selected CCO agent by
  `(tenantId, paperclip_agent_id)` identity, not by template match (`5b69daa`).
- `services/isola-runtime/src/agent-caller-proof.ts` + `auth.ts` + `config.ts`
  — an agent-bound bearer credential mechanism, reusing (not forking)
  PR #139's PUBLIC-side `credentialAgentId` mechanism, extended
  symmetrically to INTERNAL exposure (`b81d21b`).

## THE CONTRADICTION — flagged, not fixed by this session

**Claim, as written in `services/isola-runtime/src/agent-caller-proof.ts`
lines 58–62 (quoted exactly):**

> NO INSECURE FALLBACK. There is no branch in this function, or in its
> caller in app.ts, that treats a missing or mismatched proof as anything
> other than a refusal — no legacy code path, no "unless this is Paperclip"
> exception. A gated template's ONLY route to invocation is a caller whose
> own credential proves the agent identity it claims.

**That sentence is true only for a template already IN
`requiredForTemplateIds`.** Membership in that set is NOT mandatory for the
CCO template — it is a plain operator opt-in:

- `config.ts`: `agentCallerProofRequiredTemplateIds` is built from
  `RUNTIME_AGENT_CALLER_PROOF_REQUIRED_TEMPLATES`, defaulting to
  `DEFAULT_AGENT_CALLER_PROOF_REQUIRED_TEMPLATES = ""` — **empty by
  default.**
- Nothing in this delta, and nothing in
  `artifacts/isola/templates/employees/epic-staff-operations-coordinator/v1/`
  (`.paperclip.yaml`, `isola-sidecar.json`), sets that env var or otherwise
  lists `epic-staff-operations-coordinator@v1` in the required set. Checked
  directly (`grep -r RUNTIME_AGENT_CALLER_PROOF_REQUIRED_TEMPLATES`) — no
  deploy config anywhere proposes turning this on for CCO.
- `app.ts`'s gate calls `verifyAgentCallerProof` with
  `requiredForTemplateIds: config.agentCallerProofRequiredTemplateIds`. When
  the CCO template is absent from that set, `verifyAgentCallerProof` returns
  `not_required` and the request proceeds on the pre-existing shared
  `RUNTIME_SECRET_INTERNAL` class bearer alone — the exact fallback the
  module doc says does not exist.
- **`5b69daa`'s own commit message says this plainly**, describing
  `lib/engines.ts`'s `bearerForAgent`: *"No per-agent secret configured
  falls back to the plain shared INTERNAL bearer — exactly today's
  behaviour for every other template, and the runtime's own gate (not this
  code) is what refuses that for an opted-in template."* The commit message
  is honest about this; the module doc-comment's "NO INSECURE FALLBACK"
  header is not qualified by it.

**Direct precedent this delta did not carry over.** PR #139
(`feat/isola-runtime-business-facts-connection-2026-09-17`, same repo,
draft) shipped the *identical* opt-in shape for the PUBLIC-side mechanism
this one reuses (`agentsRequiringCallerProof`), and the owner explicitly
rejected it — see
`.checkpoint-out/pkt-isola-revenue-checkpoint2-2026-09-17/handover-agent-lane-pr139-mandatory-caller-proof-2026-09-17.md`:
*"Caller-bound protection verified when configured. Business-facts-enabled
agents without that protection remain vulnerable."* PR #139 was corrected at
commit `cd13db9` to make caller-proof **unconditional** for every agent
present in `businessFactsMap` — no opt-in exception. This branch's INTERNAL
side (`agent-caller-proof.ts`) reintroduced the same opt-in shape the owner
already ruled out once, on the sibling PUBLIC mechanism it explicitly reuses.

**What this means concretely today:** as shipped on this branch, and with
no deploy configuration anywhere proposing otherwise, a caller holding only
the shared `RUNTIME_SECRET_INTERNAL` bearer — which, per this same delta's
own module doc, is *"embedded in every Paperclip hire's `adapterConfig`
regardless of which agent it is"* — can invoke
`epic-staff-operations-coordinator@v1` and receive a live, tenant-scoped
Odoo business briefing under a claimed `agentId` the bearer does not prove.
The mechanism to close this exists and is tested (14 + 7 + 7 = tests cited
above, independently re-run green), but it is inert until an operator sets
`RUNTIME_AGENT_CALLER_PROOF_REQUIRED_TEMPLATES` (and populates
`RUNTIME_INTERNAL_AGENT_CALLER_SECRETS`) — a step this delta neither takes
nor documents as required.

**Per the owner's direction on this handoff: the new CCO path must refuse
missing proof regardless of optional legacy-template settings.** That is
NOT the current state, and this session did not change it — Lane A decides
whether to (a) hardcode `epic-staff-operations-coordinator@v1` into the
required set unconditionally (matching PR #139's `cd13db9` correction), (b)
require the env var as a boot-time precondition specifically for this
template, or (c) something else. Until one of those lands, **do not
describe this delta as having closed the CCO impersonation gap** — it built
the mechanism and left applying it to CCO as a configuration step nobody
has taken or required.

## Reuse note carried over from the plan (isola-current-plan v7.30)

*"Preserve the corrected direct-model versus AgentOS distinction"* and *"no
merge/configuration/hire/deploy/live invocation/binding exists and no Agno
involvement is proven"* — both still true of this exact HEAD; nothing in
this session changed that.

## CODEX REVIEW RECEIPT — added 2026-09-18, per directive-isola-codex-review-gate-2026-09-18

Ran `codex exec --sandbox read-only` (codex-cli 0.154.0) against the bounded
delta twice: once against `6415dc3..5b69daa` (author review), once as a
re-review of the fix commit alone (`5b69daa..1d064eb`). Full transcripts in
the session scratchpad; summarized here.

**Author-review findings (3):**

1. **CONFIRMED, matches my own finding above** — the opt-in caller-proof gap.
   Not fixed by this pass: it needs an operator/config decision
   (RUNTIME_AGENT_CALLER_PROOF_REQUIRED_TEMPLATES + the boot-warning it
   already triggers), not a code change. Still Lane A's to resolve, per the
   section above.
2. **High, NEW, FIXED this pass** — `resolveCcoAgentBinding` trusted a
   `linked` portal response's `paperclip_agent_id` without checking it
   matched the *requested* `paperclipAgentId`. Fixed at commit `1d064eb`
   (`cco-agent-binding.ts`): a mismatch is now refused
   (`linked_state_agent_id_mismatch`), same shape as the pre-existing
   `linked_state_missing_ids` guard. 19/19 tests pass (1 new regression),
   186/186 across `lib/workspace/` unaffected, tsc clean.
3. **High, NEW, NOT FIXED — flagged for Lane A/owner** — `business-briefing.ts`'s
   `resolveAuthorizedCompany` derives Odoo company scope from Foundation's
   *stored* `binding.login`, not from the API key's own Odoo-proven identity.
   Verified: Odoo JSON-2 (`engines/odoo.ts`) authenticates purely by
   `Authorization: bearer <apiKey>` — `login` is never sent to Odoo and
   nothing on Odoo's side verifies it names the apiKey's real owner. If
   `binding.login` drifts or is wrong, company-scope authorization is
   computed from a *different* Odoo user's row than the credential actually
   belongs to. **No safe code-only fix exists** — re-confirmed on re-review:
   the only purely code-side safe option is fail-closed/unavailable, not a
   real fix; closing this properly needs a live-Odoo-verified "who does this
   credential authenticate as" mechanism, which this session could not
   safely design or test without live Odoo API access. Left open,
   deliberately, rather than shipped as an unverified guess.

**Re-review of the fix (commit `1d064eb`):** "No additional findings —
finding #2 closed." Confirmed `askCco` only proceeds on a `linked` result
and forwards `selected.agentId` (never a client-suppliable value) to both
the runtime call and `bearerForAgent`; confirmed every caller collapses the
new `linked_state_agent_id_mismatch` detail the same way as existing
`unreachable` outcomes; confirmed finding #3's reasoning holds.

**Net effect on this handoff's own status:** finding #1 (the fallback
contradiction) is UNCHANGED by this pass — still Lane A's to resolve, as
this file already said. Finding #3 is a second, independently-confirmed
reason not to consider CCO ready to invoke live yet, beyond #1.

## PORT

PORT: read isola-current-plan (v7.33, Active) for the codex-review-gate
directive and the standing CCO-parallel/no-merge/no-deploy constraint; read
`handover-agent-lane-pr139-mandatory-caller-proof-2026-09-17.md` for the
PUBLIC-side precedent finding #1 repeats · wrote
`ev-agent-lane-codex-review-pr142-2026-09-18` (this receipt) and the
`cco-agent-binding.ts` fix at `1d064eb` (pushed,
`feat/agent-lane-cco-business-briefing-2026-09-18`, PR #142, still
unmerged/undeployed) — Lane A's own review should record its verdict in
Port against this branch/HEAD when it lands.
