<script setup lang="ts">
import { reactive, ref, watch, onMounted, onBeforeUnmount, nextTick, computed } from 'vue'
import type { DashboardConfig, DashboardPage, Widget, GlobalFilters } from './types'
import { defaultConfig, normalizeConfig, defaultWidgetsForPage, clonePage, cryptoId, isBestSudokuLaunchPage, isBestSudokuPopupsPage, isCampaignComparePage, BEST_SUDOKU_SITES, beaconizeWidget } from './lib/defaults'
import { rangeLabel, ymdRangeToISO } from './lib/range'
import { loadConfig, saveConfig } from './api'
import { loadSites, sitesTree, tokenLabel } from './sitesStore'
import { isSiteDim, semanticKey, drillNeedsEventBeacons } from './lib/drill'
import { sessionExpired, reauth } from './session'
import { readViewerPrefs, writeViewerPrefs, initialPageId } from './lib/viewerPrefs'
import { rootOf, drillTrail, groupLandingPage } from './lib/nav'
import { SearchIcon } from './lib/icons'
import NavBreadcrumb from './components/nav/NavBreadcrumb.vue'
import SearchPalette from './components/nav/SearchPalette.vue'
import { isTouchDevice } from './lib/responsive'
import { TRACKING_ACTIVATION_DATE_ET } from './lib/popupEvents'
import NoteBlock from './components/NoteBlock.vue'
import PageBar from './components/PageBar.vue'
import FilterBar from './components/FilterBar.vue'
import Dashboard from './components/Dashboard.vue'
import ChartEditor from './components/ChartEditor.vue'
import AccountMenu from './components/AccountMenu.vue'

const config = reactive<DashboardConfig>(defaultConfig())
const loaded = ref(false)
const editing = ref<{ widget: Widget; isNew: boolean } | null>(null)
const dark = ref(false)
const saveState = ref<'idle' | 'saving' | 'saved' | 'error' | 'stale'>('idle')

// The page currently being viewed/edited — per VIEWER (layout version 12): remembered in this
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
  dark.value = localStorage.getItem('gss-stats-dark') === '1'
  applyDark()

  // Load the durable config and the auto-built site tree in parallel; the tree must
  // be ready before charts fetch so the real-host allow-list applies from the start.
  const [stored] = await Promise.all([loadConfig(), loadSites()])
  const norm = normalizeConfig(stored ?? config)
  config.version = norm.version
  config.activePageId = norm.activePageId
  config.pages = norm.pages
  config.syncRange = norm.syncRange
  config.groupMeta = norm.groupMeta
  activePageId.value = initialPageId(norm.pages, readViewerPrefs(), norm.activePageId)

  await nextTick()
  // What the store holds as far as this tab knows: a save only goes out when the config differs.
  lastSavedJson = configJson(config)
  loaded.value = true
  rememberActivePage()
})

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
  if (loaded.value) rememberActivePage()
})

// ── Persistence (debounced) ───────────────────────────────────────────────────
let saveTimer: number | undefined
// The config as last loaded or saved. A change that leaves the config the same (e.g. the grid
// re-reporting an unchanged layout when you switch pages) never goes out as a save.
let lastSavedJson = ''
// The config as saved. grid-layout-plus writes its own bookkeeping (`moved`) onto every widget it
// lays out — the first time each page is shown, so on every page switch — which is not part of the
// layout (normWidget drops it on load): it never counts as a change and is never saved.
function configJson(c: DashboardConfig): string {
  return JSON.stringify(c, function (this: unknown, key: string, value: unknown) {
    return key === 'moved' && this && typeof this === 'object' && 'i' in this && 'x' in this ? undefined : value
  })
}
function scheduleSave() {
  // Never save while signed out: a config that fell back to defaults because the load
  // was refused must not overwrite the stored one.
  if (!loaded.value || sessionExpired.value) return
  if (configJson(config) === lastSavedJson) return
  saveState.value = 'saving'
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(async () => {
    const body = configJson(config)
    if (body === lastSavedJson) {
      saveState.value = 'saved'
      return
    }
    const ok = await saveConfig(JSON.parse(body) as DashboardConfig)
    if (ok === true) lastSavedJson = body
    saveState.value = ok === 'stale' ? 'stale' : ok ? 'saved' : 'error'
  }, 700)
}
watch(config, scheduleSave, { deep: true })

