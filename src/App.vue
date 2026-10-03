<script setup lang="ts">
import { reactive, shallowReactive, ref, watch, watchEffect, onMounted, onBeforeUnmount, nextTick, computed } from 'vue'
import type { DashboardConfig, DashboardPage, Widget, GlobalFilters, StatsResponse } from './types'
import { defaultConfig, normalizeConfig, defaultWidgetsForPage, clonePage, cryptoId, isBestSudokuLaunchPage, isBestSudokuPopupsPage, isCampaignComparePage, BEST_SUDOKU_SITES, beaconizeWidget, cleanGroupName, cleanPageName } from './lib/defaults'
import { rangeLabel, dayDrillRange } from './lib/range'
import { loadConfig, saveConfig, ConfigLoadError } from './api'
import { loadSites, sitesTree, tokenLabel } from './sitesStore'
import { isSiteDim, semanticKey, drillNeedsEventBeacons } from './lib/drill'
import { sessionExpired, reauth, checkSessionExpired } from './session'
import { readViewerPrefs, writeViewerPrefs, initialPageId, readDarkPref, writeDarkPref } from './lib/viewerPrefs'
import { rootOf, drillTrail, drillParentFor, groupLandingPage, pagesToDelete, movePageToGroup, landingAfterDelete, orderedGroups, pathLabel, renameGroup, deleteGroup, type GroupResult, type RenameTarget } from './lib/nav'
import { applyGroupDraft, applyPageDraft, type GroupDraft, type PageDraft } from './lib/wizards'
import { SearchIcon, MenuIcon, EllipsisIcon, StarIcon, type IconKey } from './lib/icons'
import NavBreadcrumb from './components/nav/NavBreadcrumb.vue'
import SearchPalette from './components/nav/SearchPalette.vue'
import NavDrawer from './components/nav/NavDrawer.vue'
import PageMenu from './components/nav/PageMenu.vue'
import IconPicker from './components/nav/IconPicker.vue'
import GroupBadge from './components/nav/GroupBadge.vue'
import DeleteGroupDialog from './components/nav/DeleteGroupDialog.vue'
import { isTouchDevice } from './lib/responsive'
import { TRACKING_ACTIVATION_DATE_ET } from './lib/popupEvents'
import NoteBlock from './components/NoteBlock.vue'
import FilterBar from './components/FilterBar.vue'
import Dashboard from './components/Dashboard.vue'
import ChartEditor from './components/ChartEditor.vue'
import AccountMenu from './components/AccountMenu.vue'

const config = reactive<DashboardConfig>(defaultConfig())
const loaded = ref(false)
const editing = ref<{ widget: Widget; isNew: boolean } | null>(null)
const dark = ref(false)
const saveState = ref<'idle' | 'saving' | 'saved' | 'error' | 'stale' | 'blocked'>('idle')

// The page currently being viewed/edited — per VIEWER (layout version 13): remembered in this
// browser (lib/viewerPrefs.ts), never written to the shared config, so switching pages costs no KV
// write and never moves anyone else. `config.activePageId` is only the landing page for a viewer
// with nothing remembered (★ Overview).
const activePageId = ref(config.activePageId)
const activePage = computed<DashboardPage>(
  () => config.pages.find((p) => p.id === activePageId.value) ?? config.pages.find((p) => p.isDefault) ?? config.pages[0],
)
const rangeText = computed(() => rangeLabel(activePage.value.filters.since, activePage.value.filters.until, activePage.value.filters.rangeRel))

// Part A hard requirement #4: while pop-up tracking hasn't shipped yet (activation date
// still null — see lib/popupEvents.ts), the pop-ups page carries this note so nothing on
// it reads as a real baseline. Goes away by itself the day TRACKING_ACTIVATION_DATE_ET
// is set to v1.95.3's release date.
const showPopupActivationNote = computed(
  () => TRACKING_ACTIVATION_DATE_ET === null && isBestSudokuPopupsPage(activePage.value),
)

// FINAL LIST page note (Best Sudoku team, 2026-09-25): shown on the pop-ups page whenever
// it's active, independent of the activation-pending note above — even once tracking is
// live, the 30-minute sign-in deferral still makes every correlated rate conservative.
const showPopupDeferredNote = computed(() => isBestSudokuPopupsPage(activePage.value))

// Production is tiny (14 registered users total, 2026-09-26) — every rate on the pop-ups
// page is anecdotal even once "measured". Shown alongside the deferred note above, not a
// replacement for it.
const showSmallSampleNote = computed(() => isBestSudokuPopupsPage(activePage.value))

// "Best Sudoku campaigns" and "Best Sudoku overview" used to be bespoke pages (see git
// history for the retired OverviewPage.vue / CampaignComparePage.vue) — now they're regular
// widget grids like every other page: metric cards (lib/metrics/presets.ts) and standard
// charts, so "Add chart" / "restore default charts" apply to them too. The campaign page still
// hides the global FilterBar (its widgets aren't filter-driven: each card reads its campaign's
// own attribution window, and each chart carries its own range — lib/defaults.ts).
const isCampaignPage = computed(() => isCampaignComparePage(activePage.value))

onMounted(async () => {
  dark.value = readDarkPref()
  applyDark()

  // Load the durable config and the auto-built site tree in parallel; the tree must
  // be ready before charts fetch so the real-host allow-list applies from the start.
  const [stored] = await Promise.all([readStoredLayout(), loadSites()])
  // A failed load still shows the built-in defaults (the charts work), but saving stays off
  // until "Try again" reads the stored layout.
  loadFailed.value = stored === LOAD_FAILED
  applyLayout(stored === LOAD_FAILED ? normalizeConfig(defaultConfig()) : stored)
  await nextTick()
  // What the store holds as far as this tab knows: a save only goes out when the config differs.
  lastPersisted = configJson(config)
  loaded.value = true
  if (!loadFailed.value) rememberActivePage()
})

// ── Loading the stored layout ─────────────────────────────────────────────────
// A tab that could not read the stored layout must never save: what it shows (the built-in
// defaults) is not what the store holds, so its first save would overwrite the real layout.
// loadConfig throws on every failure (network, 401, 5xx, a body that is not a layout); only a
// server answer of "nothing stored" resolves to null, and then the defaults are the layout.
// Normalizing happens inside the same guard: a stored layout that passes loadConfig's shape check
// but cannot be normalized (e.g. a null page) is a failed load too, not a dead editor.
const loadFailed = ref(false)
const retryingLoad = ref(false)
const LOAD_FAILED = Symbol('load failed')
async function readStoredLayout(): Promise<DashboardConfig | typeof LOAD_FAILED> {
  try {
    return normalizeConfig((await loadConfig()) ?? defaultConfig())
  } catch (e) {
    // No answer at all can be an expired Cloudflare Access session (its sign-in redirect fails as a
    // network error): the same confirming probe as every data fetch raises the sign-in banner.
    if (e instanceof ConfigLoadError && e.reason === 'network') void checkSessionExpired()
    return LOAD_FAILED
  }
}
/** Put an already-normalized layout on screen. */
function applyLayout(norm: DashboardConfig) {
  config.version = norm.version
  config.activePageId = norm.activePageId
  config.pages = norm.pages
  config.syncRange = norm.syncRange
  config.groupMeta = norm.groupMeta
  config.groupOrder = norm.groupOrder
  activePageId.value = initialPageId(norm.pages, readViewerPrefs(), norm.activePageId)
}
// "Try again" on the load-failed banner. A successful read replaces whatever is on screen with the
// stored layout (edits made on the stand-in defaults were never saved and are dropped) and turns
// saving back on; a failed one leaves everything as it was, saving still off.
async function retryLoad() {
  if (retryingLoad.value) return
  retryingLoad.value = true
  try {
    clearTimeout(saveTimer)
    const stored = await readStoredLayout()
    if (stored === LOAD_FAILED) return
    // An editor, rename, menu or dialog open on the stand-in points at pages and widgets of a layout
    // that is about to go away; close them all.
    editing.value = null
    renaming.value = null
    groupToDelete.value = null
    iconFor.value = null
    pageMenu.value = null
    drillMenu.value = null
    // What keeps the stand-in from being saved: lastPersisted becomes the stored layout before
    // loadFailed clears, and every save path compares against lastPersisted, so the first save
    // after a retry can only be a real edit of the stored layout. The nextTick only lets the config
    // watcher run while saving is still off; the ordering around it is not load-bearing.
    applyLayout(stored)
    await nextTick()
    lastPersisted = configJson(config)
    saveState.value = 'idle'
    loadFailed.value = false
    rememberActivePage()
  } finally {
    retryingLoad.value = false
  }
}

