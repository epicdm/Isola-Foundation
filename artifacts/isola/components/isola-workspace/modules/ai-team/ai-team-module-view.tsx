/**
 * Isola Workspace — the AI Team module body.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ------------------------------------
 * AI output is INTERNAL. Nothing an AI colleague writes reaches a customer by being produced.
 * It reaches a customer only when a person puts it in the reply box and presses Send — two
 * deliberate human acts, in the host's own composer, outside this panel.
 *
 * That rule is defended visually, not just in copy. `InternalSuggestion` shares NO styling
 * with a chat bubble: it is a dashed-bordered plum container holding a plain document card,
 * with a persistent "Not sent to customer" pill that is not dismissible and not conditional.
 * The moment AI output looks like a message, an operator will read it as one — and the next
 * mistake is a draft pasted to a customer that nobody checked.
 *
 * `ports.ts` backs this up structurally: `AiTeamPort` has `listEmployees` and `consult`, and
 * deliberately no `send`. There is no call site to reach.
 *
 * Pure presentation. No hooks, no state, no fetching.
 */

import { cn } from '@/lib/utils'
import { LoadingSkeleton } from '@/components/isola-workspace/primitives'
import type { AiEmployee, InternalSuggestion as InternalSuggestionData } from '@/lib/isola-workspace/adapters/ports'

import { ModuleButton, ModuleCard, ModuleChip, SectionLabel } from '../shared'

// ── Availability ────────────────────────────────────────────────────────────

/**
 * The availability word, its colour and — where the point is a LIMIT — the sentence that
 * states the limit. An AI employee card must never imply autonomy it does not have.
 */
const AVAILABILITY: Record<
  AiEmployee['availability'],
  { word: string; textClass: string; dotClass: string; note?: string }
> = {
  available: {
    word: 'Available',
    textClass: 'text-[var(--iso-ok)]',
    dotClass: 'bg-[var(--iso-ok)]',
  },
  onDuty: {
    word: 'On duty',
    textClass: 'text-[var(--iso-info)]',
    dotClass: 'bg-[var(--iso-info)]',
  },
  approvalOnly: {
    word: 'Approval only',
    textClass: 'text-[var(--iso-warn)]',
    dotClass: 'bg-[var(--iso-warn)]',
    note: 'every action needs approval',
  },
  paused: {
    word: 'Paused',
    textClass: 'text-[var(--iso-block)]',
    dotClass: 'bg-[var(--iso-block)]',
  },
}

// ── AIEmployeeCard ──────────────────────────────────────────────────────────

export function AIEmployeeCard(props: { employee: AiEmployee; className?: string }) {
  const { employee } = props
  const availability = AVAILABILITY[employee.availability]

  // `paused` must ALWAYS say why. A greyed row with no reason tells an operator that something
  // is off but not whether a customer is affected, which is the worst of both.
  const limitation =
    employee.availability === 'paused'
      ? (employee.limitation ?? 'Paused. The reason has not been recorded yet.')
      : (employee.limitation ?? availability.note)

  return (
    <ModuleCard
      as="article"
      className={cn(
        'gap-[6px]',
        employee.availability === 'paused' && 'opacity-75',
        props.className,
      )}
    >
      <div className="flex min-w-0 items-start gap-[8px]">
        <span
          aria-hidden="true"
          className="flex h-[28px] w-[28px] flex-none items-center justify-center rounded-[var(--iso-radius-md)] border border-[var(--iso-accent-ring)] bg-[var(--iso-accent-soft)] text-[11px] font-semibold text-[var(--iso-accent-fg)]"
        >
          {employee.initials}
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-[1px]">
          <span className="break-words text-[12.5px] font-semibold leading-[1.3] text-[var(--iso-fg)]">
            {employee.name}
          </span>
          <span className="break-words text-[11px] leading-[1.4] text-[var(--iso-fg-3)]">
            {employee.role}
          </span>
        </span>

        <span
          className={cn(
            'flex flex-none items-center gap-[5px] text-[11px] font-semibold',
            availability.textClass,
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'h-[5px] w-[5px] rounded-[var(--iso-radius-pill)]',
              availability.dotClass,
            )}
          />
          {availability.word}
        </span>
      </div>

      {limitation ? (
        <p className="break-words text-[11px] leading-[1.45] text-[var(--iso-fg-2)]">
          {limitation}
        </p>
      ) : null}

      {employee.knowledge?.length ? (
        <div className="flex min-w-0 flex-wrap gap-[4px]">
          {employee.knowledge.map((item) => (
            <span
              key={item}
              className="rounded-[var(--iso-radius-sm)] border border-[var(--iso-border)] bg-[var(--iso-surface-2)] px-[6px] py-[2px] text-[10px] text-[var(--iso-fg-3)]"
            >
              {item}
            </span>
          ))}
        </div>
      ) : null}
    </ModuleCard>
  )
}

// ── DraftChain ──────────────────────────────────────────────────────────────

export type DraftStage = 'suggestion' | 'draft' | 'approval' | 'approved' | 'sent'

