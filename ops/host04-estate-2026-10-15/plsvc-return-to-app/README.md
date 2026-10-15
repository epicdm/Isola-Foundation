# Return to the Cloud Softphone app after a card attempt (2026-10-15)

Owner report: after the first real payment the "Open" link landed on a signed-out PWA page. Owner ruling: return the payer to the Acrobits (Cloud Softphone) app.

- plsvc image `localhost:5000/pl/plsvc@sha256:b6e4c0bcc8974b2efe41e9d183fa16918e01a9be82a1e584e2cae0139816f510` (base = tree of 71df5e72 + the 8 files in `0001-plsvc-return-to-app.patch`, commit 5e5b661 in the local plsvc work tree). Rollback: `REVERSE=1 NEW_IMAGE=<that digest> python scripts/owner-run/zz-plsvc-return-cutover.py` (-> 71df5e72, image-only, env untouched).
- New public page `GET /go/back` launches `cloudsip:` (Acrobits docs, Call URIs: Cloud Softphone = `cloudsip`). The pay page (Vercel, project `isola`) redirects declined/error payers to returnUrl after 4 s, so the page makes NO payment-outcome claim.
- `mintPaymentLink` defaults `returnUrl` to it only when `liteAccountId` is set and none was passed.
- Adapter copy `pl-action-adapter.topupcopy-74ebf732.mjs` (installed over 49cb2e13 with `zz-adapter-topup-copy-install.sh`, redeployed with zz-migrate-22; rollback = `... rollback` + redeploy): replaces the false "top-ups aren't available yet" with the true statement. Harness 28/28; the old sentence restored fails 3 checks.
- Validation: isolated vitest 128/128; sabotage (default-return removed) fails exactly the default-return test. Codex review: SHIP (`codex-review-SHIP.txt`).