// Remember this viewer's page (and the page they last viewed in its group, which picking that
// group opens) in this browser only.
function rememberActivePage() {
  const p = activePage.value
  const root = rootOf(p, config.pages)
  const prefs = readViewerPrefs()
  prefs.active = p.id
  if (!root.isDefault) prefs.lastByGroup = { ...prefs.lastByGroup, [root.group]: p.id }
  writeViewerPrefs(prefs)
}
watch(activePageId, () => {
  if (loaded.value && !loadFailed.value) rememberActivePage()
})

// ── Persistence (debounced) ───────────────────────────────────────────────────
let saveTimer: number | undefined
// The config as last loaded or successfully saved: what the server holds. A save whose final state
// equals it is skipped, so neither a fit card that settles back to its stored `h` (it passes through
// a placeholder height while its data loads) nor the grid re-reporting an unchanged layout when you
// switch pages writes the layout.
// One PUT at a time: an edit that lands while a PUT is in flight is flushed when it resolves, and
// compared against what that PUT actually left on the server (a failed PUT leaves the old state), so
// A -> B -> back to A with B still in flight cannot be skipped and leave the server on B.
let lastPersisted = ''
// The body of the PUT awaiting its answer, if any. An edit is judged against it (not just against
// lastPersisted), so reverting while a save is in flight still sends the revert.
let inFlightBody: string | null = null
let putQueued = false
// The label to fall back to when a save is skipped (the one showing before the edit).
let labelBeforeEdit: typeof saveState.value = 'idle'
// The config as saved. grid-layout-plus writes its own bookkeeping (`moved`) onto every widget it
// lays out — the first time each page is shown, so on every page switch — which is not part of the
// layout (normWidget drops it on load): it never counts as a change and is never saved.
function configJson(c: DashboardConfig): string {
  return JSON.stringify(c, function (this: unknown, key: string, value: unknown) {
    return key === 'moved' && this && typeof this === 'object' && 'i' in this && 'x' in this ? undefined : value
  })
}
// Saving is off until the stored layout has been read, while signed out, and after a failed load
// (until "Try again" succeeds): in each case the config on screen is not what the store holds.
function canSave(): boolean {
  return loaded.value && !loadFailed.value && !sessionExpired.value
}
function scheduleSave() {
  if (!canSave()) {
    // An edit on the stand-in layout after a failed load is never sent; say so instead of
    // dropping it silently (the banner explains why and offers "Try again").
    if (loaded.value && loadFailed.value) saveState.value = configJson(config) === lastPersisted ? 'idle' : 'blocked'
    return
  }
  // Nothing differs from what the server holds (or is about to): no save, and no "saving" flash.
  // A timer from an earlier edit still runs, and settles the label if it finds nothing to send.
  if (configJson(config) === (inFlightBody ?? lastPersisted)) {
    // Back on exactly what the server holds, with no PUT in flight: a standing "Save failed" no
    // longer describes anything.
    if (inFlightBody === null && saveState.value === 'error') saveState.value = 'idle'
    return
  }
  if (saveState.value !== 'saving') labelBeforeEdit = saveState.value
  // A stale tab stays labelled stale until it reloads; an edit does not clear that.
  if (saveState.value !== 'stale') saveState.value = 'saving'
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => void flushSave(), 700)
}
// A keepalive request body is capped at 64 KiB (a larger one is rejected), so the pagehide flush
// keeps a margin under it and a bigger layout falls back to the ordinary PUT.
const KEEPALIVE_MAX_BYTES = 60_000
async function flushSave(unloading = false) {
  saveTimer = undefined // the timer has fired (or been cleared): no edit is pending any more
  // The same gate again at send time: nothing scheduled earlier may PUT once saving is off.
  if (!canSave()) {
    if (saveState.value === 'saving') saveState.value = loadFailed.value ? 'blocked' : 'error'
    return
  }
  if (inFlightBody !== null) {
    putQueued = true
    return
  }
  const body = configJson(config)
  if (body === lastPersisted) {
    // Nothing to write. A standing "stale" label stays (the tab is still out of date). A standing
    // "Save failed" does not: the tab is back on exactly what the server holds, so nothing is
    // failing any more.
    if (saveState.value === 'saving') saveState.value = labelBeforeEdit === 'error' ? 'idle' : labelBeforeEdit
    return
  }
  inFlightBody = body
  let ok: boolean | 'stale'
  try {
    const keepalive = unloading && new TextEncoder().encode(body).length < KEEPALIVE_MAX_BYTES
    ok = await saveConfig(JSON.parse(body) as DashboardConfig, { keepalive })
  } finally {
    inFlightBody = null
  }
  if (ok === true) lastPersisted = body
  saveState.value = ok === 'stale' ? 'stale' : ok ? 'saved' : 'error'
  if (putQueued) {
    putQueued = false
    if (ok !== 'stale') await flushSave(unloading)
  }
}
watch(config, scheduleSave, { deep: true })

// Leaving the page: do not sit out the 700 ms debounce. A pending edit is sent now (and the timer
// cleared, so it cannot fire into an unmounted component) as a keepalive PUT, so the browser lets it
// finish after the page is gone. One PUT at a time still holds: if a PUT is already in flight, the edit queues behind it and goes out when that resolves, which a page
// that is really closing may not live to see (the browser cannot be told to wait). Only the edit
// made inside that one in-flight window is at risk, and the next load shows the server's layout.
function flushPendingSave() {
  if (saveTimer === undefined) return
  clearTimeout(saveTimer)
  saveTimer = undefined
  if (loaded.value && !sessionExpired.value) void flushSave(true)
}
onMounted(() => window.addEventListener('pagehide', flushPendingSave))
onBeforeUnmount(() => {
  window.removeEventListener('pagehide', flushPendingSave)
  flushPendingSave()
})

const saveLabel = computed(
  () =>
    ({
      idle: '',
      saving: 'Saving…',
      saved: 'Saved',
      error: 'Save failed',
      stale: 'This tab is out of date, reload',
      blocked: 'Not saved',
    })[saveState.value],
)

// ── Page operations ───────────────────────────────────────────────────────────
// Switching pages is per viewer: it never touches the shared config (see activePageId).
function switchPage(id: string) {
  if (config.pages.some((p) => p.id === id)) activePageId.value = id
}
// Picking a group opens the page this viewer last viewed in it, else its first page.
function switchGroup(group: string) {
  const target = groupLandingPage(group, config.pages, readViewerPrefs().lastByGroup)
  if (target) switchPage(target.id)
}

