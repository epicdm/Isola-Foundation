# Branch notes: UAT fixture assertion minter (feat/pl-assertion-minter-2026-10-03)

Cut from `97121920` (direct-hermes branch final head). Three commits: (1) the minter core, (2) wiring, (3) the standalone runner + these notes.
**UAT / fixture ONLY. This is NOT a production minter. Nothing here is deployed, applied or reviewed by Codex.**

## What exists
| piece | file |
|---|---|
| the minter (pure, no `node:fs`) | `src/assertion-minter.ts` |
| the provider ("this conversation IS the fixture") + boot cross-check | same file |
| the subject plumbing | `src/pipeline.ts` (computes the coherent subject once), `src/runtime.ts` (`AgentRuntimeRequest.channelSubject`), `src/hermes-runtime.ts`, `src/app.ts` (`assertions` dependency), `src/server.ts` (boot gate, default OFF) |
| a faithful port of the DEPLOYED verifier, as a test oracle | `test/pl-verifier-oracle.ts` |
| vectors for lane 59's offline re-verification | `test/fixtures/assertion-vectors.json` (23, synthetic only) |
| the standalone verification runner | `tools/mint-and-run.mjs` (outside `src/`) |

## Configuration (NAMES ONLY; no value is in the repo)
| variable | meaning |
|---|---|
| `GATEWAY_ASSERTION_ENV` | must be exactly `uat`, else the minter refuses to exist |
| `GATEWAY_ASSERTION_KID` | the key id, `^[a-z0-9]{1,16}$`, never `v1` (expected value `fxuat1`) |
| `GATEWAY_ASSERTION_PNID` | the synthetic UAT phone_number_id (expected `990000000017`), `^[0-9]{5,20}$`, REQUIRED, no default |
| `GATEWAY_ASSERTION_KEY_FILE` | PATH of the mounted Swarm secret holding the signing key (expected `/run/secrets/isolagwuat_pl_assertion_key_v1`) |
| `GATEWAY_ASSERTION_FIXTURE_WA_ID_FILE` | PATH of the mounted secret holding the ONE fixture wa_id (expected `/run/secrets/isolagwuat_pl_fixture_wa_id_v1`) |

**How the secrets are read (a deliberate deviation from "read in-process", and why).** The gateway's structural guarantee is that `node:fs` appears **nowhere in `src/`** (`test/no-direct-network.test.ts` scans for it; `entrypoint.sh` says why). So the gateway process does not open the files. The existing `entrypoint.sh` convention does it: `FOO_FILE=/run/secrets/x` becomes `FOO=<contents>` and `FOO_FILE` is unset, so after `exec` the process sees `GATEWAY_ASSERTION_KEY` and `GATEWAY_ASSERTION_FIXTURE_WA_ID`. **Deployment uses exactly the `*_FILE` names above; nothing in the stack file differs from what lane A specified.** `src/assertion-minter.ts` reads the two materialised variables. The standalone runner (outside `src/`) opens the files itself and calls the SAME validation (`assertionMinterFromTexts`), so the two cannot drift. Consequence to know: `entrypoint.sh` strips ALL trailing newlines (`$(cat)`), so a Swarm secret created with a trailing newline still works inside the gateway but the runner refuses that same file. **Create the key secret without a trailing newline (e.g. `printf %s "$KEY" | docker secret create ... -`)** so the gateway, the runner and the bff-v2 env all hold the same bytes.

If the boot sees ANY `GATEWAY_ASSERTION_*` variable it requires ALL of them: a half-configured minter, a non-`uat` environment, a minter with no `GATEWAY_HERMES_AGENT_IDS`, or one while `GATEWAY_CUSTOMER_SCOPE_MODE` is not `fixture` REFUSES to start (names only in the log). With none set it is `off` and the gateway is byte-for-byte what it was.

## How "this conversation IS the fixture" is decided
`conversation.contact_inbox.source_id` from the **signed** webhook payload, after the customer-scope coherence checks (the sender is the contact, and the `contact_inbox` is that contact's and this inbox's), is the only input. It is handed to the runtime only when the customer scope for the turn came back **verified**. The minter compares it, after dropping ONE leading `+` (digits only; spaces, dashes and brackets make it NOT the fixture), with the configured wa_id. **Never** from the message text, the transcript, the editable contact phone, or a model/tool argument. Any other sender, a missing subject, a missing message id, an unusable conversation identity or any minter failure gives `Isola assertion: none` and the business tools refuse. A different customer whose scope is verified also gets `none` (verified is not the same as fixture; tested).
`rid` signed = the very label the `Conversation id:` line carries (`igw1-<sha256>`, 69 chars); `mid` = the Chatwoot message id as a string; one assertion per inbound message, fresh nonce each.

## What the minter refuses, independently of every caller
- Any subject that is not the configured wa_id (no token, and the refusal never contains the subject).
- Any parameter that would carry a wa_id into the payload: there is none. The payload is a fixed list of seven fields (`kid, wa_id, pnid, rid, mid, iat, nonce`); `act` and `act_src` can never be emitted, even if a caller passes them.
- Construction when `GATEWAY_ASSERTION_ENV` is not `uat`; a key under 32 UTF-8 bytes or containing ANY whitespace, control or non-printable character (the verifier does not trim, so a silently trimmed key would sign with other bytes); a bad kid / pnid / wa_id.
- A repeated nonce (re-draw up to 4 times, then refuse), a short RNG output, a `rid` that is not 1..128 printable characters, a `mid` that is not 1..256 characters without controls.
- The object is redacted in `String()`, `JSON.stringify` and `util.inspect`, and has no member that returns the key or the wa_id. Errors carry variable NAMES only.

