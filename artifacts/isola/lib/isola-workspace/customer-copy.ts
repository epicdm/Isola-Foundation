/**
 * Isola Workspace — customer attribution copy.
 *
 * THE DEFECT THIS CLOSES
 * ----------------------
 * The summary line was built by interpolation:
 *
 *     {customer.statusLabel} · {customer.ownerName} looks after them
 *
 * `CustomerIdentity.ownerName` is typed as a required `string`, but an unassigned account is a
 * real and ordinary state, and an adapter has three plausible ways to express it — `''`, `null`
 * through an untyped boundary, or a padded `'   '` from a trimmed-elsewhere source. All three
 * rendered as "Active customer ·  looks after them": a dangling separator, a doubled space, and
 * a sentence missing its subject. It reads as a rendering fault rather than as the fact that
 * nobody is assigned, which is exactly the wrong impression on a panel whose whole promise is
 * that what it says is true.
 *
 * NEVER INVENT A NAME. The fallback states the absence; it does not substitute "the team",
 * "unassigned agent" or any other stand-in that could be mistaken for a person.
 */

/** Whether an owner name is a real, usable name rather than an absence in disguise. */
export function hasOwnerName(ownerName: string | null | undefined): boolean {
  return typeof ownerName === 'string' && ownerName.trim().length > 0
}

/**
 * The customer summary line: status, then who is responsible.
 *
 * Built as a joined list rather than a template so a missing part removes its own separator
 * instead of leaving one behind — the failure mode this function exists to prevent cannot be
 * reintroduced by editing the copy.
 */
export function customerAttributionLine(
  statusLabel: string | null | undefined,
  ownerName: string | null | undefined,
): string {
  const status = typeof statusLabel === 'string' ? statusLabel.trim() : ''
  const attribution = hasOwnerName(ownerName)
    ? `${(ownerName as string).trim()} looks after them`
    : 'Nobody is assigned to them yet'

  return [status, attribution].filter(Boolean).join(' · ')
}