// + Page: a new ROOT page, a copy of the active one, in its group with its icon (clonePage).
function addPage(group?: string) {
  const src = activePage.value
  const clone = clonePage(src, 'Copy of ' + src.name)
  delete clone.parentId
  clone.group = group ?? rootOf(src, config.pages).group
  config.pages.push(clone)
  switchPage(clone.id)
}
// Duplicate: a copy of that page — same group and icon, and a copy of a drill page stays a drill
// page of the same root.
function duplicatePage(id: string) {
  const src = config.pages.find((p) => p.id === id) ?? activePage.value
  const clone = clonePage(src, 'Copy of ' + src.name)
  config.pages.push(clone)
  switchPage(clone.id)
}
// ── In-place rename ─────────────────────────────────────────────────────────────
// Every name on screen (breadcrumb, drawer, search, the ⋯ menus, the document title) is rendered
// straight from `config`, so a rename shows everywhere at once. `renaming` says which name is being
// edited and where its field is (the drawer row or the breadcrumb segment).
const renaming = ref<RenameTarget | null>(null)
function startRename(t: RenameTarget) {
  renaming.value = t
}
function renamePageTo(id: string, raw: string) {
  renaming.value = null
  const p = config.pages.find((x) => x.id === id)
  const name = cleanPageName(raw)
  if (p && name) p.name = name
}
// The shared config changes in one step: every page in the group, the group order and groupMeta.
function applyGroups(r: GroupResult) {
  config.pages = r.pages
  config.groupOrder = r.groupOrder
  config.groupMeta = r.groupMeta
}
function renameGroupTo(from: string, raw: string) {
  renaming.value = null
  const r = renameGroup(config, from, raw)
  if (!r.ok) return
  const to = cleanGroupName(raw)
  applyGroups(r.result)
  // …and this viewer's own memory of it (collapsed, last page viewed there)
  const prefs = readViewerPrefs()
  if (collapsedGroups.value.includes(from)) {
    collapsedGroups.value = collapsedGroups.value.map((g) => (g === from ? to : g))
    prefs.collapsed = collapsedGroups.value
  }
  if (prefs.lastByGroup && Object.hasOwn(prefs.lastByGroup, from)) {
    const { [from]: last, ...rest } = prefs.lastByGroup
    prefs.lastByGroup = { ...rest, [to]: last }
  }
  writeViewerPrefs(prefs)
}
// Delete group…: its pages go where the dialog says; ★ Overview never moves.
const groupToDelete = ref<{ name: string; returnTo: HTMLElement | null } | null>(null)
function askDeleteGroup(name: string, anchor: HTMLElement | null) {
  groupToDelete.value = { name, returnTo: anchor }
}
function confirmDeleteGroup(name: string, dest: string | null) {
  groupToDelete.value = null
  const r = deleteGroup(config, name, dest)
  if (!r) return
  applyGroups(r)
  if (collapsedGroups.value.includes(name)) {
    collapsedGroups.value = collapsedGroups.value.filter((g) => g !== name)
    writeViewerPrefs({ ...readViewerPrefs(), collapsed: collapsedGroups.value })
  }
}
// + New (the drawer's wizards): a page, put in its group and opened; a group, listed (even empty)
// with the pages picked for it moved in.
function createPage(d: PageDraft) {
  const { result, page } = applyPageDraft(config, d, activePage.value)
  applyGroups(result)
  drawerOpen.value = false
  switchPage(page.id)
}
function createGroup(d: GroupDraft) {
  const r = applyGroupDraft(config, d)
  if (r) applyGroups(r)
}
// Delete: the page and every drill page under it, asked once. ★ Overview (the default page) can't
// be deleted, nor the last page. When the page on screen goes, the viewer lands on its nearest
// ancestor left, else the page before it in its group, else the group's first page, else ★ Overview
// (lib/nav.ts landingAfterDelete).
function deletePage(id: string) {
  const p = config.pages.find((x) => x.id === id)
  if (!p || p.isDefault || config.pages.length <= 1) return
  const gone = new Set(pagesToDelete(id, config.pages))
  if (config.pages.length - gone.size < 1) return
  const drills = gone.size - 1
  const msg = drills
    ? `Delete "${p.name}" and its ${drills} drill page${drills === 1 ? '' : 's'}? This can't be undone.`
    : `Delete page "${p.name}"? This can't be undone.`
  if (!confirm(msg)) return
  const before = [...config.pages]
  config.pages = config.pages.filter((x) => !gone.has(x.id))
  const fallback = config.pages.find((x) => x.isDefault) ?? config.pages[0]
  if (gone.has(config.activePageId)) config.activePageId = fallback.id
  if (gone.has(activePageId.value)) switchPage((landingAfterDelete(p, before, config.pages) ?? fallback).id)
}
// Move to group: the page and its drill pages join the group, after the pages already there (a drill
// page becomes a page of its own there); a group named just now is listed last.
function movePage(id: string, group: string) {
  const g = cleanGroupName(group)
  if (!g) return
  const groups = orderedGroups(config.pages, config.groupOrder)
  config.pages = [...movePageToGroup(config.pages, id, g)]
  config.groupOrder = groups.includes(g) ? groups : [...groups, g]
}
// Change icon…: a registry key, or null for Auto (resolved from the page's charts / its page).
function setIcon(id: string, key: IconKey | null) {
  const p = config.pages.find((x) => x.id === id)
  if (!p) return
  if (key) p.icon = key
  else delete p.icon
}
// ── / search ──────────────────────────────────────────────────────────────────────
const searchOpen = ref(false)
function openSearch() {
  searchOpen.value = true
}
function pickSearchResult(id: string) {
  searchOpen.value = false
  drawerOpen.value = false // it can be opened over the drawer
  switchPage(id)
}
// "/" anywhere opens the search, unless you're typing into a field (or a dialog is open).
function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)
}
function onSlashKey(e: KeyboardEvent) {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
  if (isTypingTarget(e.target) || searchOpen.value || editing.value) return
  // …nor while a menu or another dialog has the keyboard (the drawer is the exception: / searches over it)
  if (pageMenu.value || iconFor.value || drillMenu.value) return
  if (document.querySelector('[role="dialog"][aria-modal="true"]:not(#nav-drawer), dialog[open]')) return
  e.preventDefault()
  openSearch()
}
onMounted(() => document.addEventListener('keydown', onSlashKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onSlashKey))
// ── Page menu, icon picker and page drawer ──────────────────────────────────────
// One ⋯ menu for whichever page it was opened on (the header's is the page on screen), anchored to
// the button that opened it.
const pageMenu = ref<{ id: string; anchor: HTMLElement } | null>(null)
const pageMenuPage = computed(() => (pageMenu.value ? config.pages.find((p) => p.id === pageMenu.value!.id) ?? null : null))
const pageMenuBtn = ref<HTMLElement | null>(null)
function openPageMenu(id: string, anchor: HTMLElement) {
  pageMenu.value = pageMenu.value?.id === id && pageMenu.value.anchor === anchor ? null : { id, anchor }
}
function closePageMenu(reason: 'action' | 'dismiss' = 'dismiss') {
  const anchor = pageMenu.value?.anchor
  pageMenu.value = null
  // After an action, focus goes back to the ⋯ that opened the menu (the icon picker, if that was
  // the action, takes it itself). If that row is gone (deleted), to the drawer's current row.
  if (reason !== 'action') return
  nextTick(() => {
    if (iconFor.value || renaming.value) return
    if (anchor?.isConnected) anchor.focus()
    else document.querySelector<HTMLElement>('#nav-drawer .dr-page[aria-current="page"], #nav-drawer .dr-close')?.focus()
  })
}
const iconFor = ref<{ id: string; returnTo: HTMLElement | null } | null>(null)
const iconPage = computed(() => (iconFor.value ? config.pages.find((p) => p.id === iconFor.value!.id) ?? null : null))
function openIconPicker(id: string) {
  iconFor.value = { id, returnTo: pageMenu.value?.anchor ?? null }
}
function pickIcon(key: IconKey | null) {
  if (iconFor.value) setIcon(iconFor.value.id, key)
  iconFor.value = null
}

const drawerOpen = ref(false)
const drawerBtn = ref<HTMLElement | null>(null)
const collapsedGroups = ref<string[]>(readViewerPrefs().collapsed ?? [])
// Pages whose drill pages this viewer folded away in the drawer (remembered in this browser).
const collapsedPages = ref<string[]>(readViewerPrefs().collapsedPages ?? [])
function togglePageFold(id: string) {
  const next = collapsedPages.value.includes(id) ? collapsedPages.value.filter((x) => x !== id) : [...collapsedPages.value, id]
  collapsedPages.value = next
  writeViewerPrefs({ ...readViewerPrefs(), collapsedPages: next })
}
function renameFromMenu(id: string) {
  startRename({ kind: 'page', key: id, where: pageMenu.value?.anchor.closest('#nav-drawer') ? 'drawer' : 'crumb' })
}
function toggleGroup(name: string) {
  const next = collapsedGroups.value.includes(name) ? collapsedGroups.value.filter((g) => g !== name) : [...collapsedGroups.value, name]
  collapsedGroups.value = next
  writeViewerPrefs({ ...readViewerPrefs(), collapsed: next })
}
function pickFromDrawer(id: string) {
  drawerOpen.value = false
  switchPage(id)
}
// The ☰ button carries the current group's badge (★ on ★ Overview), so the group shows even when
// the breadcrumb is short.
const activeRoot = computed(() => rootOf(activePage.value, config.pages))
// The browser tab says where you are, from the same config as everything else.
watchEffect(() => {
  const r = activeRoot.value
  document.title = `${pathLabel(activePage.value, config.pages)}${r.isDefault ? '' : ` · ${r.group}`} · GSS Stats`
})

