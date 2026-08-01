/**
 * The Customer 360 workspace, as a PURE FUNCTION of its props.
 *
 * No fetching, no hooks, no router. That is what makes it testable with
 * renderToStaticMarkup in a workspace with no jsdom — the same arrangement
 * `components/activity/recent-work-view.tsx` uses, and for the same reason.
 *
 * THE RULES THIS FILE IS ACCOUNTABLE FOR
 * --------------------------------------
 * 1. NO BLANK CARD IS A STATE. Every section says something in every state.
 *    "Nothing here" and "we could not find out" are different sentences, and a
 *    card that renders nothing at all is neither.
 *
 * 2. FORBIDDEN DISCLOSES NOTHING. No count, no reason, no provenance, no
 *    timestamp. Each of those confirms the section has content to a reader who
 *    may not be entitled to know that.
 *
 * 3. STATUS IS NEVER COLOUR ALONE. Every lifecycle and every section state
 *    carries a text label and a non-colour marker. Colour, where it appears, is
 *    redundant with words that are already there.
 *
 * 4. NOTHING IS INVENTED. A link is rendered only when the record arrived with
 *    one — the API withholds it unless the reference, the instance URL and the
 *    permission all exist, and this file never constructs one itself.
 *
 * 5. A WRITE IS DESCRIBED BEFORE IT HAPPENS. The workbench shows what will be
 *    written, to which system, under which permission, and what proof will be
 *    required, before anything is sent.
 */

import type {
  ContextSectionEnvelope,
  ContextSectionName,
  CustomerContextResponse,
  AvailableAction,
} from '@/lib/context/customer-context'
import type { ActionField } from '@/lib/governed/executors/catalogue'
import {
  LIFECYCLE_PRESENTATION,
  type ActionLifecycleState,
  type SectionState,
} from '@/lib/customer-workspace/contract'

/* ── the outcome as the actions route sends it ─────────────────────────────*/

export interface ActionOutcomeView {
  actionType: string
  lifecycle: ActionLifecycleState
  success: boolean
  label: string
  detail: string
  marker: string
  tone: string
  terminal: boolean
  retryWrite: string
  retryReadback: string
  escalate: boolean
  showsPriorResult: boolean
  operationId: string | null
  auditRef: string | null
  readbackProven: boolean
  approvalRef: string | null
}

export interface WorkspaceViewProps {
  customerId: string
  status: 'loading' | 'ready' | 'not_found' | 'forbidden' | 'error'
  context: CustomerContextResponse | null
  errorDetail?: string | null
  selectedAction: string | null
  actionValues: Record<string, string>
  actionOutcome: ActionOutcomeView | null
  actionPending: boolean
  onSelectAction: (actionType: string | null) => void
  onChangeField: (name: string, value: string) => void
  onRun: () => void
  onRetryContext: () => void
}

/* ── labels ────────────────────────────────────────────────────────────────*/

const SECTION_LABEL: Readonly<Record<ContextSectionName, string>> = {
  customer: 'Customer',
  contacts: 'Contacts',
  opportunities: 'Opportunities',
  issues: 'Issues',
  tasks: 'Tasks',
  recentActions: 'Recent governed actions',
  activity: 'Activity',
  services: 'Services',
  devices: 'Devices',
  pbx: 'PBX',
  invoices: 'Invoices',
  notes: 'Notes',
}

/**
 * Every state gets a marker and a sentence. `empty` and `unavailable` are the
 * pair that must never read the same; `forbidden` says nothing about content.
 */
const SECTION_STATE_TEXT: Readonly<Record<SectionState, { marker: string; label: string }>> = {
  loading: { marker: '…', label: 'Loading' },
  available: { marker: '•', label: 'Showing' },
  empty: { marker: '–', label: 'Nothing recorded' },
  partial: { marker: '⚠', label: 'Incomplete' },
  stale: { marker: '⌛', label: 'Stored copy' },
  forbidden: { marker: '🔒', label: 'Not available to you' },
  unavailable: { marker: '⟳', label: 'Could not be read' },
  error: { marker: '!', label: 'Could not be understood' },
  retrying: { marker: '↻', label: 'Retrying' },
}