## Verification against the deployed verifier
Oracle = `bff-v2` deployed HEAD `d736dbf3ae0fde9f98b18eaa116ce4f9214eeb40`, `app/lib/pl-concierge/assertion.ts` (sha256 `9e0050cc233f2fc8c2b9ba1325b2304673adf2e61f964120b6dfb3745a9cd491`, last changed in `8db806aa`), plus the key/kid/pnid rules of `config.ts` (sha256 `23ee59aab4b2e53870982d9f5a3f0c2aafa296900bb46371b15432e0b2152082`), both read read-only on deepseek. Positive vector accepted; wrong kid, wrong key, wrong pnid, wrong rid, iat skew in both directions, `act` without `act_src`, oversize, bad wa_id / nonce / iat, flow-wiring literal all rejected with the verifier's own reason names (`bad_assertion{flow_wiring,malformed,unknown_kid,bad_signature,bad_fields}`, `stale_assertion`, `wrong_number`, `request_mismatch`).

### Differences between lane 59's C5 spec and the deployed verifier (every one I found)
1. **Freshness is symmetric.** `Math.abs(now - iat) > 120` is stale: an `iat` up to 120 s in the FUTURE is accepted. The spec says only "freshness 120 s". Operational: the clock of the minter's host and bff-v2's host must agree well inside 120 s minus the run time (the run deadline can be 85 s), so skew must stay under about 35 s.
2. **Unknown extra payload fields are ignored** by the verifier (forward compatible); the spec says "NO act". The verifier ACCEPTS `act` + `act_src`. The minter is stricter than the verifier: it cannot emit either.
3. **`kid = v1` is NOT rejected by the verifier** (`^[a-z0-9]{1,16}$` matches it); the contract says "deliberately not v1". The minter refuses it.
4. **The header value is trimmed** by the verifier (`raw.trim()`) before the `v1.` prefix and length checks; the 2048 limit is on the trimmed value.
5. **Nonce reuse is not an `assertion.ts` rule.** The service inserts `(nonce, op)` for MUTATING operations only (contract s.3.4 step 6, `409 replay`); reads never consume. "Never reused" is therefore a property of the minter, which is tested with the RNG-repeat cases; the vectors file says so.
6. **The key is raw UTF-8 and NOT trimmed** by the verifier (only the kid is trimmed); keys under 32 bytes are silently ignored (`unknown_kid`), not reported. The minter refuses whitespace anywhere in the key.
7. **Verification order** is signature (kid lookup first) -> fields -> freshness -> pnid allowlist -> rid, so a wrong `pnid` or `rid` on a validly signed token is reported as `wrong_number` / `request_mismatch`, never earlier.
8. **UNVERIFIED:** whether the service trims `X-Conversation-Id` before comparing with `rid` (the verifier takes it as given); the rate limit for reads (30 per minute per wa_id) is a service rule not tested here.

## NOT verified here
Live verifier behaviour (this is an offline port of the code as deployed on the date above); the secret mount path and the key bytes in the real Swarm secret versus bff-v2's env file (value-blind by design); the live Chatwoot payload carrying `contact_inbox` on `message_created` (UNVERIFIED on 4.18: if it does not, nobody is the fixture and every turn is `none`); the source gate and flags of pl-concierge; the end-to-end tool call with the real model.

## Running the runner (lane 59, on host03)
`node tools/mint-and-run.mjs --rid <conversation id> [--mid <id>] [--message "<text>"] [--dry-run] [--show-text]` with the environment in the file header. It imports the COMPILED modules, so build first in an isolated worktree (`npx tsc -p tsconfig.build.json` -> `dist/`); the runtime image does not ship `tools/`. It prints `kid, pnid, rid, mid, iat, nonce_length`, `hermes.host`, `run.status`, `run.output_chars` and (only with `--show-text`) the model text trimmed to 500 characters, with the token, the signature, the key, the bearer and the wa_id redacted everywhere. Exit 0 ok, 2 refused (nothing sent), 3 failed. Always run `--dry-run` first.

## PORT-READY paragraph
UAT fixture assertion minter built on `feat/pl-assertion-minter-2026-10-03` (3 commits from `97121920`), tests first with sabotage per behaviour; not deployed, not Codex-reviewed. `src/assertion-minter.ts` signs `v1.<P>.<S>` for ONE configured fixture wa_id only when `GATEWAY_ASSERTION_ENV=uat`; it cannot emit `act`/`act_src`, takes no wa_id from any caller, never reuses a nonce, and is redacted in every stringification. The key and wa_id arrive as mounted Swarm secrets materialised by `entrypoint.sh` (`GATEWAY_ASSERTION_KEY_FILE`, `GATEWAY_ASSERTION_FIXTURE_WA_ID_FILE`); the gateway itself imports no `node:fs`. The assertion line is supplied only when the signed payload's `contact_inbox.source_id` equals the fixture and the customer scope is verified; everyone else gets `none`. Verified offline against a port of bff-v2's deployed verifier (`d736dbf3a`, `assertion.ts` sha256 `9e0050cc...`) and 23 independent vectors; eight differences between the C5 spec and the verifier are listed above (symmetric freshness, `kid v1` accepted by the verifier, the verifier ignores extra fields and trims the header, nonce replay is a service rule). Default OFF; a half-configured minter refuses to boot. NOT verified: live verifier, real secret bytes, Chatwoot 4.18 sending `contact_inbox`. UAT/fixture only, never a production minter.