const saveLabel = computed(
  () => ({ idle: '', saving: 'Saving…', saved: 'Saved', error: 'Save failed', stale: 'This tab is out of date, reload' })[saveState.value],
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

// ── / search ──────────────────────────────────────────────────────────────────────
const searchOpen = ref(false)
function openSearch() {
  searchOpen.value = true
}
function pickSearchResult(id: string) {
  searchOpen.value = false
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
  e.preventDefault()
  openSearch()
}
onMounted(() => document.addEventListener('keydown', onSlashKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onSlashKey))
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
function renamePage(id: string, name: string) {
  const p = config.pages.find((x) => x.id === id)
  if (p) p.name = name
}
function deletePage(id: string) {
  const p = config.pages.find((x) => x.id === id)
  if (!p || p.isDefault || config.pages.length <= 1) return
  if (!confirm(`Delete page "${p.name}"? This can't be undone.`)) return
  const idx = config.pages.findIndex((x) => x.id === id)
  const parentId = p.parentId
  config.pages.splice(idx, 1)
  const fallback = config.pages.find((x) => x.isDefault) ?? config.pages[0]
  if (config.activePageId === id) config.activePageId = fallback.id
  if (activePageId.value === id) switchPage(parentId && config.pages.some((x) => x.id === parentId) ? parentId : fallback.id)
}
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
  if (idx >= 0) list[idx] = wgt
  else list.push(wgt)
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
}
function duplicateWidget(wgt: Widget) {
  const id = cryptoId()
  activePage.value.widgets.push({ ...wgt, id, i: id, x: 0, y: 9999, title: wgt.title + ' (copy)' })
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
// A drill creates its page at once, nested under the ROOT page it came from (a drill from a drill
// page nests under the same root), in that page's group, with no icon of its own (it shows its
// root's, with a drill mark — lib/icons.ts). Its name is the trail of what it narrows the root
// page to, joined with " › " (lib/nav.ts drillTrail).
function openFilteredPage() {
  const p = drillMenu.value
  if (!p) return
  const root = rootOf(activePage.value, config.pages)
  const clone = clonePage(activePage.value, 'Filtered')
  clone.parentId = root.id
  clone.group = root.group
  delete clone.icon
  if (p.dimension === 'date') {
    // A day isn't a filterable field (see geo.ts) — turn it into an absolute one-day RANGE
    // instead of a drill constraint. p.value is 'YYYY-MM-DD' (from date(ts/1000,'unixepoch')).
    const { since, until } = ymdRangeToISO(p.value, p.value)
    clone.filters.since = since
    clone.filters.until = until
    clone.filters.rangeRel = '' // absolute range — don't recompute a rolling window on load
    clone.name = drillTrail(clone.filters, root.filters, tokenLabel, p.label)
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
    clone.name = drillTrail(clone.filters, root.filters, tokenLabel)
  }
  config.pages.push(clone)
  switchPage(clone.id)
  closeDrill()
}

// ── Main filter bar (owner request, 2026-09-26: put it back) ──────────────────────────────
// v0.6 (PR #9, commit 672aa24) hid this bar behind a small top-right toggle. The owner wants
// it back in normal flow, in EXACTLY its pre-v0.6 position/order/spacing/styling/wrapping —
// see commit 8692b0f's src/App.vue (the last commit before that merge): directly under
// PageBar, always visible, no overlay/collapse. It's restored in the template below as a plain
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
  localStorage.setItem('gss-stats-dark', dark.value ? '1' : '0')
  applyDark()
}
</script>

