<script setup lang="ts">
import { reactive, ref, watch, onMounted, onBeforeUnmount, nextTick, computed } from 'vue'
import type { DashboardConfig, DashboardPage, Widget, GlobalFilters } from './types'
import { defaultConfig, normalizeConfig, defaultWidgetsForPage, clonePage, cryptoId, isBestSudokuLaunchPage, BEST_SUDOKU_SITES, beaconizeWidget } from './lib/defaults'
import { rangeLabel, ymdRangeToISO } from './lib/range'
import { loadConfig, saveConfig } from './api'
import { loadSites, sitesTree, tokenLabel } from './sitesStore'
import { isSiteDim, semanticKey } from './lib/drill'
import { sessionExpired, reauth } from './session'
import PageBar from './components/PageBar.vue'
import FilterBar from './components/FilterBar.vue'
import Dashboard from './components/Dashboard.vue'
import ChartEditor from './components/ChartEditor.vue'

const config = reactive<DashboardConfig>(defaultConfig())
const loaded = ref(false)
const editing = ref<{ widget: Widget; isNew: boolean } | null>(null)
const dark = ref(false)
const saveState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')

// The page currently being viewed/edited.
const activePage = computed<DashboardPage>(() => config.pages.find((p) => p.id === config.activePageId) ?? config.pages[0])
const rangeText = computed(() => rangeLabel(activePage.value.filters.since, activePage.value.filters.until))

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

  await nextTick()
  loaded.value = true
})

// ── Persistence (debounced) ───────────────────────────────────────────────────
let saveTimer: number | undefined
function scheduleSave() {
  if (!loaded.value) return
  saveState.value = 'saving'
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(async () => {
    const ok = await saveConfig(JSON.parse(JSON.stringify(config)) as DashboardConfig)
    saveState.value = ok ? 'saved' : 'error'
  }, 700)
}
watch(config, scheduleSave, { deep: true })

const saveLabel = computed(
  () => ({ idle: '', saving: 'Saving…', saved: 'Saved', error: 'Save failed' })[saveState.value],
)

// ── Page operations ───────────────────────────────────────────────────────────
function switchPage(id: string) {
  config.activePageId = id
}
function addPage() {
  const clone = clonePage(activePage.value, 'Copy of ' + activePage.value.name)
  config.pages.push(clone)
  config.activePageId = clone.id
}
function duplicatePage(id: string) {
  const src = config.pages.find((p) => p.id === id) ?? activePage.value
  const clone = clonePage(src, 'Copy of ' + src.name)
  config.pages.push(clone)
  config.activePageId = clone.id
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
  config.pages.splice(idx, 1)
  if (config.activePageId === id) config.activePageId = config.pages[0].id
}
function restoreDefaultCharts(id: string) {
  const p = config.pages.find((x) => x.id === id) ?? activePage.value
  const launch = isBestSudokuLaunchPage(p)
  // If the user has pinned any charts as defaults, restoring keeps exactly those and drops
  // the rest. Otherwise fall back to the factory set for this page. The Best Sudoku launch
  // page additionally re-points its charts at the beacon and resets the site buckets.
  const marked = p.widgets.filter((w) => w.isDefault)
  const msg = marked.length
    ? `Restore "${p.name}" to your default charts? Charts not set as default will be removed.`
    : launch
      ? `Reset "${p.name}"? Every chart switches to the beacon data source (your layout is kept).`
      : `Restore "${p.name}" to the default charts? Custom charts on this page will be replaced.`
  if (!confirm(msg)) return

  let next = marked.length ? marked : launch ? p.widgets : defaultWidgetsForPage(p)
  if (launch) {
    next = next.map(beaconizeWidget)
    p.filters.siteSel = [...BEST_SUDOKU_SITES]
  }
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
  const geo = isBestSudokuLaunchPage(activePage.value)
  editing.value = {
    isNew: true,
    widget: {
      id,
      i: id,
      title: 'New chart',
      type: 'bar',
      dataset: geo ? 'geo' : undefined,
      dimension: geo ? 'region' : 'requestHost',
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
function drillTitle(f: GlobalFilters): string {
  const parts: string[] = []
  const sel = f.siteSel ?? []
  if (sel.length === 1) parts.push(tokenLabel(sel[0]))
  else if (sel.length > 1) parts.push(`${sel.length} sites`)
  for (const d of f.drill ?? []) parts.push(d.label)
  return parts.join(' · ') || 'Filtered'
}
function openFilteredPage() {
  const p = drillMenu.value
  if (!p) return
  const clone = clonePage(activePage.value, 'Filtered')
  if (p.dimension === 'date') {
    // A day isn't a filterable field (see geo.ts) — turn it into an absolute one-day RANGE
    // instead of a drill constraint. p.value is 'YYYY-MM-DD' (from date(ts/1000,'unixepoch')).
    const { since, until } = ymdRangeToISO(p.value, p.value)
    clone.filters.since = since
    clone.filters.until = until
    clone.filters.rangeRel = '' // absolute range — don't recompute a rolling window on load
    clone.name = p.label
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
    }
    clone.name = drillTitle(clone.filters)
  }
  config.pages.push(clone)
  config.activePageId = clone.id
  closeDrill()
}

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
      <div class="top-actions">
        <span v-if="saveLabel" class="save-state mono" :class="saveState">{{ saveLabel }}</span>
        <button class="btn" @click="toggleDark" :title="dark ? 'Light mode' : 'Dark mode'">
          {{ dark ? '☀' : '☾' }}
        </button>
        <button class="btn btn-primary" @click="addChart">＋ Add chart</button>
      </div>
    </header>

    <PageBar
      :pages="config.pages"
      :active-page-id="config.activePageId"
      @switch="switchPage"
      @add="addPage"
      @rename="renamePage"
      @duplicate="duplicatePage"
      @delete="deletePage"
      @restore="restoreDefaultCharts"
    />

    <FilterBar
      :filters="activePage.filters"
      :sync-range="config.syncRange"
      @change="onFiltersChange"
      @toggle-sync="onToggleSync"
    />

    <main class="grid-area">
      <Dashboard
        v-model:widgets="activePage.widgets"
        :filters="activePage.filters"
        :dark="dark"
        :drill-open-id="drillMenu?.widgetId ?? null"
        @edit="editChart"
        @remove="removeWidget"
        @duplicate="duplicateWidget"
        @change="scheduleSave"
        @drill="onDrill"
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
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
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
}
</style>
