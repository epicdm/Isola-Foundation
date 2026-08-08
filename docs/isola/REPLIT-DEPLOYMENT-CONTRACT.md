# Replit deployment contract

What must be true for this repository to deploy on Replit Autoscale, why, and what enforces it.

Written after `inc-isola-replit-postbuild-pnpm-store-prune-2026-08-07` — four consecutive
promote failures across six builds, ~14 hours. Every fact below is either cited to Replit's
own documentation or to an observed build, and each is labelled which.

---

## The rule that prevents a repeat

**Separate DOCUMENTED from UNDOCUMENTED before touching the deployment.** They demand
opposite responses:

- **Documented** → read it and comply. Do not experiment. Half of that outage was a
  documented requirement we violated, and no experiment was ever needed to know it.
- **Undocumented** → do not reverse-engineer it. Design so the answer does not matter.
  The other half was an undocumented mechanism we depended on; the fix was to stop
  depending on it, not to decode it.

---

## C1 — the runtime must bind `0.0.0.0` · DOCUMENTED

> "Autoscale and Reserved VM deployments only support a single external port being exposed,
> and for the corresponding internal port not to be using `localhost`."
> — [docs.replit.com/references/project-setup/ports](https://docs.replit.com/references/project-setup/ports)

Replit's own publishing checklist likewise says to verify the server
["listens on 0.0.0.0"](https://docs.replit.com/build/troubleshooting).

**The trap.** Cloud Run injects `HOSTNAME` set to the container's *external-routed* IP
(e.g. `34.117.33.233`). That address is handled by the load balancer and is bound to no
local interface. Next.js standalone does:

```js
const hostname = process.env.HOSTNAME || 'localhost'
server.listen(port, hostname)
```

So a launcher that forwards `process.env` unchanged binds an unavailable address and dies
instantly with `EADDRNOTAVAIL` (observed: build `b0978062`).

**The rule.** Any spawn of standalone `server.js` MUST set `HOSTNAME: '0.0.0.0'` in the
child env. Passing `process.env` through untouched is the bug.

---

## C2 — `register()` must not block the listener · OBSERVED

Next.js awaits `instrumentation.ts` `register()` **before** opening the HTTP port. Anything
slow inside it directly delays port detection.

Observed on build `59bff226`: ~20 sequential Prisma calls against a cold Neon endpoint
consumed 20–60s of a **~108s promote window**, on top of ~30–50s extracting an uncompressed
85.5 MB archive. The port never opened in time and nothing promoted.

**The rule.** Fire long work and return: `void runSeedingBackground()`. Keep every seed
idempotent and individually try/caught, and keep `/api/healthz` independent of seeding state.

---

## C3 — the runtime payload must be unmatchable by `.replitignore` · UNDOCUMENTED

**`.replitignore` has no official documentation.** Checked 2026-08-08: nothing on
docs.replit.com, nothing in Context7's Replit corpus, and the single community thread
(`ask.replit.com/t/…/61831`) now 301-redirects to a landing page.

Observed behaviour, from real publishes:

- Patterns match at **any depth**. A bare `node_modules` also strips
  `.deploy/isola/node_modules`; `artifacts/isola/.next` also strips
  `.deploy/isola/artifacts/isola/.next`.
- `!` re-inclusion does **not** rescue descendants already matched by an earlier rule.
  A trailing `!.deploy` was shipped in build `b202729` specifically to test this. It failed.
- Roughly 2,496 of 2,520 staged isola files were stripped this way. `server.js` arrived;
  `next` did not.

**Why api-server was never affected** — and this asymmetry is the fingerprint of the bug:
its payload is a single flat esbuild bundle at `.deploy/api-server/index.mjs`, containing no
path segment any rule can match. It opened its port on every single failed build.

**The rule.** Ship the isola runtime as **one archive** whose path matches no rule
(`.deploy/isola-standalone.tar`, gzipped) and extract it at start. This holds regardless of
which ignore dialect Replit implements, which is the point.

---

## Also true, and easy to get wrong

- **Migrations belong in the build or pre-deploy step**, not runtime startup —
  [docs.replit.com/help/database](https://docs.replit.com/help/database). The runtime
  container has no `node_modules`, so no Prisma CLI. Consequence: a migration lands *before*
  promotion, and promotion can fail — so **a production migration must stay
  backward-compatible with the currently live release**. See
  `artifacts/isola/prisma/migrations/README.md`.
- **Promote-phase stdout IS captured**, including through `pnpm run`. "The collector is
  dropping our logs" was wrong and cost hours. A launcher that `console.log`s is a working
  diagnostic channel — add one early.
- **Failures chain and mask each other.** Fix in phase order: build → promote → runtime.
  A bind error cannot be diagnosed while files are still missing.
- **The Replit workspace is NOT a checkout of GitHub trunk.** The Replit Agent commits
  directly in the workspace; the two diverge silently, and trunk has held the *broken* half
  while the workspace held the working one. Before any reconcile, run
  `git merge-base --is-ancestor` in **both** directions and confirm which head is deployed.

---

## What enforces this

| Enforcement | Runs when | Covers |
|---|---|---|
| `guard-replit-deploy-contract.mjs` | **every deployment build** — first step of `pnpm --filter @workspace/isola run build`, fails closed | C1, C2, C3 |
| `pnpm run sim:runtime-image` | on demand | full build → filter → runtime boot, with a hostile `HOSTNAME` and the ~108s promote budget asserted |
| `pnpm --filter @workspace/isola test` | on demand | pinned contract assertions |

The guard is the load-bearing one. This repository has no CI, no lint and no CODEOWNERS —
a guard only runs if it is chained into a `package.json` script, so anything opt-in will
eventually be skipped by whoever is in a hurry.

**A simulator can only refute, never confirm.** When it and a real publish disagree, the
publish wins — ours passed while production failed, because it modelled the filesystem and
ignored the environment.
