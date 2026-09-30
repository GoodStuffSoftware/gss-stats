// Page navigation model (layout version 12): the pure helpers behind the breadcrumb, the page
// drawer, the / search and the page operations in App.vue. Pages carry a `group` (a plain string),
// drill pages a `parentId` naming their ROOT page (lib/defaults.ts normDrillLinks keeps that true on
// every load), and the default page (★ Overview) is shown pinned first, outside the groups.
import type { DashboardPage, GlobalFilters } from '../types'
import { rangeLabel } from './range'

/** The separator between the parts of a drill page's name: "Country: DE › mobile". */
export const DRILL_TRAIL_SEP = ' › '

/** The pinned page (★ Overview): the default page. */
export function isPinnedPage(p: Pick<DashboardPage, 'isDefault'>): boolean {
  return p.isDefault
}

/** The root page a drill page nests under, or undefined for a root page (or a stale link). */
export function parentOf(p: DashboardPage, pages: readonly DashboardPage[]): DashboardPage | undefined {
  if (!p.parentId) return undefined
  const parent = pages.find((x) => x.id === p.parentId)
  return parent && parent.id !== p.id ? parent : undefined
}

/** The page itself for a root page, its root page for a drill page. */
export function rootOf(p: DashboardPage, pages: readonly DashboardPage[]): DashboardPage {
  return parentOf(p, pages) ?? p
}

/** The drill pages nested under `rootId`, in array order. */
export function drillChildren(rootId: string, pages: readonly DashboardPage[]): DashboardPage[] {
  return pages.filter((p) => p.parentId === rootId && p.id !== rootId)
}

const sameSet = (a: readonly string[] = [], b: readonly string[] = []) => a.length === b.length && a.every((x) => b.includes(x))

/** The name of a new drill page: what its filters add to its ROOT page's, as a trail joined with
 * " › " — a site pick that differs from the root's, each drill constraint the root doesn't have,
 * an absolute date range that differs from the root's, and finally `dateLabel` (a day drilled into
 * just now, which is also the page's range). A drill from a drill page carries the earlier parts
 * forward ("mobile › Germany"); a drill that REPLACES a constraint on the same dimension shows only
 * the new value. The root's own site pick is not repeated (the breadcrumb already shows the root).
 * `siteLabel` turns a site token into its display name. "Filtered" when nothing differs. */
export function drillTrail(filters: GlobalFilters, root: GlobalFilters, siteLabel: (token: string) => string, dateLabel?: string): string {
  const parts: string[] = []
  const sel = filters.siteSel ?? []
  if (!sameSet(sel, root.siteSel ?? [])) parts.push(sel.length === 1 ? siteLabel(sel[0]) : sel.length > 1 ? `${sel.length} sites` : 'All sites')
  const rootDrill = root.drill ?? []
  for (const d of filters.drill ?? []) if (!rootDrill.some((r) => r.key === d.key && r.value === d.value)) parts.push(d.label)
  if (dateLabel) parts.push(dateLabel)
  else if (!filters.rangeRel && (root.rangeRel || filters.since !== root.since || filters.until !== root.until)) {
    const r = rangeLabel(filters.since, filters.until, '')
    if (r) parts.push(r)
  }
  return parts.join(DRILL_TRAIL_SEP) || 'Filtered'
}
