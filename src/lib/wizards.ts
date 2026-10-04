// The "+ New" wizards in the page drawer (components/nav/WizardCarousel.vue runs them): a small
// registry of what can be created, each a few steps long, plus the pure logic behind each — its
// draft, when a step is complete (the Forward button waits for it), and what Create does to the
// config. Adding a kind of thing to create = a WizardDef here, its draft/step checks/apply, and its
// step content in components/nav/NewWizards.vue.
import type { Component } from 'vue'
import type { DashboardPage } from '../types'
import {
  clonePage,
  cleanGroupName,
  cleanPageName,
  cryptoId,
  defaultBeaconPage,
  defaultBestSudokuLaunchPage,
  defaultBestSudokuPopupsPage,
  defaultCampaignComparePage,
  defaultFilters,
  defaultOverviewPage,
  defaultPage,
  defaultRetentionPage,
  defaultWidgetsForPage,
} from './defaults'
import { addGroup, groupNameError, insertPageInGroup, isPinnedPage, movePageToGroup, navTree, orderedGroups, pageNameError, type GroupResult, type GroupState } from './nav'
import { NewGroupIcon, NewPageIcon, type IconKey } from './icons'

export interface WizardStep {
  id: string
  title: string
}
export interface WizardDef {
  id: string
  label: string
  /** One line under the label in the "+ New" menu. */
  description: string
  icon: Component
  steps: readonly WizardStep[]
}

export const PAGE_WIZARD: WizardDef = {
  id: 'page',
  label: 'Page',
  description: 'A page of charts, in any group',
  icon: NewPageIcon,
  steps: [
    { id: 'name', title: 'Name' },
    { id: 'group', title: 'Group' },
    { id: 'start', title: 'Start from' },
  ],
}
export const GROUP_WIZARD: WizardDef = {
  id: 'group',
  label: 'Group',
  description: 'A group to file pages under',
  icon: NewGroupIcon,
  steps: [
    { id: 'name', title: 'Name' },
    { id: 'pages', title: 'Pages' },
    { id: 'review', title: 'Review' },
  ],
}
/** What "+ New" offers, in menu order. */
export const WIZARDS: readonly WizardDef[] = [PAGE_WIZARD, GROUP_WIZARD]

// ── New page ────────────────────────────────────────────────────────────────────────────────
/** A built-in page whose default charts (and filters) a new page can start from. */
export interface PageTemplate {
  id: string
  label: string
  make: () => DashboardPage
}
export const PAGE_TEMPLATES: readonly PageTemplate[] = [
  { id: 'tpl-default', label: 'Overview (all sites)', make: defaultPage },
  { id: 'tpl-beacon', label: 'Beacon', make: defaultBeaconPage },
  { id: 'tpl-bsk-overview', label: 'Best Sudoku · Overview', make: defaultOverviewPage },
  { id: 'tpl-bsk-campaigns', label: 'Best Sudoku · Campaigns', make: defaultCampaignComparePage },
  { id: 'tpl-bsk-popups', label: 'Best Sudoku · Pop-ups', make: defaultBestSudokuPopupsPage },
  { id: 'tpl-bsk-launch', label: 'Best Sudoku · Traffic', make: defaultBestSudokuLaunchPage },
  { id: 'tpl-bsk-retention', label: 'Best Sudoku · Retention', make: defaultRetentionPage },
]

export interface PageDraft {
  name: string
  /** An existing group, or a new one named `newGroup`. */
  groupMode: 'existing' | 'new'
  group: string
  newGroup: string
  /** 'blank', 'duplicate' (the page on screen) or a PAGE_TEMPLATES id. */
  start: string
  /** A picked icon, or null for Auto. */
  icon: IconKey | null
}
export function newPageDraft(group: string): PageDraft {
  return { name: '', groupMode: 'existing', group, newGroup: '', start: 'blank', icon: null }
}
/** The group the new page goes into. */
export function pageDraftGroup(d: PageDraft): string {
  return d.groupMode === 'new' ? cleanGroupName(d.newGroup) : d.group
}
/** Why a step of the page wizard isn't complete yet, or null. */
export function pageStepError(step: string, d: PageDraft, groups: readonly string[]): string | null {
  if (step === 'name') return pageNameError(d.name)
  if (step === 'group') {
    if (d.groupMode === 'new') return groupNameError(d.newGroup, groups)
    return groups.includes(d.group) ? null : 'Pick a group.'
  }
  if (step === 'start') return d.start === 'blank' || d.start === 'duplicate' || PAGE_TEMPLATES.some((t) => t.id === d.start) ? null : 'Pick what to start from.'
  return null
}
/** The new page (not yet placed): a blank page, a copy of `current` (the page on screen) or a
 * built-in page's default charts and filters — always a top-level page with fresh ids, in the
 * draft's group, with the picked icon or none (Auto). */
export function buildPage(d: PageDraft, current: DashboardPage): DashboardPage {
  const name = cleanPageName(d.name)
  const group = pageDraftGroup(d)
  let page: DashboardPage
  const tpl = PAGE_TEMPLATES.find((t) => t.id === d.start)
  if (tpl) {
    const src = tpl.make()
    page = clonePage({ ...src, widgets: defaultWidgetsForPage(src) }, name)
  } else if (d.start === 'duplicate') page = clonePage(current, name)
  else page = { id: cryptoId(), name, isDefault: false, group, filters: defaultFilters(), widgets: [] }
  page.group = group
  delete page.parentId
  if (d.icon) page.icon = d.icon
  else delete page.icon
  return page
}
/** Create: the page joins its group after the pages already there; a new group is listed last. */
export function applyPageDraft(state: GroupState, d: PageDraft, current: DashboardPage): { result: GroupResult; page: DashboardPage } {
  const page = buildPage(d, current)
  const groups = orderedGroups(state.pages, state.groupOrder)
  const groupOrder = groups.includes(page.group) ? groups : [...groups, page.group]
  return { result: { pages: insertPageInGroup(state.pages, page, page.group), groupOrder, groupMeta: state.groupMeta }, page }
}

// ── New group ───────────────────────────────────────────────────────────────────────────────
export interface GroupDraft {
  name: string
  /** Top-level pages to move into it (each brings its drill pages). */
  pageIds: string[]
}
export function newGroupDraft(): GroupDraft {
  return { name: '', pageIds: [] }
}
/** Why a step of the group wizard isn't complete yet, or null (picking pages is optional). */
export function groupStepError(step: string, d: GroupDraft, groups: readonly string[]): string | null {
  return step === 'name' ? groupNameError(d.name, groups) : null
}
/** The pages the group wizard offers to move: every top-level page but ★ Overview, in navigation
 * order. */
export function movablePages(pages: readonly DashboardPage[], groupOrder?: readonly string[]): DashboardPage[] {
  return navTree(pages, groupOrder)
    .groups.flatMap((g) => g.nodes.map((n) => n.page))
    .filter((p) => !isPinnedPage(p))
}
/** Create: the group is listed last (even when empty), then the picked pages move into it in
 * navigation order. null when the name is refused. */
export function applyGroupDraft(state: GroupState, d: GroupDraft): GroupResult | null {
  const added = addGroup(state, d.name)
  if (!added) return null
  const name = cleanGroupName(d.name)
  let pages: readonly DashboardPage[] = added.pages
  for (const p of movablePages(state.pages, state.groupOrder)) if (d.pageIds.includes(p.id)) pages = movePageToGroup(pages, p.id, name)
  return { ...added, pages: [...pages] }
}