function restoreDefaultCharts(id: string) {
  const p = config.pages.find((x) => x.id === id) ?? activePage.value
  const launch = isBestSudokuLaunchPage(p)
  const popups = isBestSudokuPopupsPage(p)
  // If the user has pinned any charts as defaults, restoring keeps exactly those and drops
  // the rest. Otherwise fall back to the factory set for this page. The Best Sudoku launch
  // page additionally re-points its charts at the beacon and resets the site buckets; the
  // pop-ups page resets its site buckets the same way (its factory set is already pop-up).
  const marked = p.widgets.filter((w) => w.isDefault)
  const msg = marked.length
    ? `Restore "${p.name}" to your default charts? Charts not set as default will be removed.`
    : launch
      ? `Reset "${p.name}"? Every chart switches to the beacon data source (your layout is kept).`
      : `Restore "${p.name}" to the default charts? Custom charts on this page will be replaced.`
  if (!confirm(msg)) return

  let next = marked.length ? marked : launch ? p.widgets : defaultWidgetsForPage(p)
  if (launch) next = next.map(beaconizeWidget)
  if (launch || popups) p.filters.siteSel = [...BEST_SUDOKU_SITES]
  p.widgets = next
}

// ── Filters ───────────────────────────────────────────────────────────────────
function onFiltersChange(f: GlobalFilters) {
  activePage.value.filters = f
  // Exclusions are global: hiding your own noise should apply on every page, not
  // just the one you set it on. Mirror the exclusion fields onto all pages.
  for (const p of config.pages) {
    p.filters.excludeSelfReferrals = f.excludeSelfReferrals
    p.filters.excludeOwnVisits = f.excludeOwnVisits
    p.filters.ownBrowser = f.ownBrowser
    p.filters.ownOS = f.ownOS
    // Sync-all-pages shares only the DATE WINDOW across every page. Site selection and
    // drill-downs stay per-page — they're what make a page distinct (the Best Sudoku launch
    // page IS its beacon-site filter), so syncing them would wipe that identity and can
    // leave a page filtered to sites it has no data for. Turn the toggle off for fully
    // independent per-page date ranges.
    if (config.syncRange) {
      p.filters.since = f.since
      p.filters.until = f.until
      p.filters.rangeRel = f.rangeRel
    }
  }
}

// Toggle sync-all-pages. Turning it on immediately pushes the current page's date range
// to every other page so they all match right away — site selection stays per-page.
function onToggleSync(on: boolean) {
  config.syncRange = on
  if (on) {
    const f = activePage.value.filters
    for (const p of config.pages) {
      p.filters.since = f.since
      p.filters.until = f.until
      p.filters.rangeRel = f.rangeRel
    }
  }
}

// ── Widget CRUD (operate on the active page) ──────────────────────────────────
function addChart() {
  const id = cryptoId()
  // On the Best Sudoku launch page, new charts default to the beacon dataset (its only
  // real data source) instead of Cloudflare RUM, so the whole page stays beacon-backed.
  // The pop-ups page similarly defaults to the pop-up dataset.
  const geo = isBestSudokuLaunchPage(activePage.value)
  const popups = isBestSudokuPopupsPage(activePage.value)
  editing.value = {
    isNew: true,
    widget: {
      id,
      i: id,
      title: 'New chart',
      type: 'bar',
      dataset: geo ? 'geo' : popups ? 'popup' : undefined,
      dimension: geo ? 'region' : popups ? 'kind' : 'requestHost',
      popup: popups ? 'signin-prompt' : undefined,
      metric: 'pageviews',
      limit: 10,
      x: 0,
      y: 9999,
      w: 6,
      h: 8,
    },
  }
}
function editChart(wgt: Widget) {
  editing.value = { isNew: false, widget: JSON.parse(JSON.stringify(wgt)) }
}
function onEditorSave(wgt: Widget) {
  const list = activePage.value.widgets
  const idx = list.findIndex((x) => x.id === wgt.id)
  if (idx >= 0) {
    // The editor works on a snapshot taken when it opened, and has no input for the grid box; the
    // live entry may have moved or refitted since (a fit card refits as data loads), so keep its.
    const live = list[idx]
    Object.assign(wgt, { x: live.x, y: live.y, w: live.w, h: live.h })
    list[idx] = wgt
  } else list.push(wgt)
  editing.value = null
}
function onEditorRemove() {
  if (editing.value) removeWidget(editing.value.widget.id)
  editing.value = null
}
function removeWidget(id: string) {
  const list = activePage.value.widgets
  const i = list.findIndex((x) => x.id === id)
  if (i >= 0) list.splice(i, 1)
  delete chartData[id]
}
// A duplicate must not share any array or object with the original (notes, hiddenCaveats, items,
// series, ...). A widget is plain JSON (it is what gets saved), so a JSON round trip is a deep copy
// that also copes with Vue reactive proxies, which structuredClone refuses.
function duplicateWidget(wgt: Widget) {
  const id = cryptoId()
  const copy: Widget = JSON.parse(JSON.stringify(wgt))
  activePage.value.widgets.push({ ...copy, id, i: id, x: 0, y: 9999, title: wgt.title + ' (copy)' })
}

// The latest response (or load error) each ChartCard reports, by widget id, so ChartEditor can show
// runtime caveats for the chart being edited without fetching again. Never saved; shallow so the
// responses are not made deeply reactive.
const chartData = shallowReactive<Record<string, { data: StatsResponse | null; error: string | null }>>({})
function onChartData(id: string, data: StatsResponse | null, error: string | null) {
  chartData[id] = { data, error }
}

// ── Drill-down: click a chart datapoint → open a new page filtered to that value ─
interface DrillPayload {
  widgetId: string // which chart's menu this is — scopes tooltip suppression to just that chart
  dimension: string
  dataset: 'geo' | 'rum'
  value: string
  label: string
  x: number
  y: number
}
const drillMenu = ref<DrillPayload | null>(null)

// Below this width the menu renders as a full-width bottom sheet instead (see template) —
// same breakpoint Dashboard.vue uses for its own mobile layout.
const isMobile = ref(false)
function checkMobile() {
  isMobile.value = window.innerWidth <= 700
}
onMounted(() => {
  checkMobile()
  window.addEventListener('resize', checkMobile)
})
onBeforeUnmount(() => window.removeEventListener('resize', checkMobile))

// Roughly the menu's own footprint (matches the CSS below) — used to keep it fully on-screen.
const DRILL_MENU_W = 260
const DRILL_MENU_H = 130

function onDrill(p: DrillPayload) {
  // On mobile the menu renders as a bottom sheet (see template/CSS) and ignores x/y entirely,
  // so it can never sit over the tapped point — skip the desktop positioning math.
  if (isMobile.value) {
    drillMenu.value = p
    return
  }
  // Desktop: offset AWAY from the tap point (never directly on it, where the tooltip/data
  // is), flip to the opposite side if the preferred side would run off the viewport, then
  // clamp fully on-screen. p.x/p.y are viewport coords (clientX/clientY); compute in that
  // space first, then convert to document coords so the menu scrolls with its chart instead
  // of staying pinned to the viewport (this part is unchanged from before).
  const margin = 14 // clear of the tapped point/its tooltip
  const pad = 8 // minimum gap from the viewport edge
  let vx = p.x + margin
  let vy = p.y + margin
  if (vx + DRILL_MENU_W > window.innerWidth - pad) vx = p.x - DRILL_MENU_W - margin // flip left
  if (vy + DRILL_MENU_H > window.innerHeight - pad) vy = p.y - DRILL_MENU_H - margin // flip up
  vx = Math.max(pad, Math.min(vx, window.innerWidth - DRILL_MENU_W - pad))
  vy = Math.max(pad, Math.min(vy, window.innerHeight - DRILL_MENU_H - pad))
  drillMenu.value = { ...p, x: vx + window.scrollX, y: vy + window.scrollY }
}
function closeDrill() {
  drillMenu.value = null
}
onMounted(() => document.addEventListener('click', closeDrill))
onBeforeUnmount(() => document.removeEventListener('click', closeDrill))

