// Page navigation model (layout version 13): the pure helpers behind the breadcrumb, the page
// drawer, the / search and the page and group operations in App.vue. Pages carry a `group` (a plain
// string), drill pages a `parentId` naming their IMMEDIATE parent (a drill from a drill page nests
// under it; lib/defaults.ts normDrillLinks keeps the tree valid on every load), groups an optional
// order (DashboardConfig.groupOrder, which also keeps empty groups), and the default page
// (★ Overview) is shown pinned first, outside the groups.
import type { DashboardConfig, DashboardPage, GlobalFilters, GroupMeta } from '../types'
import { cleanGroupName, cleanPageName, GROUP_MINE, MAX_DRILL_DEPTH, unionGroupOrder } from './defaults'
import { rangeLabel } from './range'

/** The separator between the parts of a drill trail and of a page's path: "Traffic › mobile". */
export const DRILL_TRAIL_SEP = ' › '

/** The pinned page (★ Overview): the default page. */
export function isPinnedPage(p: Pick<DashboardPage, 'isDefault'>): boolean {
  return p.isDefault
}

// ── The drill tree ──────────────────────────────────────────────────────────────────────────
/** The page a drill page was drilled from (its immediate parent), or undefined for a top-level
 * page (or a stale link). */
export function parentOf(p: DashboardPage, pages: readonly DashboardPage[]): DashboardPage | undefined {
  if (!p.parentId) return undefined
  const parent = pages.find((x) => x.id === p.parentId)
  return parent && parent.id !== p.id ? parent : undefined
}

/** A page's ancestors, nearest first (its parent, its parent's parent, … its top-level page).
 * Stops at a loop, so it is safe on any data. */
export function ancestorsOf(p: DashboardPage, pages: readonly DashboardPage[]): DashboardPage[] {
  const out: DashboardPage[] = []
  const seen = new Set([p.id])
  let cur = parentOf(p, pages)
  while (cur && !seen.has(cur.id)) {
    out.push(cur)
    seen.add(cur.id)
    cur = parentOf(cur, pages)
  }
  return out
}

/** The page itself for a top-level page, else its top-level page. */
export function rootOf(p: DashboardPage, pages: readonly DashboardPage[]): DashboardPage {
  return ancestorsOf(p, pages).at(-1) ?? p
}

/** How deep a page is: 0 for a top-level page, 1 for its drill pages, 2 for theirs, … */
export function depthOf(p: DashboardPage, pages: readonly DashboardPage[]): number {
  return ancestorsOf(p, pages).length
}

/** The page's path from its top-level page down to itself. */
export function pathOf(p: DashboardPage, pages: readonly DashboardPage[]): DashboardPage[] {
  return [...ancestorsOf(p, pages).reverse(), p]
}

/** The drill pages made from `id` (its children), in array order. */
export function childrenOf(id: string, pages: readonly DashboardPage[]): DashboardPage[] {
  return pages.filter((p) => p.parentId === id && p.id !== id)
}

/** Every drill page under `id`, at any depth, in tree order (each page followed by its own). */
export function descendantsOf(id: string, pages: readonly DashboardPage[]): DashboardPage[] {
  const out: DashboardPage[] = []
  const seen = new Set([id])
  const walk = (pid: string) => {
    for (const k of childrenOf(pid, pages)) {
      if (seen.has(k.id)) continue
      seen.add(k.id)
      out.push(k)
      walk(k.id)
    }
  }
  walk(id)
  return out
}

/** The page a new drill made from `from` nests under: `from` itself, unless it is already
 * MAX_DRILL_DEPTH deep — then its ancestor one level up (the deepest one allowed a child). */
export function drillParentFor(from: DashboardPage, pages: readonly DashboardPage[]): DashboardPage {
  const up = ancestorsOf(from, pages)
  if (up.length < MAX_DRILL_DEPTH) return from
  return up[up.length - MAX_DRILL_DEPTH]
}

const sameSet = (a: readonly string[] = [], b: readonly string[] = []) => a.length === b.length && a.every((x) => b.includes(x))

/** The name of a new drill page: what its filters add to its PARENT page's (the page it was drilled
 * from) — the tree shows the rest of the path. A site pick that differs from the parent's, each
 * drill constraint the parent doesn't have, an absolute date range that differs from the parent's,
 * and finally `dateLabel` (a day drilled into just now, which is also the page's range), joined
 * with " › ". A drill that REPLACES a constraint on the same dimension shows only the new value.
 * `siteLabel` turns a site token into its display name. "Filtered" when nothing differs. */