/** The order the workspace renders sections in. Fixed, so nothing moves about. */
const RENDER_ORDER: readonly ContextSectionName[] = [
  'customer',
  'contacts',
  'issues',
  'opportunities',
  'tasks',
  'recentActions',
  'activity',
  'services',
  'devices',
  'pbx',
  'invoices',
  'notes',
]

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

/** A record's headline, taken from fields the adapters actually return. */
function recordTitle(record: Record<string, unknown>): string {
  return (
    str(record.name) ??
    str(record.title) ??
    str(record.actionType) ??
    str(record.summary) ??
    (typeof record.id === 'number' ? `#${record.id}` : 'Record')
  )
}

/** Supporting detail. Only fields that were actually supplied. */
function recordMeta(record: Record<string, unknown>): string[] {
  const out: string[] = []
  const push = (label: string, value: unknown) => {
    const v = str(value)
    if (v) out.push(`${label}: ${v}`)
  }
  push('Stage', record.stage)
  push('Role', record.role)
  push('Owner', record.owner)
  push('Priority', record.priority)
  push('Email', record.email)
  push('Phone', record.phone)
  push('Updated', record.updatedAt)
  if (record.lifecycle) {
    const state = String(record.lifecycle) as ActionLifecycleState
    const p = LIFECYCLE_PRESENTATION[state]
    if (p) out.push(`Outcome: ${p.marker} ${p.label}`)
  }
  return out
}

/* ── section card ──────────────────────────────────────────────────────────*/