// Beacon tag → its full host (so a site drill from a geo chart filters both datasets).
function tagToHost(tag: string): string {
  for (const g of sitesTree.value) for (const s of g.subs) if (s.tag === tag) return s.host
  return tag
}
// A drill creates its page at once, nested under the page it was made from (a drill from a drill
// page nests under that drill page, up to MAX_DRILL_DEPTH levels — lib/nav.ts drillParentFor), in
// its group, with no icon of its own (it shows its top-level page's, with a drill mark —
// lib/icons.ts). Its name is just what it narrows its parent to (lib/nav.ts drillTrail): the tree
// and the breadcrumb show the rest of the path.
function openFilteredPage() {
  const p = drillMenu.value
  if (!p) return
  const parent = drillParentFor(activePage.value, config.pages)
  const root = rootOf(parent, config.pages)
  const clone = clonePage(activePage.value, 'Filtered')
  clone.parentId = parent.id
  clone.group = root.group
  delete clone.icon
  const dayRange = dayDrillRange(p.dimension, p.value)
  if (dayRange) {
    // A day isn't a filterable field (see geo.ts) — turn it into an absolute one-day RANGE
    // instead of a drill constraint. p.value is 'YYYY-MM-DD': a UTC day for 'date'
    // (date(ts/1000,'unixepoch')), an ET day (ET midnight to the next ET midnight) for 'dateEt'.
    const { since, until } = dayRange
    clone.filters.since = since
    clone.filters.until = until
    clone.filters.rangeRel = '' // absolute range — don't recompute a rolling window on load
    clone.name = drillTrail(clone.filters, parent.filters, tokenLabel, p.label)
  } else {
    if (isSiteDim(p.dimension)) {
      // site drill → the site multi-select (filters both datasets consistently)
      clone.filters.siteSel = [p.dataset === 'geo' ? tagToHost(p.value) : p.value]
    } else {
      const key = semanticKey(p.dimension, p.dataset)
      if (key) {
        const existing = (clone.filters.drill ?? []).filter((d) => d.key !== key)
        clone.filters.drill = [...existing, { key, value: p.value, label: p.label }]
      }
      // Drilling into an event-family pathFamily value (e.g. 'install') needs every widget on
      // the new page to include event beacons too — otherwise a widget with no per-chart
      // override applies the standing exclusion together with the new constraint, which can
      // never match a row, and renders silently empty instead of showing the drilled-into
      // data (see lib/drill.ts drillNeedsEventBeacons). A caption note explains why.
      if (drillNeedsEventBeacons(p.dimension, p.dataset, p.value)) {
        clone.filters.includeEventBeacons = true
        const noteWidgetId = cryptoId()
        clone.widgets = [
          {
            id: noteWidgetId,
            i: noteWidgetId,
            title: 'Includes event beacons',
            type: 'note',
            dimension: '',
            metric: 'pageviews',
            limit: 1,
            noteId: 'event-family-drill',
            x: 0,
            y: 0,
            w: 12,
            h: 3,
          },
          ...clone.widgets.map((w) => ({ ...w, y: w.y + 3 })), // make room above every existing widget
        ]
      }
    }
    clone.name = drillTrail(clone.filters, parent.filters, tokenLabel)
  }
  config.pages.push(clone)
  switchPage(clone.id)
  closeDrill()
}

// ── Main filter bar (owner request, 2026-09-26: put it back) ──────────────────────────────
// v0.6 (PR #9, commit 672aa24) hid this bar behind a small top-right toggle. The owner wants
// it back in normal flow, in EXACTLY its pre-v0.6 position/order/spacing/styling/wrapping —
// see commit 8692b0f's src/App.vue (the last commit before that merge): directly under the page
// navigation (the header since layout version 13), always visible, no overlay/collapse. It's
// restored in the template below as a plain
// in-flow section (`barSectionEl`), unconditionally rendered whenever `!isCampaignPage` (the
// campaign page still doesn't use it — unchanged from before).
//
// What's new here: since the page can be taller than the viewport, an IntersectionObserver on
// that in-flow section drives a small fixed top-right "Show filters" button that appears ONLY
// once the bar scrolls out of view (never while it's visible — no redundant control on screen).
// Clicking it pins a SECOND copy of the SAME FilterBar (same props/handlers, so it's always in
// sync with the in-flow one) as a fixed overlay at the top of the viewport. The pin clears
// itself the moment the in-flow bar scrolls back into view, or via the button again, Esc, or a
// click outside it. The in-flow bar is never removed from the DOM while pinned — it keeps its
// layout space, so nothing shifts when the pin appears (position: fixed is out of flow — see
// CSS `.fb-pinned`).
const barSectionEl = ref<HTMLElement | null>(null)
const barVisible = ref(true) // assume visible until the observer reports otherwise (keeps the button hidden at first paint)
const pinned = ref(false)
const fbToggleBtn = ref<HTMLButtonElement | null>(null)
const pinnedAnchor = ref<HTMLElement | null>(null)
const fbPanelId = 'fb-pinned-panel'
const touchCapable = isTouchDevice()
let barObserver: IntersectionObserver | undefined

function observeBarSection(el: HTMLElement | null) {
  barObserver?.disconnect()
  barObserver = undefined
  if (!el) {
    // No in-flow bar on this page (e.g. the campaign page never renders one) — nothing to
    // watch, and nothing to pin.
    barVisible.value = true
    pinned.value = false
    return
  }
  barObserver = new IntersectionObserver(
    ([entry]) => {
      barVisible.value = entry.isIntersecting
      if (entry.isIntersecting) pinned.value = false // back in view — the pin has done its job
    },
    { threshold: 0 },
  )
  barObserver.observe(el)
}
// `flush: 'post'` — the template ref is only set after Vue patches the DOM (e.g. switching to
// a page that hides/shows the in-flow bar via its own v-if).
watch(barSectionEl, (el) => observeBarSection(el), { flush: 'post' })
onMounted(() => observeBarSection(barSectionEl.value))
onBeforeUnmount(() => barObserver?.disconnect())

