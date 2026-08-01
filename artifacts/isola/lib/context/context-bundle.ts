/**
 * context-bundle@1 — the permission-filtered business picture for one object.
 *
 * TWO RULES DECIDE EVERY LINE BELOW.
 *
 * 1. NOTHING IS INVENTED. Every section carries its own provenance: which source
 *    produced it and when. A section that could not be fetched comes back as an
 *    explicit failure with a reason, never as an empty array. "No invoices" and
 *    "the invoice system was down" look identical to a UI that only sees `[]`,
 *    and an agent that cannot tell them apart will confidently tell a customer
 *    they owe nothing.
 *
 * 2. A PARTIAL OUTAGE IS A PARTIAL ANSWER, NOT AN ERROR. One dead adapter must
 *    not blank the workbench. The bundle returns what it has, names what it
 *    lost, and lets the caller decide.
 */

export const CONTEXT_BUNDLE_VERSION = 'context-bundle@1' as const

export const BUNDLE_SECTIONS = [
  'customer',
  'contacts',
  'services',
  'devices',
  'pbx',
  'issues',
  'tasks',
  'activities',
  'opportunities',
  'orders',
  'invoices',
  'diagnostics',
  'notes',
  'recentActions',
  'recentCommunication',
] as const
export type BundleSection = (typeof BUNDLE_SECTIONS)[number]

export interface Provenance {
  /** Which system actually answered. */
  source: string
  /** When that system produced this data. */
  fetchedAt: Date
  /** True when the adapter served a cached/stale copy. */
  stale: boolean
}

export type SectionResult<T> =
  | { status: 'ok'; data: T; provenance: Provenance; nextCursor?: string | null }
  | { status: 'unavailable'; reason: string; source: string }
  | { status: 'forbidden' }

export interface ContextBundle {
  version: typeof CONTEXT_BUNDLE_VERSION
  correlationId: string
  companyId: string
  objectType: string
  objectId: string
  workspaceUrl: string | null
  sections: Partial<Record<BundleSection, SectionResult<unknown>>>
  /** Sections that failed. Empty means everything the caller may see was served. */
  degraded: readonly BundleSection[]
  generatedAt: Date
}

export interface BundleAdapter {
  section: BundleSection
  /** Roles allowed to see this section at all. */
  allowedRoles: readonly string[]
  load(input: {
    companyId: string
    objectType: string
    objectId: string
    cursor?: string | null
    limit: number
  }): Promise<{ data: unknown; provenance: Provenance; nextCursor?: string | null }>
}

export interface BundleRequest {
  correlationId: string
  companyId: string
  role: string
  objectType: string
  objectId: string
  sections?: readonly BundleSection[]
  cursors?: Partial<Record<BundleSection, string | null>>
  /** Page size handed to every adapter. Bounded below so one caller cannot ask for everything. */
  limit?: number
}

export const MAX_SECTION_LIMIT = 100
export const DEFAULT_SECTION_LIMIT = 25

export interface BundlePorts {
  adapters: readonly BundleAdapter[]
  workspaceUrlFor(objectType: string, objectId: string, companyId: string): string
  now(): Date
}

/**
 * Build the bundle. Adapters run concurrently and are individually fault-isolated:
 * a throw becomes an `unavailable` section, never a thrown bundle.
 */
export async function buildContextBundle(
  req: BundleRequest,
  ports: BundlePorts,
): Promise<ContextBundle> {
  const limit = Math.min(Math.max(1, req.limit ?? DEFAULT_SECTION_LIMIT), MAX_SECTION_LIMIT)
  const wanted = req.sections?.length ? new Set(req.sections) : null

  const chosen = ports.adapters.filter((a) => (wanted ? wanted.has(a.section) : true))

  const settled = await Promise.all(
    chosen.map(async (adapter): Promise<[BundleSection, SectionResult<unknown>]> => {
      if (!adapter.allowedRoles.includes(req.role)) {
        // Deliberately does NOT say whether the data exists.
        return [adapter.section, { status: 'forbidden' }]
      }
      try {
        const out = await adapter.load({
          companyId: req.companyId,
          objectType: req.objectType,
          objectId: req.objectId,
          cursor: req.cursors?.[adapter.section] ?? null,
          limit,
        })
        return [
          adapter.section,
          {
            status: 'ok',
            data: out.data,
            provenance: out.provenance,
            nextCursor: out.nextCursor ?? null,
          },
        ]
      } catch (err) {
        return [
          adapter.section,
          {
            status: 'unavailable',
            reason: err instanceof Error ? err.message : String(err),
            source: adapter.section,
          },
        ]
      }
    }),
  )

  const sections: Partial<Record<BundleSection, SectionResult<unknown>>> = {}
  const degraded: BundleSection[] = []
  for (const [name, result] of settled) {
    sections[name] = result
    if (result.status === 'unavailable') degraded.push(name)
  }

  return {
    version: CONTEXT_BUNDLE_VERSION,
    correlationId: req.correlationId,
    companyId: req.companyId,
    objectType: req.objectType,
    objectId: req.objectId,
    workspaceUrl: ports.workspaceUrlFor(req.objectType, req.objectId, req.companyId),
    sections,
    degraded,
    generatedAt: ports.now(),
  }
}
