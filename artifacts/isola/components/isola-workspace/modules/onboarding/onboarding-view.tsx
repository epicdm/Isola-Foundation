/**
 * Isola Workspace — the onboarding view.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ------------------------------------
 * "Connected" is not "working". Creating an account or wiring an integration NEVER counts as a
 * pass. A stage only reaches `proved` when a real message, a real login or a real change
 * happened and the owning system confirmed it; it only reaches `accepted` when the customer
 * then signed that off.
 *
 * That is why `setup` and `proved` may never share a colour OR a mark. They are the two states
 * an implementer is most tempted to conflate, and conflating them is how a tenant goes live
 * with a channel nobody ever sent a message through.
 *
 * The eleven verification checks are rendered in full, always. A shortened list is a shortened
 * proof, and the list is the entire argument that this tenant works.
 *
 * Pure presentation. No hooks, no state, no fetching.
 */

import { cn } from '@/lib/utils'
import type {
  OnboardingStage as OnboardingStageData,
  OnboardingStageState,
  OnboardingState,
  VerificationCheck,
  VerificationStatus,
} from '@/lib/isola-workspace/adapters/ports'

import { Inset, ModuleButton, ModuleCard, SectionLabel } from '../shared'

// ── Stage vocabulary ────────────────────────────────────────────────────────

interface StageVisual {
  mark: string
  chip: string
  meaning: string
  markClass: string
  chipClass: string
}

/**
 * Six states, six meanings, and no two that an operator could confuse.
 *
 * `setup` is a warn dot; `proved` is an ok tick — a different glyph AND a different family, so
 * neither colour-blindness nor a greyscale print can collapse them. `accepted` reuses the tick
 * because it IS proved-and-signed-off, but carries the accent family and its own chip word.
 */
const STAGE_VISUAL: Record<OnboardingStageState, StageVisual> = {
  notStarted: {
    mark: '·',
    chip: 'NOT STARTED',
    meaning: 'Nothing has been done yet.',
    markClass: 'text-[var(--iso-fg-3)]',
    chipClass:
      'text-[var(--iso-fg-3)] border-[var(--iso-border)] bg-[var(--iso-surface-2)]',
  },
  setup: {
    mark: '•',
    chip: 'SET UP',
    meaning: 'Configured, but never tested for real. This is not the same as working.',
    markClass: 'text-[var(--iso-warn)]',
    chipClass:
      'text-[var(--iso-warn)] border-[var(--iso-warn-border)] bg-[var(--iso-warn-soft)]',
  },
  proved: {
    mark: '✓',
    chip: 'PROVED',
    meaning: 'A real test passed and the owning system confirmed it.',
    markClass: 'text-[var(--iso-ok)]',
    chipClass: 'text-[var(--iso-ok)] border-[var(--iso-ok-border)] bg-[var(--iso-ok-soft)]',
  },
  accepted: {
    mark: '✓',
    chip: 'ACCEPTED',
    meaning: 'Proved, and then signed off by the customer.',
    markClass: 'text-[var(--iso-accent-fg)]',
    chipClass:
      'text-[var(--iso-accent-fg)] border-[var(--iso-accent-ring)] bg-[var(--iso-accent-soft)]',
  },
  blocked: {
    mark: '−',
    chip: 'BLOCKED',
    meaning: 'Waiting on a named person. Nothing has been attempted.',
    markClass: 'text-[var(--iso-block)]',
    chipClass:
      'text-[var(--iso-block)] border-[var(--iso-block-border)] bg-[var(--iso-block-soft)]',
  },
  failed: {
    mark: '×',
    chip: 'FAILED',
    meaning: 'Tried for real and did not work.',
    markClass: 'text-[var(--iso-err)]',
    chipClass: 'text-[var(--iso-err)] border-[var(--iso-err-border)] bg-[var(--iso-err-soft)]',
  },
}