function togglePinned() {
  pinned.value = !pinned.value
}
// Reviewer fix (2026-09-27): the toggle stays in the tab order ALWAYS now (see the template —
// no more `tabindex="-1"` while the in-flow bar is visible), so a keyboard user can reach it
// even after tabbing past it earlier in the page. But there's nothing to pin while the in-flow
// bar is already on screen — activating it there instead jumps focus straight to the bar's
// first control, which is more useful than toggling a pin nobody can see the point of.
function activateToggle() {
  if (barVisible.value) {
    focusFirstBarControl()
    return
  }
  togglePinned()
}
function focusFirstBarControl() {
  const el = barSectionEl.value?.querySelector<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )
  el?.focus()
}
function closePinned() {
  pinned.value = false
}
// Returning focus to the toggle button on close (see closePinnedAndReturnFocus below) itself
// fires the button's own `focus` event — which, on non-touch input, is exactly what
// onToggleFocus below treats as "open the pin". Left unguarded, closing on Escape/outside-click
// would immediately reopen itself via that refocus. `suppressNextFocusOpen` marks a focus that
// WE caused (closing), synchronously, since `.focus()` dispatches its `focus` event before
// returning — set the flag right before calling it and clear it right after, so only that one
// synchronous focus is ignored and a genuine later Tab-focus still opens normally.
let suppressNextFocusOpen = false
// Escape / outside-click return focus to the toggle button — without this, focus is left on
// whatever was inside the now-hidden pinned bar (or lost entirely), stranding a keyboard user.
function closePinnedAndReturnFocus() {
  closePinned()
  suppressNextFocusOpen = true
  fbToggleBtn.value?.focus()
  suppressNextFocusOpen = false
}
// Reviewer-flagged lockout this reuses on purpose (originally fixed on the old always-hidden
// function-bar toggle — see App.test.ts): a real touch tap fires `focus` BEFORE `click`
// (touchstart -> touchend -> mouseover/mousemove/mousedown -> focus -> mouseup -> click). If
// focus opened the pin unconditionally, that SAME tap's trailing click would immediately toggle
// it back closed — a lockout, not a flicker. Gated to skip touch entirely, same as before: touch
// relies solely on the click handler's toggle below.
//
// Verified against a real click too (Playwright, Chromium): a plain MOUSE click on a <button>
// ALSO fires `focus` before `click` (mousedown -> focus -> mouseup -> click) — the original
// v0.6-0.8 toggle never hit this because its non-touch click handler just called an idempotent
// `openBar()`, never a toggle. This button's click handler DOES toggle (for every input type,
// per the "click it again to unpin" requirement), so gating on touch alone isn't enough here —
// a mouse click would open-then-immediately-close on that same click's focus+click pair. Added
// `:focus-visible` as the non-touch condition: true for real keyboard (Tab) navigation, false
// for a click-caused focus, so it only auto-opens on genuine keyboard nav and never fights a
// pointer click's own toggle.
function onToggleFocus(e: FocusEvent) {
  if (suppressNextFocusOpen) return
  if (touchCapable) return
  if (barVisible.value) return // nothing to pin — the in-flow bar is already on screen
  const el = e.target as HTMLElement
  if (el.matches(':focus-visible')) pinned.value = true
}
function onDocumentClickForPinned(e: MouseEvent) {
  if (!pinned.value) return
  const target = e.target as Node
  if (fbToggleBtn.value?.contains(target)) return // its own click handler already toggles this
  if (pinnedAnchor.value && !pinnedAnchor.value.contains(target)) closePinned()
}
function onGlobalKeyForPinned(e: KeyboardEvent) {
  if (e.key === 'Escape' && pinned.value) closePinnedAndReturnFocus()
}
// Close as soon as focus leaves the pinned panel entirely (e.g. Tabbing past its last control)
// — relatedTarget is the element gaining focus; null when focus leaves the document (e.g. to
// the browser chrome), also treated as "left".
function onPinnedFocusOut(e: FocusEvent) {
  const next = e.relatedTarget as Node | null
  if (next === fbToggleBtn.value) return // shift-tabbing back to the toggle isn't "leaving"
  if (!pinnedAnchor.value) return
  if (!next || !pinnedAnchor.value.contains(next)) closePinned()
}
onMounted(() => {
  document.addEventListener('click', onDocumentClickForPinned)
  document.addEventListener('keydown', onGlobalKeyForPinned)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClickForPinned)
  document.removeEventListener('keydown', onGlobalKeyForPinned)
})

// "Reveal all chart controls" — used to ride along with opening the old hidden function bar
// (see Dashboard.vue's `controlsVisible` prop). Reviewer call (2026-09-27): the header must
// match the pre-v0.6 layout EXACTLY, so there's no header control for this any more — ChartCard's
// own per-chart reveal icon + zoom (v0.8) is the supported way to reach a chart's controls,
// including on touch. Kept wired to Dashboard's `controls-visible` prop (stays false; cheap to
// leave in place rather than unwind the prop) in case a future non-header trigger needs it.
const revealAllControls = ref(false)

// ── Theme ─────────────────────────────────────────────────────────────────────
function applyDark() {
  document.documentElement.classList.toggle('dark', dark.value)
}
function toggleDark() {
  dark.value = !dark.value
  writeDarkPref(dark.value)
  applyDark()
}
</script>

