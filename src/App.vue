<script setup lang="ts">
import { reactive, ref, watch, onMounted, nextTick, computed } from 'vue'
import type { DashboardConfig, DashboardPage, Widget, GlobalFilters } from './types'
import { defaultConfig, normalizeConfig, defaultWidgets, clonePage, cryptoId } from './lib/defaults'
import { rangeLabel } from './lib/range'
import { loadConfig, saveConfig } from './api'
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

  const stored = await loadConfig()
  const norm = normalizeConfig(stored ?? config)
  config.version = norm.version
  config.activePageId = norm.activePageId
  config.pages = norm.pages

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
  if (!confirm(`Restore "${p.name}" to the default charts? Custom charts on this page will be replaced.`)) return
  p.widgets = defaultWidgets()
}

// ── Filters ───────────────────────────────────────────────────────────────────
function onFiltersChange(f: GlobalFilters) {
  activePage.value.filters = f
}

// ── Widget CRUD (operate on the active page) ──────────────────────────────────
function addChart() {
  const id = cryptoId()
  editing.value = {
    isNew: true,
    widget: {
      id,
      i: id,
      title: 'New chart',
      type: 'bar',
      dimension: 'requestHost',
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

    <FilterBar :filters="activePage.filters" @change="onFiltersChange" />

    <main class="grid-area">
      <Dashboard
        v-model:widgets="activePage.widgets"
        :filters="activePage.filters"
        :dark="dark"
        @edit="editChart"
        @remove="removeWidget"
        @duplicate="duplicateWidget"
        @change="scheduleSave"
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