<template>
  <div class="app">
    <div v-if="sessionExpired" class="reauth-banner">
      <span>Your sign-in session expired — the dashboard can't reach the data.</span>
      <button class="btn btn-primary" @click="reauth">Sign in again</button>
    </div>
    <header class="topbar">
      <div class="brand">
        <span class="logo">S</span>
        <div>
          <h1>Stats</h1>
          <span class="overline">Good Stuff Software · bot-free RUM</span>
        </div>
      </div>
      <!-- Group / Page / Drill: each segment opens its siblings (components/nav/NavBreadcrumb.vue). -->
      <NavBreadcrumb
        class="topbar-crumbs"
        :pages="config.pages"
        :active="activePage"
        :group-meta="config.groupMeta"
        :compact="isMobile"
        @switch="switchPage"
        @switch-group="switchGroup"
        @new-page="addPage"
      />
      <span class="topbar-sp"></span>
      <button type="button" class="nav-search-btn" aria-label="Search pages" aria-keyshortcuts="/" @click="openSearch">
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

    <!-- Page tabs — ALWAYS visible (owner clarification, 2026-09-26): unlike the rest of the
         page chrome, navigating between pages is core wayfinding, not "modification" chrome,
         so it never hides. -->
    <PageBar
      :pages="config.pages"
      :active-page-id="activePage.id"
      @switch="switchPage"
      @add="addPage"
      @rename="renamePage"
      @duplicate="duplicatePage"
      @delete="deletePage"
      @restore="restoreDefaultCharts"
    />

    <!-- Main filter bar — restored to normal flow (pre-v0.6 layout, commit 8692b0f): always
         visible, directly under PageBar. Hidden only on the campaign page, whose widgets each
         cover their own fixed campaign window and aren't filter-driven. -->
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
        @open-campaigns="switchPage('bsk-campaigns')"
      />
      <div v-if="loaded && activePage.widgets.length === 0" class="empty">
        <p>No charts on this page.</p>
        <button class="btn btn-primary" @click="addChart">＋ Add a chart</button>
      </div>
    </main>

    <ChartEditor
      v-if="editing"
      :widget="editing.widget"
      :is-new="editing.isNew"
      :filters="activePage.filters"
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

    <SearchPalette :open="searchOpen" :pages="config.pages" :group-meta="config.groupMeta" @close="searchOpen = false" @pick="pickSearchResult" />

    <footer class="foot overline">
      {{ activePage.name }} · humans only, bots excluded · {{ rangeText }}
    </footer>
  </div>
</template>

<style scoped>
.app {
  max-width: 1480px;
  margin: 0 auto;
  padding: 22px 22px 60px;
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
     flex child (pre-v0.6 layout, commit 8692b0f: PageBar, then this, with .app's own
     `gap: 14px` between them) while giving the observer real geometry to measure. */
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
}
.fb-toggle {
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
     itself (1200) so the toggle button always stays clickable to unpin. */
  z-index: 1150;
  background: rgb(var(--surface));
  border-bottom: 1px solid rgb(var(--line-2));
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.2);
}
.fb-pinned-inner {
  max-width: 1480px;
  margin: 0 auto;
  padding: 14px 22px;
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
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.logo {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: rgb(var(--amber));
  color: #fff;
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700;
  font-size: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.brand h1 {
  font-size: 22px;
  line-height: 1.1;
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
.save-state.error {
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

@media (max-width: 700px) {
  .app {
    padding: 14px 12px 48px;
    gap: 12px;
  }
  .brand h1 {
    font-size: 19px;
  }
  .logo {
    width: 34px;
    height: 34px;
    font-size: 18px;
  }
  .top-actions {
    flex-wrap: wrap;
  }
  .nav-search-btn {
    min-width: 0;
    padding: 7px;
  }
  .nav-search-label,
  .nav-search-btn kbd {
    display: none;
  }
}
</style>
