# plsvc narrow pay-page credential (2026-10-15)
Running image: `localhost:5000/pl/plsvc@sha256:71df5e7259545999be41fdd89444f549cc5c2c4b7c684b368b0a91943bc04827` (rollback: `REVERSE=1 NEW_IMAGE=<that digest> python scripts/owner-run/zz-plsvc-paypage-cutover.py` -> image 1354bf93, key removed).
Defect: the hosted pay page said "something went wrong" because plsvc answered its payment-link lookup 401 - it sends the frontend credential (ISOLA_INTERNAL_SECRET on the old bff) and plsvc only knew INTERNAL_SECRET.
Fix: `validatePayPageSecret` (env `PL_PAYPAGE_SECRET`, value = the frontend credential, copied value-blind) accepted ONLY by `GET /api/internal/payment-link/[token]` and `POST .../charge`. Deliberately NOT `ISOLA_INTERNAL_SECRET` on plsvc (would open every internal route to the frontend credential).
Review: first pass DO NOT SHIP (accepted-scope not documented, weak controls, env whitespace) -> all resolved -> second pass SHIP (verdicts in this folder).
Tests: `test/payment-link-paypage-secret.test.ts`; 86/86 in 7 files; sabotage and wide-credential controls fail exactly the intended tests.