const STAGE_STATE_ORDER: readonly OnboardingStageState[] = [
  'notStarted',
  'setup',
  'proved',
  'accepted',
  'blocked',
  'failed',
]

// ── OnboardingStage ─────────────────────────────────────────────────────────

export function OnboardingStage(props: {
  stage: OnboardingStageData
  isCurrent: boolean
  className?: string
}) {
  const visual = STAGE_VISUAL[props.stage.state]
  return (
    <button
      type="button"
      data-intent={`onboarding.select:${props.stage.id}`}
      aria-current={props.isCurrent ? 'step' : undefined}
      className={cn(
        'flex w-full min-w-0 items-start gap-[8px] rounded-[var(--iso-radius-md)] p-[8px_9px] text-left',
        props.isCurrent
          ? 'bg-[var(--iso-accent-soft)] border border-[var(--iso-accent-ring)]'
          : 'bg-[var(--iso-surface)] border border-[var(--iso-border)] hover:bg-[var(--iso-surface-2)]',
        props.className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex h-[19px] w-[19px] flex-none items-center justify-center text-[13px] leading-none',
          visual.markClass,
        )}
      >
        {visual.mark}
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-[1px]">
        <span className="break-words text-[12.5px] font-medium leading-[1.3] text-[var(--iso-fg)]">
          {props.stage.name}
        </span>
        <span className="break-words text-[11px] leading-[1.4] text-[var(--iso-fg-3)]">
          {props.stage.note}
        </span>
      </span>

      <span
        className={cn(
          'flex-none whitespace-nowrap rounded-[var(--iso-radius-sm)] border px-[5px] py-[1px] text-[9.5px] font-semibold',
          visual.chipClass,
        )}
      >
        {visual.chip}
      </span>
    </button>
  )
}

// ── Legend and responsibility ───────────────────────────────────────────────

function StageLegend() {
  return (
    <ModuleCard as="section" className="gap-[6px]">
      <SectionLabel>What each mark means</SectionLabel>
      <ul className="flex min-w-0 list-none flex-col gap-[5px] p-0">
        {STAGE_STATE_ORDER.map((state) => {
          const visual = STAGE_VISUAL[state]
          return (
            <li key={state} className="flex min-w-0 items-start gap-[7px]">
              <span
                aria-hidden="true"
                className={cn(
                  'flex h-[15px] w-[13px] flex-none items-center justify-center text-[12px] leading-none',
                  visual.markClass,
                )}
              >
                {visual.mark}
              </span>
              <span className="flex min-w-0 flex-col gap-[1px]">
                <span
                  className={cn(
                    'w-fit rounded-[var(--iso-radius-sm)] border px-[5px] py-[1px] text-[9.5px] font-semibold',
                    visual.chipClass,
                  )}
                >
                  {visual.chip}
                </span>
                <span className="break-words text-[11px] leading-[1.4] text-[var(--iso-fg-2)]">
                  {visual.meaning}
                </span>
              </span>
            </li>
          )
        })}
      </ul>
      <p className="break-words text-[11px] leading-[1.45] text-[var(--iso-fg-3)]">
        Creating an account or connecting a service never counts as a pass. Every proof records a
        real message, a real login or a real change.
      </p>
    </ModuleCard>
  )
}