export function drillTrail(filters: GlobalFilters, parent: GlobalFilters, siteLabel: (token: string) => string, dateLabel?: string): string {
  const parts: string[] = []
  const sel = filters.siteSel ?? []
  if (!sameSet(sel, parent.siteSel ?? [])) parts.push(sel.length === 1 ? siteLabel(sel[0]) : sel.length > 1 ? `${sel.length} sites` : 'All sites')
  const parentDrill = parent.drill ?? []
  for (const d of filters.drill ?? []) if (!parentDrill.some((r) => r.key === d.key && r.value === d.value)) parts.push(d.label)
  if (dateLabel) parts.push(dateLabel)
  else if (!filters.rangeRel && (parent.rangeRel || filters.since !== parent.since || filters.until !== parent.until)) {
    const r = rangeLabel(filters.since, filters.until, '')
    if (r) parts.push(r)
  }
  return parts.join(DRILL_TRAIL_SEP) || 'Filtered'
}

// ── The page tree ───────────────────────────────────────────────────────────────────────────
/** A page and the drill pages made from it, each with its own. */
export interface NavNode {
  page: DashboardPage
  children: NavNode[]
}
export interface NavGroup {
  name: string
  /** Its top-level pages (empty for a group with no page yet). */
  nodes: NavNode[]
}
/** What the breadcrumb, the drawer and the search show: ★ Overview (the default page) pinned first
 * with its drill tree, then each group — in `groupOrder` order, then any other group in the order
 * it first appears among the top-level pages — with its top-level pages in array order, each with
 * its drill tree. A page whose parent link is stale counts as a top-level page. A group with no
 * top-level page shows only when `groupOrder` lists it. */
export interface NavTree {
  pinned: NavNode | null
  groups: NavGroup[]
}
function nodeOf(p: DashboardPage, pages: readonly DashboardPage[], seen: Set<string>): NavNode {
  seen.add(p.id)
  return { page: p, children: childrenOf(p.id, pages).filter((k) => !seen.has(k.id)).map((k) => nodeOf(k, pages, seen)) }
}
export function navTree(pages: readonly DashboardPage[], groupOrder?: readonly string[]): NavTree {
  const seen = new Set<string>()
  const roots = pages.filter((p) => !parentOf(p, pages))
  const pinnedPage = roots.find(isPinnedPage)
  const groups: NavGroup[] = orderedGroups(pages, groupOrder).map((name) => ({ name, nodes: [] }))
  for (const p of roots) {
    if (p === pinnedPage) continue
    let g = groups.find((x) => x.name === p.group)
    if (!g) groups.push((g = { name: p.group, nodes: [] }))
    g.nodes.push(nodeOf(p, pages, seen))
  }
  return { pinned: pinnedPage ? nodeOf(pinnedPage, pages, seen) : null, groups }
}

/** A node's pages in tree order (the page, then its drill pages, each followed by its own). */
export function flattenNode(n: NavNode): DashboardPage[] {
  return [n.page, ...n.children.flatMap(flattenNode)]
}

/** Every page in navigation order (navTree, flattened). */
export function navOrder(pages: readonly DashboardPage[], groupOrder?: readonly string[]): DashboardPage[] {
  const t = navTree(pages, groupOrder)
  const out: DashboardPage[] = []
  if (t.pinned) out.push(...flattenNode(t.pinned))
  for (const g of t.groups) for (const n of g.nodes) out.push(...flattenNode(n))
  return out
}

/** Every group, in display order: `groupOrder` (empty groups included), then the groups the
 * top-level pages use that it misses, in the order they first appear. */
export function orderedGroups(pages: readonly DashboardPage[], groupOrder?: readonly string[]): string[] {
  return unionGroupOrder(groupOrder ?? [], pages)
}

/** Every group name in use (the pinned page's included), in first-appearance order. */
export function groupNames(pages: readonly DashboardPage[]): string[] {
  return [...new Set(pages.map((p) => p.group))]
}

/** The top-level pages of a group (not the pinned page), in array order. */
export function rootsInGroup(group: string, pages: readonly DashboardPage[]): DashboardPage[] {
  return pages.filter((p) => !isPinnedPage(p) && !parentOf(p, pages) && p.group === group)
}

/** The page picking a group opens: the page this viewer last viewed in it (if it's still there and
 * still in that group), else the group's first page. */
