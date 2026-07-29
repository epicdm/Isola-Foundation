/**
 * stage-classifier.ts — one canonical reading of an Odoo stage name.
 *
 * WHY THIS EXISTS. `STAFF_START_STAGE_NAME` was a single global stage name
 * (`In-Progress`) matched EXACTLY against the task's own project. Odoo stage
 * names are per-project free text, so on `Dragon Windows - Vendor Workboard`
 * — whose stages are `In Development` / `Under Investigation` — the lookup
 * found nothing, the move silently failed, and the staff member was still told
 * "✓ Started." That is a record reading stronger than what happened, which is
 * the exact defect class this packet exists to eliminate
 * (`def-spine-start-reports-started-without-odoo-stage-move-2026-07-29`).
 *
 * A global NAME cannot fit every board. A CONCEPT can. Every place that needs
 * to reason about "where is this work" now asks this module, so the stage move
 * and the reply menu can never disagree about the same record.
 */

/** What a stage MEANS, independent of what a project chose to call it. */
export type StageConcept = 'new' | 'active' | 'blocked' | 'terminal' | 'unknown'

/** Lowercase and collapse separators, so `In-Progress` and `in progress` agree. */
export function normStage(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[\s_\-/]+/g, ' ').trim()
}

/**
 * Classify a stage name.
 *
 * Order is deliberate and load-bearing: terminal wins over everything, because
 * mistaking a closed task for an open one invites action on finished work.
 * Blocked outranks active, because `Blocked - In Development` is blocked.
 * `unknown` is a real answer, not a failure — callers must handle it
 * conservatively rather than guessing.
 */
export function classifyStage(name: string | null | undefined): StageConcept {
  const s = normStage(name)
  if (!s) return 'unknown'

  if (/\b(done|solved|closed|cancelled|canceled|complete|completed|delivered|resolved|rejected)\b/.test(s)) {
    return 'terminal'
  }
  if (/\bblock|\bon hold\b|\bhold\b|\bwaiting\b|\bstalled\b|\bparked\b|\bpaused\b/.test(s)) {
    return 'blocked'
  }
  if (/progress|doing|active|wip|development|developing|investigation|investigating|review|reviewing|testing|qa|started|ongoing|implement/.test(s)) {
    return 'active'
  }
  if (/\b(new|inbox|to do|todo|backlog|assigned|open|triage|queued|pending|ready)\b/.test(s)) {
    return 'new'
  }
  return 'unknown'
}

/** True when the record is somewhere a staff member can still act on it. */
export function isOpenConcept(c: StageConcept): boolean {
  return c !== 'terminal'
}