<template>
  <div class="app">
    <div v-if="sessionExpired" class="reauth-banner">
      <span>Your sign-in session expired — the dashboard can't reach the data.</span>
      <button class="btn btn-primary" @click="reauth">Sign in again</button>
    </div>
    <!-- A failed layout load (signed-out has its own banner above): saving is off until it loads. -->
    <div v-else-if="loadFailed" class="reauth-banner load-failed-banner" role="alert">
      <span>Couldn't load your saved layout — showing the default one. Changes made now aren't saved, and are replaced when your layout loads.</span>
      <button class="btn btn-primary" :disabled="retryingLoad" @click="retryLoad">{{ retryingLoad ? 'Loading…' : 'Try again' }}</button>
    </div>
    <header class="topbar">
      <h1 class="visually-hidden">Stats</h1>
      <!-- ☰: the page drawer (components/nav/NavDrawer.vue), with the current group's badge. -->
      <button
        ref="drawerBtn"
        type="button"
        class="drawer-btn"
        :aria-label="`Open pages (${activeRoot.isDefault ? activeRoot.name : activeRoot.group})`"
        aria-haspopup="dialog"
        :aria-expanded="drawerOpen"
        aria-controls="nav-drawer"
        @click="drawerOpen = true"
      >
        <MenuIcon :size="17" aria-hidden="true" />
        <StarIcon v-if="activeRoot.isDefault" class="star" :size="16" aria-hidden="true" />
        <GroupBadge v-else :name="activeRoot.group" :meta="config.groupMeta?.[activeRoot.group]" />
      </button>
      <!-- Group / Page / Drill: each segment opens its siblings (components/nav/NavBreadcrumb.vue). -->
      <NavBreadcrumb
        class="topbar-crumbs"
        :pages="config.pages"
        :active="activePage"
        :group-meta="config.groupMeta"
        :group-order="config.groupOrder"
        :compact="isMobile"
        :renaming="renaming"
        @switch="switchPage"
        @switch-group="switchGroup"
        @new-page="addPage"
        @rename-start="startRename"
        @rename-page="renamePageTo"
        @rename-group="renameGroupTo"
        @rename-cancel="renaming = null"
      />
      <button
        ref="pageMenuBtn"
        type="button"
        class="page-menu-btn"
        :aria-label="`Page options: ${activePage.name}`"
        aria-haspopup="menu"
        :aria-expanded="pageMenu?.anchor === pageMenuBtn"
        @click="pageMenuBtn && openPageMenu(activePage.id, pageMenuBtn)"
      >
        <EllipsisIcon :size="17" aria-hidden="true" />
      </button>
      <span class="topbar-sp"></span>
      <button type="button" class="nav-search-btn" aria-label="Search pages" title="Search pages (/)" aria-keyshortcuts="/" @click="openSearch">
        <SearchIcon :size="15" aria-hidden="true" />
        <span class="nav-search-label">Search pages</span>
        <kbd>/</kbd>
      </button>
      <!-- save-state, theme, add-chart, AccountMenu — in that order. No "reveal chart controls"
           button here — per-chart reveal + zoom (ChartCard.vue, v0.8) is the way to show a chart's
           controls; `revealAllControls` below stays wired to Dashboard's `controls-visible` prop
           (cheap to keep) but has no header UI to set it. -->
      <div class="top-actions">
        <span v-if="saveLabel" class="save-state mono" :class="saveState">{{ saveLabel }}</span>
        <button class="btn" @click="toggleDark" :title="dark ? 'Light mode' : 'Dark mode'">
          {{ dark ? '☀' : '☾' }}
        </button>
        <button class="btn btn-primary" @click="addChart">＋ Add chart</button>
        <AccountMenu />
      </div>
    </header>

    <!-- Main filter bar — in normal flow, always visible, directly under the header (its
         breadcrumb is the everyday page switcher; the full page tree is in the ☰ drawer). Hidden
         only on the campaign page, whose widgets each cover their own fixed campaign window and
         aren't filter-driven. -->
    <div v-if="!isCampaignPage" ref="barSectionEl" class="filterbar-inflow">
      <FilterBar
        :filters="activePage.filters"
        :sync-range="config.syncRange"
        @change="onFiltersChange"
        @toggle-sync="onToggleSync"
      />
    </div>

    <!-- "Show filters" pin — visually hidden while the in-flow bar above is visible (see
         barVisible / the IntersectionObserver on barSectionEl), but ALWAYS in the tab order
         (reviewer fix, 2026-09-27: a keyboard user who tabbed past it earlier must still be able
         to reach it — no `tabindex="-1"`) and never `aria-hidden` (it's always focusable, so it's
         never truly hidden from assistive tech). Keyboard focus while merely visually hidden
         reveals it via `:focus-visible` in CSS. Once out of view, clicking/activating it pins
         the same FilterBar, fixed at the top of the viewport, until dismissed (this button
         again, Esc, or a click outside it) or until scrolling back to where the in-flow bar is
         visible again; while the in-flow bar IS visible, activating it just moves focus to the
         bar's first control instead (nothing to pin — see activateToggle). -->
    <div v-if="!isCampaignPage" class="fb-anchor">
      <button
        ref="fbToggleBtn"
        type="button"
        class="fb-toggle"
        :class="{ 'fb-toggle-hidden': barVisible }"
        :aria-expanded="pinned"
        :aria-controls="fbPanelId"
        aria-label="Show filters"
        @focus="onToggleFocus"
        @click="activateToggle"
        @keydown.escape="closePinnedAndReturnFocus"
      >
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
          <path d="M3 5h14M6 10h8M9 15h2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
        </svg>
      </button>
      <Transition name="fb-fade">
        <div v-if="pinned" :id="fbPanelId" ref="pinnedAnchor" class="fb-pinned" @focusout="onPinnedFocusOut">
          <div class="fb-pinned-inner">
            <FilterBar
              :filters="activePage.filters"
              :sync-range="config.syncRange"
              @change="onFiltersChange"
              @toggle-sync="onToggleSync"
            />
          </div>
        </div>
      </Transition>
    </div>

    <NoteBlock v-if="showPopupActivationNote" note-id="tracking-not-yet-active" class="activation-note" />
    <NoteBlock v-if="showPopupDeferredNote" note-id="popup-deferred-signin" class="activation-note" />
    <NoteBlock v-if="showSmallSampleNote" note-id="small-sample" class="activation-note small-sample-note" />

    <main class="grid-area">
      <Dashboard
        v-model:widgets="activePage.widgets"
        :filters="activePage.filters"
        :dark="dark"
        :drill-open-id="drillMenu?.widgetId ?? null"
        :controls-visible="revealAllControls"
        @edit="editChart"
        @remove="removeWidget"
        @duplicate="duplicateWidget"
        @change="scheduleSave"
        @drill="onDrill"
        @data="onChartData"
        @open-campaigns="switchPage('bsk-campaigns')"
      />
      <div v-if="loaded && activePage.widgets.length === 0" class="empty">
        <p>No charts on this page.</p>
        <button class="btn btn-primary" @click="addChart">＋ Add a chart</button>
      </div>
    </main>

    <!-- Keyed on the widget: editing a different widget while the editor is open remounts it,
         so no part of it (CardEditor reads its card once, at setup) shows the previous one. -->
    <ChartEditor
      v-if="editing"
      :key="editing.widget.id"
      :widget="editing.widget"
      :is-new="editing.isNew"
      :filters="activePage.filters"
      :data="chartData[editing.widget.id]?.data ?? null"
      :error="chartData[editing.widget.id]?.error ?? null"
      @save="onEditorSave"
      @cancel="editing = null"
      @remove="onEditorRemove"
    />

    <Teleport to="body">
      <div
        v-if="drillMenu"
        class="drill-menu"
        :class="{ sheet: isMobile }"
        :style="isMobile ? undefined : { top: drillMenu.y + 'px', left: drillMenu.x + 'px' }"
        @click.stop
      >
        <div class="drill-head">
          <span class="drill-dim">{{ drillMenu.dimension }}</span>
          <span class="drill-val">{{ drillMenu.label }}</span>
        </div>
        <button class="drill-act" @click="openFilteredPage">↳ Open as filtered page</button>
      </div>
    </Teleport>
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="drillMenu && isMobile" class="drill-backdrop" @click="closeDrill"></div>
      </Transition>
    </Teleport>

    <SearchPalette :open="searchOpen" :pages="config.pages" :group-meta="config.groupMeta" :group-order="config.groupOrder" @close="searchOpen = false" @pick="pickSearchResult" />
    <NavDrawer
      :open="drawerOpen"
      :pages="config.pages"
      :active="activePage"
      :group-meta="config.groupMeta"
      :group-order="config.groupOrder"
      :collapsed="collapsedGroups"
      :collapsed-pages="collapsedPages"
      :menu-for="pageMenu?.id ?? null"
      :renaming="renaming"
      :return-to="drawerBtn"
      :compact="isMobile"
      @close="drawerOpen = false"
      @switch="pickFromDrawer"
      @menu="openPageMenu"
      @delete="deletePage"
      @toggle-group="toggleGroup"
      @toggle-page="togglePageFold"
      @rename-start="startRename"
      @rename-page="renamePageTo"
      @rename-group="renameGroupTo"
      @rename-cancel="renaming = null"
      @delete-group="askDeleteGroup"
      @create-page="createPage"
      @create-group="createGroup"
    />
    <PageMenu
      :open="!!pageMenu"
      :anchor="pageMenu?.anchor ?? null"
      :page="pageMenuPage"
      :pages="config.pages"
      :group-meta="config.groupMeta"
      :group-order="config.groupOrder"
      :sheet="isMobile"
      @close="closePageMenu"
      @rename="renameFromMenu"
      @duplicate="duplicatePage"
      @change-icon="openIconPicker"
      @move="movePage"
      @restore="restoreDefaultCharts"
      @delete="deletePage"
    />
    <DeleteGroupDialog
      :group="groupToDelete?.name ?? null"
      :pages="config.pages"
      :group-order="config.groupOrder"
      :group-meta="config.groupMeta"
      :return-to="groupToDelete?.returnTo ?? null"
      @cancel="groupToDelete = null"
      @confirm="confirmDeleteGroup"
    />
    <IconPicker :open="!!iconFor" :page="iconPage" :pages="config.pages" :return-to="iconFor?.returnTo ?? null" @close="iconFor = null" @pick="pickIcon" />

    <footer class="foot overline">
      {{ activePage.name }} · humans only, bots excluded · {{ rangeText }}
    </footer>
  </div>
</template>

<style scoped>
/* Full width (layout version 13): no centred max-width column — the header, the filter bar and the
   chart grid span the window, with a 16px gutter, so wide screens fit more charts per row. */
.app {
  padding: 0 16px 60px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.drill-menu {
  position: absolute;
  /* Above ChartCard's zoom overlay (z-index 1000/1001) too — a drill can be triggered from a
     zoomed chart, and the menu must never end up hidden behind it. */
  z-index: 1100;
  min-width: 190px;
  max-width: 260px;
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line-2));
  border-radius: 10px;
  box-shadow: 0 12px 34px rgb(0 0 0 / 0.24);
  padding: 8px;
  /* top/left are pre-clamped + offset away from the tap point in App.onDrill (never placed
     directly on the tapped datapoint/its tooltip) — no CSS offset needed here. */
}
/* Mobile: a full-width bottom sheet instead of a point-anchored popup. It always shows the
   dimension + value itself, so it never needs to sit AT the tap point — pinning it to the
   bottom guarantees it can never cover the chart/data area at all, regardless of where on the
   card the user tapped. */
