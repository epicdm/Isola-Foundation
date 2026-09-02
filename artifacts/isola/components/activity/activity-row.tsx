/**
 * One record, and the rules about what a record may claim.
 *
 * A PURE component: props in, markup out, no hooks and no clock. "now" arrives
 * as a prop so the tests can render it with renderToStaticMarkup and assert the
 * exact sentence a reader gets, and so a server render and a browser render
 * cannot disagree about what "2 hours ago" means.
 *
 * NOTHING HERE IS FABRICATED
 * --------------------------
 * Every field is either printed as the API sent it, omitted because the API did
 * not send it, or shown as the word "Unknown". There is no fallback that guesses
 * an actor from a reference, a customer from an id, or a time from a gap.
 *
 * An identifier is SHORTENED for reading, never replaced by a guess and never
 * withheld: actorDisplay and relatedDisplay hand back both the short form and
 * the whole value, and the whole value goes in a title.
 *
 * STATUS IS NEVER COLOUR ALONE
 * ----------------------------
 * Every status carries a word and an icon. A reader who cannot distinguish red
 * from green, or who is reading a printout, gets the same information as anyone
 * else. A failed readback reads as "Not confirmed" with a cross, in text.
 */

import { CheckCircle2, Clock, ExternalLink, FlaskConical, Info, XCircle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

import {
  absoluteTime,
  actionLabel,
  actorDisplay,
  customerDisplay,
  familyLabel,
  freshnessLabel,
  ownershipLabel,
  recordReference,
  relatedDisplay,
  relativeTime,
  safeHref,
  sourceLabel,
  statusPresentation,
  type StatusPresentation,
  type StatusTone,
} from "./labels"
import type { ActivityFeedItem } from "./types"

const TONE_ICON: Record<StatusTone, typeof Info> = {
  success: CheckCircle2,
  failure: XCircle,
  pending: Clock,
  neutral: Info,
}

/**
 * Colour reinforces the word; it never replaces it. Note the failure tone reuses
 * the destructive token rather than a raw red, so it stays legible in both
 * themes and follows the same contrast decisions as the rest of the workspace.
 */
const TONE_CLASS: Record<StatusTone, string> = {
  success: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
  failure: "border-destructive/60 text-destructive",
  pending: "border-amber-600/40 text-amber-700 dark:text-amber-400",
  neutral: "border-border text-muted-foreground",
}

export function StatusChip({ status }: { status: StatusPresentation }) {
  const Icon = TONE_ICON[status.tone]
  return (
    <span
      className={cn(
        "inline-flex min-h-11 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium",
        TONE_CLASS[status.tone],
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span>{status.label}</span>
    </span>
  )
}

/**
 * THE ONE DOOR INTO THE CUSTOMER 360 WORKSPACE.
 *
 * There is no customer index page and no navigation entry, deliberately: a
 * second way in would make two routes authoritative for the same thing, which
 * is the invariant the Recent Work routes already hold.
 *
 * The id is checked against the SAME shape the context route accepts before a
 * link is offered. A link built from an id that route would refuse is a link
 * that lands on our own "not found", which reads to the reader as a deleted
 * customer rather than as a reference we never understood.
 *
 * This is an internal route, not a native deep link, so it is not subject to
 * the constructed-href rule below — /customer/<id> enforces its own session,
 * role and tenant guards, and a reader who may not see the customer gets the
 * same refusal there whether or not this link existed.
 */
const CUSTOMER_REFERENCE = /^[1-9]\d{0,17}$/

export function customerHref(customerId: string | null): string | null {
  if (!customerId || !CUSTOMER_REFERENCE.test(customerId)) return null
  return `/customer/${customerId}`
}

/**
 * One field. `title` carries the full value when the visible text is a
 * shortened form of it -- the identifier is abbreviated for reading, never
 * withheld, so a reader who needs the whole reference can still get it.
 */
function Meta({
  term,
  value,
  title,
  href,
}: {
  term: string
  value: string
  title?: string | null
  href?: string | null
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-1">
      <dt className="font-medium text-foreground/70">{term}</dt>
      <dd className="min-w-0 break-words" title={title ?? undefined}>
        {href ? (
          <a
            href={href}
            className="underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  )
}

export interface ActivityRowProps {
  item: ActivityFeedItem
  now: Date
}

export function ActivityRow({ item, now }: ActivityRowProps) {
  const status = statusPresentation(item.status)
  const ownership = ownershipLabel(item.ownershipState)
  const actor = actorDisplay(item.actor)
  const occurredExact = absoluteTime(item.occurredAt)
  // A short, stable handle for this row. Two records in the same second are
  // still two records, and the reader needs something to say that with.
  const reference = recordReference(item.activityId)

  // A link is rendered ONLY when the API supplied one that survives the scheme
  // check. There is no constructed href anywhere on this row: a guessed deep
  // link that 404s is worse than no link, because it looks like the record moved.
  const links = item.nativeLinks
    .map((link) => ({ ...link, safe: safeHref(link.href) }))
    .filter((link) => link.safe !== null)

  const related = relatedDisplay(item.relatedObjectType, item.relatedObjectId)
  // Gated on the id, not the label: a source that proves a customerId but never
  // sends a label (customer_tool_operation, by design) must still get a working
  // link. Gating this on customerLabel meant the "Open customer" link existed in
  // the code and had never once rendered, for any source.
  const customer = customerDisplay(item.customerId, item.customerLabel)
  const customerLink = customerHref(item.customerId)

  return (
    <li className="border-b last:border-b-0">
      <article className="flex flex-col gap-2.5 px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 className="min-w-0 break-words text-sm font-medium">{item.title}</h3>
          {/* Relative for scanning, exact on hover and in the machine-readable
              attribute, because "2 hours ago" is useless in an incident review. */}
          <time
            dateTime={item.occurredAt}
            title={occurredExact}
            className="shrink-0 text-xs text-muted-foreground"
          >
            {relativeTime(item.occurredAt, now)}
          </time>
        </div>

        {item.summary ? (
          <p className="break-words text-sm text-muted-foreground">{item.summary}</p>
        ) : null}

        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <Meta term="From" value={sourceLabel(item.provenance?.source ?? item.sourceSystem)} />
          <Meta term="Kind" value={familyLabel(item.eventType)} />
          <Meta term="Who" value={actor.text} title={actor.title} />
          {customer ? (
            <Meta term="Customer" value={customer.text} title={customer.title} href={customerLink} />
          ) : null}
          {related ? <Meta term="Related to" value={related.text} title={related.title} /> : null}
          {ownership ? <Meta term="Ownership" value={ownership} /> : null}
          <Meta term="Freshness" value={freshnessLabel(item.freshness)} />
          <Meta term="Occurred" value={occurredExact} />
          {reference ? <Meta term="Record" value={reference.text} title={reference.title} /> : null}
        </dl>

        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={status} />

          {item.dataMode === "fixture" ? (
            <Badge variant="outline" className="gap-1.5 border-amber-600/50 text-amber-700 dark:text-amber-400">
              <FlaskConical className="size-3.5" aria-hidden="true" />
              Sample data, not a real record
            </Badge>
          ) : null}

          {links.map((link) => (
            <a
              key={link.system + link.href}
              href={link.safe as string}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {link.label}
              <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="sr-only">opens in a new tab</span>
            </a>
          ))}
        </div>

        {status.note ? <p className="text-xs text-destructive">{status.note}</p> : null}

        {item.availableActions.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {/* Labels, not buttons, and said out loud rather than implied by a
                greyed-out control. This screen reads; it does not act. */}
            <span className="font-medium text-foreground/70">Possible next steps: </span>
            {item.availableActions.map(actionLabel).join(", ")}
            <span> (not available from this screen yet)</span>
          </p>
        ) : null}
      </article>
    </li>
  )
}
