/**
 * Isola Workspace — the module icon lookup.
 *
 * A module descriptor carries `icon` as a STRING, because descriptors must stay serializable
 * to survive server-side entitlement filtering before they ever reach the browser (see
 * `contracts.ts`). This is the single place that string becomes a component.
 *
 * An unknown name renders a neutral glyph rather than throwing or rendering nothing: a
 * newly registered module with a typo in its icon key should still be reachable in the
 * sheet, and a missing picture is not a reason to deny an operator a capability.
 *
 * Icons here are always decorative — the label beside them is the accessible name — so
 * `aria-hidden` is not optional and not exposed as a prop.
 */

import type { JSX } from 'react'
import {
  Circle,
  CheckSquare,
  Phone,
  Receipt,
  Sparkles,
  Sun,
  User,
} from 'lucide-react'

import { cn } from '@/lib/utils'

const ICONS: Record<string, typeof Circle> = {
  user: User,
  'check-square': CheckSquare,
  sparkles: Sparkles,
  sun: Sun,
  phone: Phone,
  receipt: Receipt,
}

export function IsoIcon(props: {
  name: string
  size?: number
  className?: string
}): JSX.Element {
  const { name, size = 16, className } = props
  const Glyph = ICONS[name] ?? Circle

  return <Glyph size={size} aria-hidden="true" className={cn('flex-none', className)} />
}
