/**
 * Isola Workspace — shared presentational primitives.
 *
 * Every component behind this barrel is pure: props in, markup out. No hooks, no state, no
 * effects, no fetching, no `"use client"`. That is not a stylistic preference — it is what
 * lets these render on the server, inside the embedded conversation panel, and be asserted
 * directly against their static markup in tests without a DOM.
 *
 * Two rules the whole set obeys:
 *   1. Colour is never the only signal. Every state carries words.
 *   2. Nothing branches on theme. Dark mode is a value swap on the same `--iso-*` names.
 */

export { Alert, type AlertVariant } from './alert'
export { DegradedState } from './degraded-state'
export { EmptyState, type EmptyStateVariant } from './empty-state'
export { ExpandableDetails } from './expandable-details'
export { IsoIcon } from './icon'
export { KeyValueGrid } from './key-value-grid'
export { CustomerPanelSkeleton, LoadingSkeleton } from './loading-skeleton'
export { ReadbackResult } from './readback-result'
export { SOURCE_LABEL, SOURCE_SUBJECT, SourceBadge } from './source-badge'
export { StatusBadge } from './status-badge'
export { Timeline } from './timeline'