.drill-menu.sheet {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  top: auto;
  min-width: 0;
  max-width: none;
  width: 100%;
  border-radius: 16px 16px 0 0;
  border-width: 1px 0 0 0;
  padding: 10px 16px calc(10px + env(safe-area-inset-bottom));
  box-shadow: 0 -10px 30px rgb(0 0 0 / 0.22);
}
.drill-menu.sheet .drill-head {
  padding: 6px 4px 10px;
}
.drill-menu.sheet .drill-act {
  padding: 13px 10px; /* comfortable tap target at 375px wide */
  font-size: 14.5px;
}
.drill-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1099; /* just under the sheet, above everything else including the zoom overlay */
  background: rgb(0 0 0 / 0.4);
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.drill-head {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px 6px 8px;
  border-bottom: 1px solid rgb(var(--line));
  margin-bottom: 6px;
}
.drill-dim {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgb(var(--ink-3));
}
.drill-val {
  font-weight: 600;
  font-size: 14px;
  color: rgb(var(--ink));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.drill-act {
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  color: rgb(var(--ink));
  padding: 7px 8px;
  border-radius: 7px;
  font-size: 13px;
  cursor: pointer;
}
.drill-act:hover {
  background: rgb(var(--amber-tint));
  color: rgb(var(--amber-hover));
}
.reauth-banner {
  position: sticky;
  top: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 14px;
  padding: 10px 16px;
  border-radius: 10px;
  background: rgb(var(--amber));
  color: #fff;
  font-weight: 600;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
}
.reauth-banner .btn-primary {
  background: #fff;
  color: rgb(var(--amber));
  border: none;
}
.activation-note {
  padding: 9px 14px;
  border-radius: 10px;
  background: rgb(var(--sunken));
  border: 1px solid rgb(var(--line-2));
  color: rgb(var(--ink-2));
  font-size: 12.5px;
  text-align: center;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 10px 14px;
  flex-wrap: wrap;
  /* a full-bleed strip across the window, edge to edge past the .app gutter */
  margin: 0 -16px;
  padding: 10px 16px;
  background: rgb(var(--surface));
  border-bottom: 1px solid rgb(var(--line));
}
.topbar-crumbs {
  min-width: 0;
  flex: 0 1 auto;
}
.topbar-sp {
  flex: 1;
}
.nav-search-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 200px;
  padding: 5px 7px 5px 10px;
  border: 1px solid rgb(var(--line-2));
  border-radius: 9px;
  background: rgb(var(--canvas));
  color: rgb(var(--ink-3));
  font-size: 12.5px;
}
.nav-search-btn kbd {
  margin-left: auto;
}
.nav-search-btn:hover,
.nav-search-btn:focus-visible {
  border-color: rgb(var(--amber));
  color: rgb(var(--ink));
  outline: none;
}
.filterbar-inflow {
  /* A plain block wrapper for the IntersectionObserver ref. NOT `display: contents` — a
     `display: contents` element generates no box of its own, so `getBoundingClientRect()`
     (which IntersectionObserver relies on) reports it as empty/zero-sized regardless of its
     content, permanently misreporting it as out of view. A default block div has no
     margin/padding/border, so it still sits exactly where FilterBar would as a direct .app
     flex child (under the header, with .app's own `gap` between them) while giving the observer
     real geometry to measure. */
  min-width: 0;
}
.fb-anchor {
  position: fixed;
  top: 16px;
  right: 18px;
  /* Above EVERYTHING else that can overlay the page, including a zoomed ChartCard
     (z-index 1000/1001 — see ChartCard.vue) and the drill-down menu (1100 below) — the
     toggle must stay reachable no matter what's on screen (MEDIUM review fix, carried over). */
  z-index: 1200;
  /* The anchor box itself sits over the header's top-right corner (the account menu, the page ⋯
     button at phone width): it must not swallow their clicks while the toggle is hidden. Only
     its children (the toggle when shown, the pinned bar) take pointer events. */
  pointer-events: none;
}
.fb-anchor > * {
  pointer-events: auto;
}
.fb-toggle {
  /* Positioned and stacked above .fb-pinned (1150): both live inside .fb-anchor's own stacking
     context, where a positioned panel paints over a non-positioned sibling whatever the anchor's
     z-index — without this the open pin covered the very button meant to close it. */
  position: relative;
  z-index: 1160;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgb(var(--line-2));
  border-radius: 10px;
  background: rgb(var(--surface));
  color: rgb(var(--ink-2));
  box-shadow: 0 2px 10px rgb(0 0 0 / 0.12);
  cursor: pointer;
  opacity: 1;
  transition: opacity 0.15s ease;
}
.fb-toggle:hover,
.fb-toggle:focus-visible {
  color: rgb(var(--ink));
  border-color: rgb(var(--amber));
}
/* Visually hidden while the in-flow bar is visible (req #3) — kept in the DOM (not v-if'd away)
   so it never causes a layout shift when it appears. It STAYS in the tab order even while
   hidden this way (reviewer fix, 2026-09-27 — see the template, no `tabindex="-1"`), so a
   keyboard user tabbing through the page still reaches it; the override below reveals it the
   moment it gets real keyboard focus, even though the bar is on screen. */
.fb-toggle-hidden {
  opacity: 0;
  pointer-events: none;
}
.fb-toggle-hidden:focus-visible {
  opacity: 1;
  pointer-events: auto;
}
.fb-pinned {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  /* Above the drill-down menu (1100) and a zoomed ChartCard (1000/1001), below the toggle
     button itself (.fb-toggle, 1160 in the same .fb-anchor stacking context) so it always stays
     clickable to unpin. */
  z-index: 1150;
  background: rgb(var(--surface));
  border-bottom: 1px solid rgb(var(--line-2));
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.2);
}
.fb-pinned-inner {
  /* full width, like the in-flow bar it copies */
  padding: 12px 16px;
}
.fb-fade-enter-active,
.fb-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.fb-fade-enter-from,
.fb-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
@media (prefers-reduced-motion: reduce) {
  .fb-toggle {
    transition: none;
  }
  .fb-fade-enter-active,
  .fb-fade-leave-active {
    transition: none;
  }
}
@media (max-width: 700px) {
  .fb-anchor {
    top: 10px;
    right: 12px;
  }
  .fb-pinned-inner {
    padding: 10px 12px;
  }
}
.drawer-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 4px 6px 4px 7px;
  border: 1px solid rgb(var(--line-2));
  border-radius: 9px;
  background: rgb(var(--surface));
  color: rgb(var(--ink));
}
.page-menu-btn {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 30px;
  height: 30px;
  margin-left: -8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: rgb(var(--ink-3));
}
.drawer-btn:hover,
.page-menu-btn:hover,
.page-menu-btn[aria-expanded='true'] {
  border-color: rgb(var(--amber));
  background: rgb(var(--sunken));
  color: rgb(var(--ink));
}
.drawer-btn:focus-visible,
.page-menu-btn:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: 1px;
}
.top-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.save-state {
  font-size: 11px;
  color: rgb(var(--ink-3));
  margin-right: 4px;
}
.save-state.saved {
  color: #6a994e;
}
.save-state.error,
.save-state.blocked {
  color: #bc4749;
}
.grid-area {
  position: relative;
  min-height: 200px;
}
.empty {
  text-align: center;
  padding: 60px 0;
  color: rgb(var(--ink-3));
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
.foot {
  text-align: center;
  margin-top: 8px;
}

/* Compact bar (lib/responsive.ts TOPBAR_COMPACT_MAX_WIDTH): the bar would wrap up to here, so the search
   box collapses to its icon (the button still opens the palette, "/" still works). One rule for the
   phone layout (700px and below) and the band above it, so there's no seam between them. */
@media (max-width: 1000px) {
  .nav-search-btn {
    min-width: 0;
    padding: 7px;
  }
  .nav-search-label,
  .nav-search-btn kbd {
    display: none;
  }
}

@media (max-width: 700px) {
  .app {
    padding: 0 12px 48px;
    gap: 12px;
  }
  .topbar {
    margin: 0 -12px;
    padding: 9px 12px;
    gap: 8px;
  }
  /* Phone: ☰, the (shortened) breadcrumb, ⋯ and search on the first row; the other actions below. */
  .topbar-crumbs {
    flex: 1 1 0;
  }
  .topbar-sp {
    display: none;
  }
  .page-menu-btn {
    margin-left: -6px;
  }
  .top-actions {
    order: 1;
    flex-basis: 100%;
  }
  .top-actions {
    flex-wrap: wrap;
  }
}
</style>