const DRAFT_CHAIN_LABELS = ['AI suggestion', 'Your draft', 'Sent to customer'] as const

/**
 * How far a piece of wording has actually travelled.
 *
 * Approval sits INSIDE "your draft", not after it: asking for approval does not move anything
 * closer to the customer, and drawing it as a further step would suggest it did.
 */
const DRAFT_STAGE_REACH: Record<DraftStage, number> = {
  suggestion: 0,
  draft: 1,
  approval: 1,
  approved: 1,
  sent: 2,
}

export function DraftChain(props: { stage: DraftStage; className?: string }) {
  const reached = DRAFT_STAGE_REACH[props.stage]
  return (
    <div
      className={cn('flex min-w-0 flex-wrap items-center gap-[4px]', props.className)}
      aria-label="Where this wording currently sits"
    >
      {DRAFT_CHAIN_LABELS.map((label, index) => (
        <span key={label} className="flex items-center gap-[4px]">
          {index > 0 ? (
            <span aria-hidden="true" className="text-[11px] text-[var(--iso-fg-3)]">
              ›
            </span>
          ) : null}
          <span
            className={cn(
              'rounded-[var(--iso-radius-pill)] border px-[8px] py-[2px] text-[10px] font-semibold',
              index <= reached
                ? 'border-[var(--iso-accent-ring)] bg-[var(--iso-accent-soft)] text-[var(--iso-accent-fg)]'
                : 'border-[var(--iso-border)] bg-[var(--iso-surface-2)] text-[var(--iso-fg-3)]',
            )}
          >
            {label}
          </span>
        </span>
      ))}
    </div>
  )
}

// ── InternalSuggestion ──────────────────────────────────────────────────────

const CONFIDENCE_LABEL: Record<InternalSuggestionData['confidence'], string> = {
  high: 'Confident in this wording',
  medium: 'Reasonably confident — worth a read',
  low: 'Not confident — check this before using it',
}

/**
 * AI output. NOT A MESSAGE.
 *
 * Every visual decision here is a defence against it being mistaken for one:
 *   · plum `accent-soft` fill with a DASHED `accent-ring` border — nothing else in the product
 *     is dashed-plum, and a dashed edge reads as provisional;
 *   · a persistent, non-dismissible "Not sent to customer" pill in the header strip;
 *   · the wording itself on a plain `--iso-surface` card INSIDE, so it reads as a document
 *     someone drafted rather than something someone said;
 *   · no tail, no asymmetric radius, no alignment to one side — none of the grammar of a
 *     chat bubble.
 */
export function InternalSuggestion(props: {
  suggestion: InternalSuggestionData
  className?: string
}) {
  const { suggestion } = props
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col gap-[9px] rounded-[var(--iso-radius-lg)] p-[10px]',
        'bg-[var(--iso-accent-soft)] border border-dashed border-[var(--iso-accent-ring)]',
        props.className,
      )}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-[6px]">
        <span
          aria-hidden="true"
          className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[var(--iso-radius-md)] border border-[var(--iso-accent-ring)] bg-[var(--iso-surface)] text-[10px] font-semibold text-[var(--iso-accent-fg)]"
        >
          At
        </span>
        <span className="text-[11.5px] font-semibold text-[var(--iso-accent-fg)]">
          Internal suggestion
        </span>
        <span className="text-[11px] text-[var(--iso-fg-2)]">Atlas · assistant</span>
        {/* Persistent. Not dismissible, not conditional, and never rendered from a flag that
            could be false — `notSentToCustomer` is typed `true` in the port for that reason. */}
        <span className="ml-auto flex-none rounded-[var(--iso-radius-pill)] border border-[var(--iso-accent-ring)] bg-[var(--iso-surface)] px-[8px] py-[2px] text-[10px] font-semibold text-[var(--iso-accent-fg)]">
          Not sent to customer
        </span>
      </header>

      {/* A document, not a message. */}
      <div className="min-w-0 rounded-[var(--iso-radius-md)] border border-[var(--iso-border)] bg-[var(--iso-surface)] p-[10px]">
        <p className="break-words text-[12.5px] leading-[1.5] text-[var(--iso-fg)]">
          {suggestion.text}
        </p>
      </div>

      <div className="flex min-w-0 flex-wrap gap-[4px]">
        {suggestion.provenance.map((item) => (
          <span
            key={item}
            className="rounded-[var(--iso-radius-sm)] border border-[var(--iso-border)] bg-[var(--iso-surface)] px-[6px] py-[2px] text-[10px] text-[var(--iso-fg-2)]"
          >
            {item}
          </span>
        ))}
        <span className="rounded-[var(--iso-radius-sm)] border border-[var(--iso-border)] bg-[var(--iso-surface)] px-[6px] py-[2px] text-[10px] text-[var(--iso-fg-2)]">
          {CONFIDENCE_LABEL[suggestion.confidence]}
        </span>
      </div>

      <div className="flex min-w-0 flex-wrap gap-[6px]">
        <ModuleButton
          label="Put in the reply box"
          intent="ai.put-in-reply-box"
          tone="accent"
        />
        <ModuleButton label="Ask for approval" intent="ai.request-approval" tone="outline" />
        <ModuleButton label="Create a follow-up" intent="ai.create-follow-up" tone="outline" />
        <ModuleButton label="Discard" intent="ai.discard" tone="quiet" />
      </div>
    </section>
  )
}

