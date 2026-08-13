# Verification method — handoff, 2026-08-13

Rules earned during one session, each by being violated first. They are ordered by how much
time they cost when ignored.

---

## 1. Four claims, not one: built · deployed · correctly targeted · verified doing real work

"It's already built" is a **source-code observation** and nothing more. On the escalation
engine, all four separated cleanly:

| Claim | How it was settled |
|---|---|
| **Built** | The code exists in the working tree |
| **Deployed** | `ConversationOwnershipTransition` rows exist in prod — the engine *ran* |
| **Correctly targeted** | Foundation's writes land on deepseek account 5, proven by bot-attributed activity, not by an env var name |
| **Verified doing real work** | **Failed.** The step that puts a human on the conversation is a Chatwoot automation rule, not Foundation |

Three of four passed. The fourth was the one that mattered. Never let a source read answer any
of the other three.

## 2. Verify as the process sees it, never as the host sees it

A `soul.md` edit was verified four ways on the host — sha256, diff, byte-identical
substring, permissions — and none of that would have proved anything. The container reads
`/data/agents`, a bind mount. The only check that settled it was reading the file **from
inside the container** and matching the hash.

**The near-miss worth remembering:** had `STORAGE_BACKEND` been `s3` with
`STORAGE_LOCAL_FALLBACK_ENABLED=true`, the same host edit would have been served
*intermittently* — S3 first, that directory only on miss — while every host-side check still
passed. Intermittent correctness is far worse than plain failure, and no amount of host-side
verification detects it.

## 3. A positive control before any negative claim

An empty result and a broken query are indistinguishable. This changed the answer **four
times** in one session:

- `81b38cd6` returned 0 rows on host03. A control on the same query shape returned 4 real
  agents → true negative → the agent was found on deepseek.
- Foundation traffic on host03's Chatwoot returned nothing. The control — the same sweep for
  EMA's id — returned 8+ hits → the negative was real.
- A grep for an assignment API call returned nothing. The control found 8 hits in the same
  file → Foundation genuinely never assigns.
- **The one that nearly landed a false conclusion:** three verification queries returned 0
  rows and were about to be read as "the ownership engine never ran". The control showed the
  database held **zero conversations ever** — it was dev.

## 4. Which database, before which answer

Foundation's Replit **workspace shell** has `DATABASE_URL` → `helium/heliumdb` (**dev**,
0 conversations, last activity two weeks stale). Prod is `neondb`, reached via the
**`NEON_PROD_URL`** env var (100 conversations, 17 transitions, 423 audit rows).

`neon.txt` on disk is **stale** — right host, right database, right role, dead password. A
stale credential file naming the correct host is more dangerous than no file, because the
natural fallback is `DATABASE_URL`, which is dev, and dev returns clean zeros.

## 5. A truncated enumeration looks exactly like a complete one

`find … | head -20` over a tree containing **735** soul files reported "no file contains that
phrase". Twenty template files filled the twenty slots. The conclusion was confidently wrong
and cost two dead-end searches.

Count the enumeration, or re-derive it without the limit, before drawing a negative from it.

## 6. Re-use the exact predicate that produced the hit

A `grep -rli` found the target file. A follow-up `grep -n` on that same file — **without
`-i`** — returned nothing, briefly contradicting the finding. When a narrowing query
disagrees with the query that found the evidence, suspect the query, not the evidence.

## 7. `wc -l` is not the number of lines

A guarded edit aborted cleanly because it asserted 41 lines; the file had **42** and no
trailing newline. `wc -l` counts newline characters. The guard did its job precisely because
the assertion was exact — a loose one would have written into a file it had mis-modelled.

## 8. Publish-success is not served-code

Replit reported `status: success` on the live deployment. That is the same signal that shipped
green on CB-0 while serving pre-fix code. Publish state proves a deployment exists, never what
is in it.

Corollary: **do not grep the Replit workspace to learn what is served.** Replit publishes
workspace *files*, and workspace and trunk diverge — a workspace read answers what publishes
*next*. The instrument for "what is running" is behavioural: a row that only the code in
question could have written.

## 9. Two authentication attempts, then stop

A production auth endpoint rejected a credential twice. The third attempt would have taught
nothing; the second already distinguished "wrong password" from "wrong protocol". Stop and go
looking for the right credential instead.

## 10. Counters do not mean what their names suggest

**75 `EscalationRef` rows against 7 actual escalations.** Refs are minted per *turn* as a
capability token, not per escalation. Anyone reading ref counts as escalation volume overstates
it by an order of magnitude. Check what increments a counter before reporting on it.

## 11. A test that cannot fail is worse than no test

Acceptance check E3 ("assignment fails → no customer message") assumes Foundation performs the
assignment. It does not — a Chatwoot automation rule does. If that rule were disabled,
Foundation would still record success and **E3 would still pass**. It reads as coverage and
provides none. Rewritten, not run.

Same family: an acceptance suite recording fewer checks than the contract names must fail the
gate, and NOT-RUN is never PASS.

## 12. Redact inside the read, never after

`printenv | grep` was blocked by the guard, correctly — it would have printed secret values to
reach two non-secret ones. The narrow form (resolve the four named settings, print only those)
returned the same answer safely. Report database **name and host**, never a connection string;
report variable **names** and a short prefix, never values.