export function SectionCard({ section }: { section: ContextSectionEnvelope }) {
  const text = SECTION_STATE_TEXT[section.state]
  const label = SECTION_LABEL[section.name]
  const headingId = `section-${section.name}-title`

  // FORBIDDEN FIRST, and it returns early. Nothing below this branch — not the
  // count, not the reason, not the provenance — may be reached for it.
  if (section.state === 'forbidden') {
    return (
      <section
        aria-labelledby={headingId}
        data-section={section.name}
        data-state="forbidden"
        className="rounded-lg border p-4"
      >
        <h3 id={headingId} className="text-sm font-semibold">
          {label}
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          <span aria-hidden="true">{text.marker} </span>
          You do not have access to this section.
        </p>
      </section>
    )
  }

  const records = section.records as Record<string, unknown>[]

  return (
    <section
      aria-labelledby={headingId}
      data-section={section.name}
      data-state={section.state}
      className="rounded-lg border p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          {label}
        </h3>
        <span className="text-xs text-muted-foreground">
          <span aria-hidden="true">{text.marker} </span>
          {text.label}
          {section.state === 'available' || section.state === 'partial' || section.state === 'stale'
            ? ` ${section.count}`
            : ''}
        </span>
      </div>

      {/* Every non-content state says something. None of them is a blank card. */}
      {section.reason ? (
        <p className="mt-2 text-sm text-muted-foreground">{section.reason}</p>
      ) : null}

      {section.state === 'empty' ? (
        <p className="mt-2 text-sm text-muted-foreground">
          This was read successfully and there is nothing recorded.
        </p>
      ) : null}

      {section.missing.length > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Not included: {section.missing.join(', ')}
        </p>
      ) : null}

      {records.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {records.map((record, index) => {
            const link = str(record.link)
            const meta = recordMeta(record)
            return (
              <li key={index} className="text-sm">
                <div className="font-medium">
                  {link ? (
                    <a className="underline underline-offset-2" href={link} rel="noreferrer noopener" target="_blank">
                      {recordTitle(record)}
                    </a>
                  ) : (
                    recordTitle(record)
                  )}
                </div>
                {meta.length > 0 ? (
                  <div className="text-xs text-muted-foreground">{meta.join(' · ')}</div>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}

      {section.provenance ? (
        <p className="mt-3 text-xs text-muted-foreground">
          From {section.provenance.source}
          {section.provenance.stale ? ' (stored copy)' : ''}
        </p>
      ) : null}
    </section>
  )
}

/* ── the two read-only native surfaces ─────────────────────────────────────*/

/**
 * Chatwoot and Clawith, read-only.
 *
 * Neither has an authoritative per-customer reference in this response, and
 * there is no source that supplies one: `ChannelBinding` is scoped to a company
 * and a channel, not to a customer. So both surfaces render `unavailable` and
 * offer NO link. A plausible-looking URL that lands on the wrong conversation is
 * worse than no link, because it looks checked.
 *
 * They are rendered rather than omitted for the same reason the five
 * source-less sections are: an absent panel and an empty one look identical.
 */
export function NativeSurface({
  name,
  system,
  reason,
}: {
  name: string
  system: string
  reason: string
}) {
  const headingId = `native-${system}-title`
  return (
    <section
      aria-labelledby={headingId}
      data-native-surface={system}
      data-state="unavailable"
      className="rounded-lg border p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          {name}
        </h3>
        <span className="text-xs text-muted-foreground">
          <span aria-hidden="true">⟳ </span>
          Not connected
        </span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{reason}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        This panel is read-only. No link is offered because no authoritative
        reference for this customer exists.
      </p>
    </section>
  )
}

/* ── lifecycle ─────────────────────────────────────────────────────────────*/

/**
 * The state of an action, in three independent channels: a marker, a label and
 * a sentence. Remove the colour entirely and every one of them still says the
 * same thing.
 */
export function LifecycleBadge({ state }: { state: ActionLifecycleState }) {
  const p = LIFECYCLE_PRESENTATION[state]
  return (
    <span data-lifecycle={state} data-tone={p.tone} data-success={String(p.success)} className="text-sm font-medium">
      <span aria-hidden="true">{p.marker} </span>
      {p.label}
    </span>
  )
}

/* ── the workbench, before anything is sent ────────────────────────────────*/

function FieldInput({
  field,
  value,
  onChangeField,
}: {
  field: ActionField
  value: string
  onChangeField: (name: string, value: string) => void
}) {
  const id = `action-field-${field.name}`
  const describedBy = field.help ? `${id}-help` : undefined
  const common = {
    id,
    name: field.name,
    value,
    'aria-describedby': describedBy,
    required: field.required,
    // 44px minimum target, expressed in CSS rather than claimed in a comment.
    className: 'min-h-11 w-full rounded-md border px-3 py-2 text-sm',
    onChange: (e: { target: { value: string } }) => onChangeField(field.name, e.target.value),
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {field.label}
        {field.required ? <span className="text-muted-foreground"> (required)</span> : null}
      </label>
      {field.kind === 'longtext' ? (
        <textarea {...common} rows={4} maxLength={field.maxLength} />
      ) : field.kind === 'choice' ? (
        <select {...common}>
          <option value="">Choose…</option>
          {(field.choices ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      ) : (
        <input
          {...common}
          type={field.kind === 'date' ? 'date' : field.kind === 'number' ? 'number' : 'text'}
          maxLength={field.maxLength}
        />
      )}
      {field.help ? (
        <p id={describedBy} className="text-xs text-muted-foreground">
          {field.help}
        </p>
      ) : null}
    </div>
  )
}

export function ActionPlan({
  action,
  customerLabel,
  values,
  pending,
  onChangeField,
  onRun,
}: {
  action: AvailableAction
  customerLabel: string
  values: Record<string, string>
  pending: boolean
  onChangeField: (name: string, value: string) => void
  onRun: () => void
}) {
  const supplied = action.fields.filter((f) => (values[f.name] ?? '').trim().length > 0)
  const unknown = Object.keys(values).filter((k) => !action.fields.some((f) => f.name === k))

  return (
    <div className="flex flex-col gap-4" data-action-plan={action.actionType}>
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Customer</dt>
          <dd>{customerLabel}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Action</dt>
          <dd>{action.label}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Target system</dt>
          <dd>The business system of record</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Risk</dt>
          <dd>{action.riskLevel}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">What this will write</dt>
          <dd>{action.writes}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Required permission</dt>
          <dd>
            {action.requiresApproval
              ? 'Your role permits this, and it also needs a person to approve it before it can run.'
              : 'Your role permits this and no separate approval is required.'}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Expected result</dt>
          <dd>{action.expectedResult}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">If it goes wrong</dt>
          <dd>
            Nothing is reported as done until it has been read back. If it is
            written and cannot be read back, you will be told exactly that and
            asked to check the system of record — it will not be undone
            automatically.
          </dd>
        </div>
      </dl>

      <div className="flex flex-col gap-3">
        {action.fields.map((field) => (
          <FieldInput
            key={field.name}
            field={field}
            value={values[field.name] ?? ''}
            onChangeField={onChangeField}
          />
        ))}
      </div>

      <div className="text-xs text-muted-foreground" data-supplied-count={supplied.length}>
        Supplied: {supplied.length > 0 ? supplied.map((f) => f.label).join(', ') : 'nothing yet'}
        {unknown.length > 0 ? ` · Not used by this action: ${unknown.join(', ')}` : ''}
      </div>

      <button
        type="button"
        onClick={onRun}
        disabled={pending}
        className="min-h-11 rounded-md border px-4 py-2 text-sm font-medium"
      >
        {pending ? 'Sending…' : action.requiresApproval ? 'Request approval' : 'Send to the system of record'}
      </button>
    </div>
  )
}

/* ── the workbench, afterwards ─────────────────────────────────────────────*/

export function ActionResult({ outcome }: { outcome: ActionOutcomeView }) {
  const p = LIFECYCLE_PRESENTATION[outcome.lifecycle]

  return (
    <div
      className="mt-4 rounded-md border p-3"
      data-action-result={outcome.lifecycle}
      data-success={String(outcome.success)}
      // Lifecycle changes are announced. `assertive` because an unproven write
      // is not something a reader should discover by chance.
      role="status"
      aria-live={p.escalate ? 'assertive' : 'polite'}
    >
      <LifecycleBadge state={outcome.lifecycle} />
      <p className="mt-1 text-sm">{outcome.detail}</p>

      <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Operation reference</dt>
          <dd>{outcome.operationId ?? 'none — nothing was recorded'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Audit reference</dt>
          <dd>{outcome.auditRef ?? 'none'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Read back from the system of record</dt>
          <dd>{outcome.readbackProven ? 'yes — this is confirmed' : 'no — this is not confirmed'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Sending it again</dt>
          <dd>
            {outcome.retryWrite === 'safe'
              ? 'safe — nothing was written'
              : outcome.retryWrite === 'unsafe'
                ? 'not safe — it may write a second time'
                : 'not applicable'}
          </dd>
        </div>
        {outcome.approvalRef ? (
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">Approval reference</dt>
            <dd>{outcome.approvalRef}</dd>
          </div>
        ) : null}
      </dl>

      {outcome.showsPriorResult ? (
        <p className="mt-2 text-xs text-muted-foreground">
          This result belongs to an earlier attempt with the same reference.
        </p>
      ) : null}

      {outcome.escalate ? (
        <p className="mt-2 text-sm font-medium">
          A person needs to check the system of record before this is treated as
          done.
        </p>
      ) : null}
    </div>
  )
}

/* ── the whole screen ──────────────────────────────────────────────────────*/

export function CustomerWorkspaceView(props: WorkspaceViewProps) {
  const { context } = props

  if (props.status === 'loading') {
    return (
      <div id="customer-workspace" aria-busy="true">
        <p className="text-sm text-muted-foreground">Loading this customer…</p>
      </div>
    )
  }

  if (props.status === 'not_found') {
    return (
      <div id="customer-workspace">
        <h2 className="text-lg font-semibold">Not available</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This customer was not found, or is not available to you.
        </p>
      </div>
    )
  }

  if (props.status === 'forbidden') {
    return (
      <div id="customer-workspace">
        <h2 className="text-lg font-semibold">Not available for your role</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Ask a workspace owner to grant you access if you need it.
        </p>
      </div>
    )
  }

  if (props.status === 'error' || !context) {
    return (
      <div id="customer-workspace">
        <h2 className="text-lg font-semibold">This customer could not be loaded</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {props.errorDetail ?? 'The workspace could not be read. Nothing about this customer has changed.'}
        </p>
        <button
          type="button"
          onClick={props.onRetryContext}
          className="mt-3 min-h-11 rounded-md border px-4 py-2 text-sm font-medium"
        >
          Try again
        </button>
      </div>
    )
  }

  const customerSection = context.sections.customer
  const customerRecord = (customerSection.records[0] ?? null) as Record<string, unknown> | null
  const customerLabel = customerRecord ? recordTitle(customerRecord) : 'This customer'
  const selected = context.availableActions.find((a) => a.actionType === props.selectedAction) ?? null

  return (
    <div id="customer-workspace" className="flex flex-col gap-6">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <header className="flex flex-col gap-1">
        <h2 id="customer-workspace-title" className="text-xl font-semibold">
          {customerLabel}
        </h2>
        <p className="text-sm text-muted-foreground">
          {customerRecord && str(customerRecord.companyName)
            ? `Part of ${str(customerRecord.companyName)}`
            : customerRecord && customerRecord.isCompany === true
              ? 'A company record'
              : 'No parent company recorded'}
          {customerRecord
            ? customerRecord.active === false
              ? ' · Archived in the system of record'
              : ' · Active in the system of record'
            : ''}
        </p>
        <p className="text-xs text-muted-foreground">
          Read at {context.provenance.generatedAt}
        </p>
      </header>

      {/* An incomplete picture is stated ONCE, at the top, and names what is
          missing. A reader should not have to audit twelve cards to find out. */}
      {context.provenance.degraded.length > 0 ? (
        <div role="status" className="rounded-md border p-3 text-sm" data-incomplete="true">
          <span aria-hidden="true">⚠ </span>
          This is an incomplete picture. These sections could not be read:{' '}
          {context.provenance.degraded.map((d) => SECTION_LABEL[d]).join(', ')}.
        </div>
      ) : null}

      {/* ── sections ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {RENDER_ORDER.map((name) => (
          <SectionCard key={name} section={context.sections[name]} />
        ))}
      </div>

      {/* ── read-only native surfaces ──────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <NativeSurface
          name="Conversations"
          system="chatwoot"
          reason="No authoritative conversation reference for this customer is available, so nothing is shown."
        />
        <NativeSurface
          name="Assistant"
          system="clawith"
          reason="No authoritative agent binding for this customer is available, so nothing is shown."
        />
      </div>

      {/* ── the governed action workbench ──────────────────────────────── */}
      <section aria-labelledby="workbench-title" className="rounded-lg border p-4">
        <h3 id="workbench-title" className="text-sm font-semibold">
          Governed actions
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Nothing is reported as done until it has been read back from the system
          of record.
        </p>

        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-labelledby="workbench-title">
          {context.availableActions.map((action) => (
            <button
              key={action.actionType}
              type="button"
              onClick={() => props.onSelectAction(action.actionType)}
              aria-pressed={props.selectedAction === action.actionType}
              data-action={action.actionType}
              className="min-h-11 rounded-md border px-3 py-2 text-sm"
            >
              {action.label}
              {action.requiresApproval ? ' (needs approval)' : ''}
            </button>
          ))}
        </div>

        {selected ? (
          <div className="mt-4 border-t pt-4">
            <ActionPlan
              action={selected}
              customerLabel={customerLabel}
              values={props.actionValues}
              pending={props.actionPending}
              onChangeField={props.onChangeField}
              onRun={props.onRun}
            />
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            Choose an action to see exactly what it would write before anything is
            sent.
          </p>
        )}

        {props.actionOutcome ? <ActionResult outcome={props.actionOutcome} /> : null}
      </section>
    </div>
  )
}
