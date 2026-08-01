/**
 * The API's rejection sentence, in the words this screen uses.
 *
 * THE DEFECT
 * ----------
 * A refused filter reached the reader as:
 *
 *     The filter Records per page was refused: pageSize may not exceed 100
 *
 * Half of that was translated and half was not. The PARAMETER field went
 * through `parameterLabel`, but the API's own `detail` string was printed
 * verbatim -- and the API writes its details by naming the query parameter:
 * `pageSize may not exceed 100`, `occurredTo is not a date`,
 * `status is not a valid identifier`. So the raw parameter name came back out on
 * the same line as its own translation, and `pageSize` is not written anywhere
 * on this screen for a reader to go and change
 * (defect-activity-raw-parameter-name-in-error, part 2).
 *
 * WHY THIS IS NOT A BLIND FIND-AND-REPLACE
 * ----------------------------------------
 * Several parameter names are also ordinary English words that the API uses AS
 * English in the same sentences: "…is not a source this endpoint reads",
 * "…is not a filter this endpoint implements". Rewriting every occurrence of
 * `source` would turn the first into "is not a System this endpoint reads",
 * which is worse than the defect. Two rules, both narrow:
 *
 *   1. A detail that OPENS with a known parameter name is the API naming the
 *      thing it refused. That leading token is replaced.
 *   2. camelCase names (`pageSize`, `occurredTo`, `eventFamily`, …) cannot be
 *      English prose, so they are replaced wherever they appear.
 *
 * Anything else is left EXACTLY as the API wrote it. A detail this table has
 * never heard of must still reach the reader unchanged: swallowing it would
 * leave a refusal with no reason attached, which is the failure the detail
 * exists to prevent.
 */

import { parameterLabel } from "./labels"

/**
 * The keys of PARAMETER_LABELS in `labels.ts`, which is the one place the words
 * themselves live -- this list names them, it does not redefine them, and every
 * label below is resolved through `parameterLabel`.
 *
 * `parameter-detail.test.ts` reads labels.ts and fails if the two ever diverge,
 * so a parameter added there without being added here is a red test rather than
 * a raw name quietly reappearing on screen.
 */
export const PARAMETER_NAMES = [
  "source",
  "eventFamily",
  "ownershipState",
  "status",
  "occurredFrom",
  "occurredTo",
  "customer",
  "actor",
  "pageSize",
  "cursor",
  "company",
  "filter",
] as const

const KNOWN = new Set<string>(PARAMETER_NAMES)

/** Names that contain an uppercase letter cannot be a word in an English clause. */
const UNAMBIGUOUS = PARAMETER_NAMES.filter((name) => /[A-Z]/.test(name))

/**
 * Substitutes known parameter names in an API `detail` with their screen labels.
 * Returns the input unchanged when it names nothing this screen knows about.
 */
export function humaniseDetail(detail: string | null | undefined): string {
  const raw = (detail ?? "").trim()
  if (!raw) return ""

  let out = raw

  // Rule 1: the leading token, when it is a parameter name.
  const leading = /^[A-Za-z][A-Za-z0-9_]*/.exec(out)?.[0]
  if (leading && KNOWN.has(leading)) {
    out = parameterLabel(leading) + out.slice(leading.length)
  }

  // Rule 2: camelCase names anywhere in the sentence.
  for (const name of UNAMBIGUOUS) {
    out = out.replace(new RegExp("\\b" + name + "\\b", "g"), parameterLabel(name))
  }

  return out
}