export function groupLandingPage(group: string, pages: readonly DashboardPage[], lastByGroup: Readonly<Record<string, string>> = {}): DashboardPage | undefined {
  const last = Object.hasOwn(lastByGroup, group) ? pages.find((p) => p.id === lastByGroup[group]) : undefined
  if (last && !isPinnedPage(rootOf(last, pages)) && rootOf(last, pages).group === group) return last
  return rootsInGroup(group, pages)[0]
}

/** The page's path as text: "Traffic › mobile › California". */
export function pathLabel(p: DashboardPage, pages: readonly DashboardPage[]): string {
  return pathOf(p, pages)
    .map((x) => x.name)
    .join(DRILL_TRAIL_SEP)
}

// ── Page operations ─────────────────────────────────────────────────────────────────────────
/** The pages deleting `id` removes: the page and every drill page under it (asked about once). */
export function pagesToDelete(id: string, pages: readonly DashboardPage[]): string[] {
  return [id, ...descendantsOf(id, pages).map((p) => p.id)]
}

/** Where the viewer lands when the page they're on goes away with `deleted` (the page someone
 * deleted; its drill pages go too): the nearest ancestor of `deleted` that is left, else the
 * top-level page before it in its group, else that group's first page, else ★ Overview (the
 * default page), else the first page. `before` is the page list before the delete, `after` after. */
export function landingAfterDelete(deleted: DashboardPage, before: readonly DashboardPage[], after: readonly DashboardPage[]): DashboardPage | undefined {
  const left = (p: DashboardPage | undefined) => (p ? after.find((x) => x.id === p.id) : undefined)
  for (const a of ancestorsOf(deleted, before)) {
    const kept = left(a)
    if (kept) return kept
  }
  if (!isPinnedPage(deleted)) {
    const peers = rootsInGroup(deleted.group, before)
    const at = peers.findIndex((p) => p.id === deleted.id)
    for (let i = at - 1; i >= 0; i--) {
      const kept = left(peers[i])
      if (kept) return kept
    }
    const first = rootsInGroup(deleted.group, after)[0]
    if (first) return first
  }
  return after.find(isPinnedPage) ?? after[0]
}

/** Place `moving` (pages already carrying `group`) after the last page of `group` in `rest` — the
 * end of the list for a group with no page there. */
function placeInGroup(rest: readonly DashboardPage[], moving: readonly DashboardPage[], group: string): DashboardPage[] {
  let at = -1
  rest.forEach((x, i) => {
    if (x.group === group) at = i
  })
  return at < 0 ? [...rest, ...moving] : [...rest.slice(0, at + 1), ...moving, ...rest.slice(at + 1)]
}

/** A new top-level page joins `group`, after the pages already in it. */
export function insertPageInGroup(pages: readonly DashboardPage[], page: DashboardPage, group: string): DashboardPage[] {
  return placeInGroup(pages, [{ ...page, group }], group)
}

/** "Move to group": the page and every drill page under it join `group`, placed after the pages
 * already in it (a new group goes last). A drill page becomes a top-level page there (its link to
 * its parent is dropped; its own drill pages come with it) — even when `group` is the group it
 * already sits in. ★ Overview (pinned, outside the groups) doesn't move. Returns the new page list —
 * the same array when nothing moves — with the moved pages as new objects (their widgets and
 * filters untouched). */
export function movePageToGroup(pages: readonly DashboardPage[], id: string, group: string): readonly DashboardPage[] {
  const p = pages.find((x) => x.id === id)
  if (!p || !group || isPinnedPage(p)) return pages
  const drill = !!parentOf(p, pages)
  if (!drill && p.group === group) return pages
  const movingIds = new Set(pagesToDelete(id, pages))
  const moving = pages
    .filter((x) => movingIds.has(x.id))
    .map((x) => {
      const next: DashboardPage = { ...x, group }
      if (x.id === id) delete next.parentId
      return next
    })
  return placeInGroup(
    pages.filter((x) => !movingIds.has(x.id)),
    moving,
    group,
  )
}

// ── Names ───────────────────────────────────────────────────────────────────────────────────
/** Why `raw` can't be a page name, or null: only an empty name is refused. */
export function pageNameError(raw: string): string | null {
  return cleanPageName(raw) ? null : 'Give the page a name.'
}

/** Why `raw` can't be the name of a new group — or of group `self` renamed — or null: it's empty, or
 * another group already has that name (compared ignoring case, so "mine" can't sit next to "Mine";
 * renaming a group to a different case of its own name is fine). */
export function groupNameError(raw: string, groups: readonly string[], self?: string): string | null {
  const name = cleanGroupName(raw)
  if (!name) return 'Give the group a name.'
  const lower = name.toLowerCase()
  const clash = groups.find((g) => g !== self && g.toLowerCase() === lower)
  return clash ? `There's already a group called "${clash}".` : null
}

