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

// ── The page tree ───────────────────────────────────────────────────────────────────────────
/** A root page and the drill pages nested under it. */
export interface NavNode {
  page: DashboardPage
  children: DashboardPage[]
}
export interface NavGroup {
  name: string
  nodes: NavNode[]
}
/** What the breadcrumb, the drawer and the search show: ★ Overview (the default page) pinned first
 * with its drill pages, then each group — in the order groups first appear among the root pages —
 * with its root pages in array order, each followed by its drill pages. A page whose parent link
 * is stale counts as a root page. Groups with no root page (e.g. "All sites" when only ★ Overview
 * is in it) are left out. */
export interface NavTree {
  pinned: NavNode | null
  groups: NavGroup[]
}
export function navTree(pages: readonly DashboardPage[]): NavTree {
  const kids = (id: string) => drillChildren(id, pages)
  const roots = pages.filter((p) => !parentOf(p, pages))
  const pinnedPage = roots.find(isPinnedPage)
  const groups: NavGroup[] = []
  for (const p of roots) {
    if (p === pinnedPage) continue
    let g = groups.find((x) => x.name === p.group)
    if (!g) groups.push((g = { name: p.group, nodes: [] }))
    g.nodes.push({ page: p, children: kids(p.id) })
  }
  return { pinned: pinnedPage ? { page: pinnedPage, children: kids(pinnedPage.id) } : null, groups }
}

/** Every page in navigation order (navTree, flattened). */
export function navOrder(pages: readonly DashboardPage[]): DashboardPage[] {
  const t = navTree(pages)
  const out: DashboardPage[] = []
  if (t.pinned) out.push(t.pinned.page, ...t.pinned.children)
  for (const g of t.groups) for (const n of g.nodes) out.push(n.page, ...n.children)
  return out
}

/** Every group name in use (the pinned page's included), in first-appearance order — the groups
 * "Move to group" offers. */
export function groupNames(pages: readonly DashboardPage[]): string[] {
  return [...new Set(pages.map((p) => p.group))]
}

/** The root pages of a group (not the pinned page), in array order. */
export function rootsInGroup(group: string, pages: readonly DashboardPage[]): DashboardPage[] {
  return navTree(pages).groups.find((g) => g.name === group)?.nodes.map((n) => n.page) ?? []
}

/** The page picking a group opens: the page this viewer last viewed in it (if it's still there and
 * still in that group), else the group's first page. */
export function groupLandingPage(group: string, pages: readonly DashboardPage[], lastByGroup: Readonly<Record<string, string>> = {}): DashboardPage | undefined {
  const last = Object.hasOwn(lastByGroup, group) ? pages.find((p) => p.id === lastByGroup[group]) : undefined
  if (last && !isPinnedPage(rootOf(last, pages)) && rootOf(last, pages).group === group) return last
  return rootsInGroup(group, pages)[0]
}

// ── / search ────────────────────────────────────────────────────────────────────────────────
export interface SearchHit {
  page: DashboardPage
  /** 'name': the page name matched; 'chart': one of its chart titles did; 'all': empty query. */
  match: 'name' | 'chart' | 'all'
  /** The chart title that matched (match 'chart'). */
  chart?: string
  /** Where the query sits in the matched text (the name, or `chart`), for highlighting. */
  at: number
  len: number
}
export const SEARCH_LIMIT = 50
/** The / search: pages whose NAME contains the query first (a name starting with it, then one
 * with a word starting with it, then the rest; each in navigation order), then pages matched only
 * by a CHART TITLE, each page once. Case-insensitive. An empty query lists every page. */
export function searchPages(query: string, pages: readonly DashboardPage[]): SearchHit[] {
  const order = navOrder(pages)
  const q = query.trim().toLowerCase()
  if (!q) return order.slice(0, SEARCH_LIMIT).map((page) => ({ page, match: 'all', at: -1, len: 0 }))
  const rank = (name: string, at: number) => (at === 0 ? 0 : /\s|[·›/:\-(]/.test(name[at - 1] ?? '') ? 1 : 2)
  const byName = order
    .map((page, i) => {
      const at = page.name.toLowerCase().indexOf(q)
      return { page, at, i, r: at < 0 ? 9 : rank(page.name, at) }
    })
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ page, at }): SearchHit => ({ page, match: 'name', at, len: q.length }))
  const named = new Set(byName.map((h) => h.page.id))
  const byChart: SearchHit[] = []
  for (const page of order) {
    if (named.has(page.id)) continue
    for (const w of page.widgets) {
      const at = (w.title ?? '').toLowerCase().indexOf(q)
      if (at >= 0) {
        byChart.push({ page, match: 'chart', chart: w.title, at, len: q.length })
        break
      }
    }
  }
  return [...byName, ...byChart].slice(0, SEARCH_LIMIT)
}

/** `text` split around the matched range, for rendering the match highlighted (never as HTML). */
export function highlightParts(text: string, at: number, len: number): { text: string; mark: boolean }[] {
  if (at < 0 || len <= 0 || at >= text.length) return [{ text, mark: false }]
  return [
    { text: text.slice(0, at), mark: false },
    { text: text.slice(at, at + len), mark: true },
    { text: text.slice(at + len), mark: false },
  ].filter((p) => p.text)
}