// ── Ask Atlas ───────────────────────────────────────────────────────────────

export const ASK_ATLAS_PROMPTS = [
  { id: 'summarise', label: 'Summarise this customer' },
  { id: 'respond', label: 'Prepare a response' },
  { id: 'investigate', label: 'Investigate an issue' },
  { id: 'next-action', label: 'Suggest a next action' },
  { id: 'prepare-action', label: 'Prepare an action for approval' },
] as const

// ── Output region ───────────────────────────────────────────────────────────

function OutputRegion(props: {
  outputState: 'idle' | 'thinking' | 'result'
  suggestion: InternalSuggestionData | null
  draftStage?: DraftStage
}) {
  if (props.outputState === 'idle') {
    return (
      <div className="flex min-w-0 flex-col gap-[4px] rounded-[var(--iso-radius-lg)] border border-dashed border-[var(--iso-border-strong)] bg-[var(--iso-surface-2)] p-[12px]">
        <p className="text-[12px] font-semibold text-[var(--iso-fg-2)]">Nothing prepared yet</p>
        <p className="break-words text-[11.5px] leading-[1.45] text-[var(--iso-fg-3)]">
          Pick one of the questions above and Atlas will write a suggestion here for you to read.
          Whatever appears stays inside Isola until you put it in the reply box yourself.
        </p>
      </div>
    )
  }

  if (props.outputState === 'thinking') {
    return (
      <div
        className="flex min-w-0 flex-col gap-[8px] rounded-[var(--iso-radius-lg)] border border-[var(--iso-border)] bg-[var(--iso-surface)] p-[12px]"
        aria-busy="true"
      >
        <div className="flex min-w-0 items-center gap-[7px]">
          <span
            aria-hidden="true"
            className="h-[13px] w-[13px] flex-none rounded-[var(--iso-radius-pill)] border-2 border-[var(--iso-border)] border-t-[var(--iso-accent)] [animation:iso-spin_0.7s_linear_infinite]"
          />
          <span className="break-words text-[11.5px] text-[var(--iso-fg-2)]">
            Atlas is reading the conversation and the sales record…
          </span>
        </div>
        <LoadingSkeleton variant="line" count={2} />
      </div>
    )
  }

  if (!props.suggestion) {
    return (
      <div className="flex min-w-0 flex-col gap-[4px] rounded-[var(--iso-radius-lg)] border border-dashed border-[var(--iso-border-strong)] bg-[var(--iso-surface-2)] p-[12px]">
        <p className="text-[12px] font-semibold text-[var(--iso-fg-2)]">
          Atlas did not produce a suggestion
        </p>
        <p className="break-words text-[11.5px] leading-[1.45] text-[var(--iso-fg-3)]">
          Nothing was written and nothing was sent. You can ask again, or reply in your own words.
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-[7px]">
      <InternalSuggestion suggestion={props.suggestion} />
      <DraftChain stage={props.draftStage ?? 'suggestion'} />
    </div>
  )
}

// ── The module body ─────────────────────────────────────────────────────────

export function AiTeamModuleView(props: {
  employees: readonly AiEmployee[]
  suggestion: InternalSuggestionData | null
  outputState: 'idle' | 'thinking' | 'result'
  draftStage?: DraftStage
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-[10px]', props.className)}>
      {/* The boundary, stated first and stated plainly. */}
      <ModuleCard className="gap-[4px] border-[var(--iso-accent-ring)]">
        <SectionLabel tone="accent">How your AI team works</SectionLabel>
        <p className="break-words text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">
          Your AI team works inside Isola only. Nothing they write reaches the customer until you
          put it in the reply box and press Send.
        </p>
      </ModuleCard>

      <div className="flex min-w-0 flex-col gap-[6px]">
        {props.employees.map((employee) => (
          <AIEmployeeCard key={employee.name} employee={employee} />
        ))}
      </div>

      <ModuleCard className="gap-[7px]">
        <div className="flex min-w-0 flex-col gap-[2px]">
          <p className="text-[12.5px] font-semibold text-[var(--iso-fg)]">Ask Atlas</p>
          <p className="break-words text-[11px] leading-[1.45] text-[var(--iso-fg-3)]">
            Atlas reads and suggests. It never sends and it never approves.
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap gap-[5px]">
          {ASK_ATLAS_PROMPTS.map((prompt) => (
            <ModuleChip
              key={prompt.id}
              label={prompt.label}
              intent={`ai.ask:${prompt.id}`}
            />
          ))}
        </div>
      </ModuleCard>

      <OutputRegion
        outputState={props.outputState}
        suggestion={props.suggestion}
        draftStage={props.draftStage}
      />
    </div>
  )
}
