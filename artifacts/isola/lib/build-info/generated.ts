/**
 * GENERATED FILE — do not edit by hand.
 *
 * Written by `artifacts/isola/scripts/generate-build-info.mjs`, which runs as the
 * first step of `pnpm --filter @workspace/isola run build`, before `next build`.
 *
 * The value committed here is the DEVELOPMENT placeholder. It is tracked on
 * purpose, so that `next dev`, `tsc` and `vitest` always resolve this module —
 * and so that if the generator ever fails to run in a production build, what
 * ships is a value `/api/health` refuses to serve as provenance rather than a
 * plausible-looking identity. Fail closed by default, not by configuration.
 */
import type { BuildInfo } from './contract'

export const BUILD_INFO: BuildInfo = {
  schema: 1,
  mode: "development",
  source_sha: null,
  source_tree: null,
  source_dirty: false,
  built_at: null,
}