/** What is being renamed in place, and where its field is: a page (by id) or a group (by name), in
 * the page drawer or the header breadcrumb. */
export interface RenameTarget {
  kind: 'page' | 'group'
  key: string
  where: 'drawer' | 'crumb'
}

// ── Group operations ────────────────────────────────────────────────────────────────────────
/** The part of the config the group operations change. */
export type GroupState = Pick<DashboardConfig, 'pages' | 'groupOrder' | 'groupMeta'>
export interface GroupResult {
  pages: DashboardPage[]
  groupOrder: string[]
  groupMeta?: Record<string, GroupMeta>
}

/** A new group, empty, listed last (moving pages into it is movePageToGroup's job). null when the
 * name is refused (groupNameError). */
export function addGroup(state: GroupState, raw: string): GroupResult | null {
  const groups = orderedGroups(state.pages, state.groupOrder)
  if (groupNameError(raw, groups)) return null
  return { pages: [...state.pages], groupOrder: [...groups, cleanGroupName(raw)], groupMeta: state.groupMeta }
}

/** Rename a group, everywhere at once: every page filed under it (★ Overview and drill pages
 * included), its place in the group order and its badge settings (groupMeta). Renaming onto another
 * group's name is refused — never a silent merge. */
export function renameGroup(state: GroupState, from: string, raw: string): { ok: true; result: GroupResult } | { ok: false; error: string } {
  const groups = orderedGroups(state.pages, state.groupOrder)
  if (!groups.includes(from)) return { ok: false, error: `There's no group called "${from}".` }
  const error = groupNameError(raw, groups, from)
  if (error) return { ok: false, error }
  const to = cleanGroupName(raw)
  const pages = state.pages.map((p) => (p.group === from ? { ...p, group: to } : p))
  const groupOrder = groups.map((g) => (g === from ? to : g))
  let groupMeta = state.groupMeta
  if (groupMeta && (Object.hasOwn(groupMeta, from) || Object.hasOwn(groupMeta, to))) {
    const next: Record<string, GroupMeta> = {}
    for (const [k, v] of Object.entries(groupMeta)) if (k !== from && k !== to) next[k] = v
    if (Object.hasOwn(groupMeta, from)) next[to] = groupMeta[from]
    groupMeta = Object.keys(next).length ? next : undefined
  }
  return { ok: true, result: { pages, groupOrder, groupMeta } }
}

/** Where "Delete group" can send a group's pages: every other group, plus "Mine" if it isn't one
 * (and isn't the group going away); `fallback` is "Mine", or the first other group when "Mine" is
 * the one being deleted (null when there is nowhere to go). */
export function deleteGroupTargets(name: string, groups: readonly string[]): { options: string[]; fallback: string | null } {
  const options = groups.filter((g) => g !== name)
  if (name !== GROUP_MINE && !options.includes(GROUP_MINE)) options.push(GROUP_MINE)
  const fallback = name !== GROUP_MINE ? GROUP_MINE : (options[0] ?? null)
  return { options, fallback }
}

/** Delete a group: its pages (each with its drill pages) move to `dest`, after the pages already
 * there, in their order; the group leaves the group order and groupMeta. ★ Overview never moves,
 * whatever group it is filed under. null when the group has pages and `dest` is not somewhere else
 * to put them. */
export function deleteGroup(state: GroupState, name: string, dest: string | null): GroupResult | null {
  const groups = orderedGroups(state.pages, state.groupOrder)
  const roots = rootsInGroup(name, state.pages)
  const target = dest ? cleanGroupName(dest) : ''
  if (roots.length && (!target || target === name)) return null
  let pages: readonly DashboardPage[] = state.pages
  for (const r of roots) pages = movePageToGroup(pages, r.id, target)
  let groupOrder = groups.filter((g) => g !== name)
  if (roots.length && !groupOrder.includes(target)) groupOrder = [...groupOrder, target]
  let groupMeta = state.groupMeta
  if (groupMeta && Object.hasOwn(groupMeta, name)) {
    const { [name]: _gone, ...rest } = groupMeta
    groupMeta = Object.keys(rest).length ? rest : undefined
  }
  return { pages: [...pages], groupOrder, groupMeta }
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
export function searchPages(query: string, pages: readonly DashboardPage[], groupOrder?: readonly string[]): SearchHit[] {
  const order = navOrder(pages, groupOrder)
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