function WhoIsDoingThis(props: { stages: readonly OnboardingStageData[] }) {
  const assigned = props.stages.filter((stage) => stage.responsible)
  return (
    <ModuleCard as="section" className="gap-[6px]">
      <SectionLabel>Who is doing this</SectionLabel>
      {assigned.length ? (
        <ul className="flex min-w-0 list-none flex-col gap-[4px] p-0">
          {assigned.map((stage) => (
            <li key={stage.id} className="flex min-w-0 flex-col gap-[1px]">
              <span className="break-words text-[11.5px] font-medium leading-[1.35] text-[var(--iso-fg)]">
                {stage.responsible}
              </span>
              <span className="break-words text-[11px] leading-[1.4] text-[var(--iso-fg-3)]">
                {stage.name}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="break-words text-[11px] leading-[1.45] text-[var(--iso-fg-2)]">
          No step is waiting on a named person right now.
        </p>
      )}
    </ModuleCard>
  )
}

// ── VerificationChecklist ───────────────────────────────────────────────────

interface CheckVisual {
  mark: string
  word: string
  markClass: string
  wordClass: string
  pulse?: boolean
}

const CHECK_VISUAL: Record<VerificationStatus, CheckVisual> = {
  passed: {
    mark: '✓',
    word: 'Passed',
    markClass: 'text-[var(--iso-ok)]',
    wordClass: 'text-[var(--iso-ok)]',
  },
  failed: {
    mark: '×',
    word: 'Failed',
    markClass: 'text-[var(--iso-err)]',
    wordClass: 'text-[var(--iso-err)]',
  },
  notRun: {
    mark: '·',
    word: 'Not run',
    markClass: 'text-[var(--iso-fg-3)]',
    wordClass: 'text-[var(--iso-fg-3)]',
  },
  running: {
    mark: '◦',
    word: 'Running',
    markClass: 'text-[var(--iso-info)]',
    wordClass: 'text-[var(--iso-info)]',
    pulse: true,
  },
}

export function VerificationChecklist(props: {
  checks: readonly VerificationCheck[]
  className?: string
}) {
  // Never sliced, never filtered. The whole list IS the proof.
  const checks = props.checks
  const passed = checks.filter((check) => check.status === 'passed').length
  const failed = checks.filter((check) => check.status === 'failed')

  return (
    <section
      className={cn(
        'flex min-w-0 flex-col rounded-[var(--iso-radius-lg)] border border-[var(--iso-border)] bg-[var(--iso-surface)]',
        props.className,
      )}
    >
      <ul className="flex min-w-0 list-none flex-col p-0">
        {checks.map((check) => {
          const visual = CHECK_VISUAL[check.status]
          return (
            <li
              key={check.id}
              className="flex min-w-0 items-start gap-[8px] border-t border-[var(--iso-border)] p-[8px_11px] first:border-t-0"
            >
              <span
                aria-hidden="true"
                className={cn(
                  'flex h-[17px] w-[17px] flex-none items-center justify-center text-[12px] leading-none',
                  visual.markClass,
                  visual.pulse && 'iso-pulse',
                )}
              >
                {visual.mark}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-[1px]">
                <span className="break-words text-[12.5px] font-medium leading-[1.35] text-[var(--iso-fg)]">
                  {check.name}
                </span>
                {/* The EVIDENCE, not a restatement of the check. */}
                <span className="break-words text-[11px] leading-[1.4] text-[var(--iso-fg-3)]">
                  {check.note}
                </span>
              </span>
              <span
                className={cn(
                  'flex-none whitespace-nowrap text-[11px] font-semibold',
                  visual.wordClass,
                )}
              >
                {visual.word}
              </span>
            </li>
          )
        })}
      </ul>

      <footer className="flex min-w-0 flex-col gap-[7px] border-t border-[var(--iso-border)] p-[10px_11px]">
        <p className="break-words text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">
          {passed} of {checks.length} checks passed.
          {failed.length
            ? ` ${failed.length} did not: ${failed.map((check) => check.name).join('; ')}.`
            : ''}
        </p>
        {failed.length ? (
          <>
            <Inset family="err" heading="Why it failed">
              {failed[0]?.note}
            </Inset>
            <div className="flex min-w-0 flex-wrap gap-[6px]">
              <ModuleButton
                label="Run the check again"
                intent="onboarding.rerun-checks"
                tone="accent"
              />
            </div>
          </>
        ) : null}
      </footer>
    </section>
  )
}

// ── Step body ───────────────────────────────────────────────────────────────

function StepBody(props: { state: OnboardingState; stage: OnboardingStageData | undefined }) {
  const stage = props.stage
  if (!stage) {
    return (
      <ModuleCard as="section" className="gap-[4px]">
        <p className="text-[12.5px] font-semibold text-[var(--iso-fg)]">Pick a step</p>
        <p className="break-words text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">
          Choose a step on the left to see what is outstanding and who it is waiting on.
        </p>
      </ModuleCard>
    )
  }

  const visual = STAGE_VISUAL[stage.state]

  return (
    <div className="flex min-w-0 flex-col gap-[12px]">
      <header className="flex min-w-0 flex-col gap-[4px]">
        <div className="flex min-w-0 flex-wrap items-center gap-[7px]">
          <h2 className="break-words text-[18px] font-semibold leading-[1.25] text-[var(--iso-fg)]">
            {stage.name}
          </h2>
          <span
            className={cn(
              'flex-none whitespace-nowrap rounded-[var(--iso-radius-sm)] border px-[6px] py-[1px] text-[9.5px] font-semibold',
              visual.chipClass,
            )}
          >
            {visual.chip}
          </span>
        </div>
        <p className="break-words text-[12px] leading-[1.45] text-[var(--iso-fg-2)]">
          {stage.note}
        </p>
        <p className="break-words text-[11px] leading-[1.45] text-[var(--iso-fg-3)]">
          {visual.meaning}
        </p>
      </header>

      {/* A blocked step must NAME the person and say what is needed. "Blocked" on its own tells
          an operator that they are stuck without telling them who can unstick them. */}
      {stage.state === 'blocked' ? (
        <Inset family="block" heading="Waiting on a person">
          {stage.responsible
            ? `${stage.responsible} has to act before this can move: ${stage.note} Nothing has been attempted and no customer is affected.`
            : `This step is waiting on someone, but nobody has been named yet: ${stage.note} Nothing has been attempted and no customer is affected.`}
        </Inset>
      ) : null}

      {stage.state === 'failed' ? (
        <Inset family="err" heading="What did not work">
          {stage.note} This was tried for real and did not work, so the step cannot be counted as
          proved.
        </Inset>
      ) : null}

      {stage.state === 'setup' ? (
        <Inset family="warn" heading="Connected is not working">
          {stage.note} It has been configured but never tested for real, so it does not count as
          proved yet.
        </Inset>
      ) : null}

      {props.state.checks.length ? (
        <section className="flex min-w-0 flex-col gap-[7px]">
          <SectionLabel>Acceptance checks</SectionLabel>
          <p className="break-words text-[11px] leading-[1.45] text-[var(--iso-fg-3)]">
            {props.state.provedCount} of {props.state.stageCount} steps are proved. Each check below
            records evidence of a real message, login or change.
          </p>
          <VerificationChecklist checks={props.state.checks} />
        </section>
      ) : null}
    </div>
  )
}

// ── The view ────────────────────────────────────────────────────────────────

export function OnboardingView(props: {
  state: OnboardingState
  currentStageId: string
  className?: string
}) {
  const current = props.state.stages.find((stage) => stage.id === props.currentStageId)

  return (
    <div
      className={cn(
        // One column until there is genuinely room for two. The rail never causes sideways
        // scrolling — it collapses above the body instead.
        'grid min-w-0 grid-cols-[minmax(0,1fr)] gap-[14px] min-[720px]:grid-cols-[236px_minmax(0,1fr)]',
        props.className,
      )}
    >
      <nav className="flex min-w-0 flex-col gap-[10px]" aria-label="Setup steps">
        <ul className="flex min-w-0 list-none flex-col gap-[5px] p-0">
          {props.state.stages.map((stage) => (
            <li key={stage.id} className="min-w-0">
              <OnboardingStage stage={stage} isCurrent={stage.id === props.currentStageId} />
            </li>
          ))}
        </ul>
        <StageLegend />
        <WhoIsDoingThis stages={props.state.stages} />
      </nav>

      <StepBody state={props.state} stage={current} />
    </div>
  )
}
