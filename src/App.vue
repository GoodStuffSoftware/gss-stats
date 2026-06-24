<script setup lang="ts">
import { reactive, ref, watch, onMounted, nextTick, computed } from 'vue'
import type { DashboardConfig, Widget, GlobalFilters } from './types'
import { defaultConfig, normalizeConfig, cryptoId } from './lib/defaults'
import { loadConfig, saveConfig } from './api'
import FilterBar from './components/FilterBar.vue'
import Dashboard from './components/Dashboard.vue'
import ChartEditor from './components/ChartEditor.vue'

const config = reactive<DashboardConfig>(defaultConfig())
const loaded = ref(false)
const editing = ref<{ widget: Widget; isNew: boolean } | null>(null)
const dark = ref(false)
const saveState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')

onMounted(async () => {
  dark.value = localStorage.getItem('gss-stats-dark') === '1'
  applyDark()

  const stored = await loadConfig()
  const norm = normalizeConfig(stored ?? config)
  config.version = norm.version
  config.filters = norm.filters
  config.widgets = norm.widgets

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

// ── Filters ───────────────────────────────────────────────────────────────────
function onFiltersChange(f: GlobalFilters) {
  config.filters = f
}

// ── Widget CRUD ───────────────────────────────────────────────────────────────
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
function editChart(w: Widget) {
  editing.value = { isNew: false, widget: JSON.parse(JSON.stringify(w)) }
}
function onEditorSave(w: Widget) {
  const idx = config.widgets.findIndex((x) => x.id === w.id)
  if (idx >= 0) config.widgets[idx] = w
  else config.widgets.push(w)
  editing.value = null
}
function onEditorRemove() {
  if (editing.value) removeWidget(editing.value.widget.id)
  editing.value = null
}
function removeWidget(id: string) {
  const i = config.widgets.findIndex((x) => x.id === id)
  if (i >= 0) config.widgets.splice(i, 1)
}
function duplicateWidget(w: Widget) {
  const id = cryptoId()
  config.widgets.push({ ...w, id, i: id, x: 0, y: 9999, title: w.title + ' (copy)' })
}

function resetDashboard() {
  if (!confirm('Reset the dashboard to the default charts? Your custom layout will be lost.')) return
  const d = defaultConfig()
  d.filters = config.filters // keep current filters
  config.version = d.version
  config.widgets = d.widgets
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
        <button class="btn" @click="resetDashboard" title="Reset to default charts">Reset</button>
        <button class="btn" @click="toggleDark" :title="dark ? 'Light mode' : 'Dark mode'">
          {{ dark ? '☀' : '☾' }}
        </button>
        <button class="btn btn-primary" @click="addChart">＋ Add chart</button>
      </div>
    </header>

    <FilterBar :filters="config.filters" @change="onFiltersChange" />

    <main class="grid-area">
      <Dashboard
        v-model:widgets="config.widgets"
        :filters="config.filters"
        :dark="dark"
        @edit="editChart"
        @remove="removeWidget"
        @duplicate="duplicateWidget"
        @change="scheduleSave"
      />
      <div v-if="loaded && config.widgets.length === 0" class="empty">
        <p>No charts yet.</p>
        <button class="btn btn-primary" @click="addChart">＋ Add your first chart</button>
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
      Data: Cloudflare Web Analytics (RUM) · humans only, bots excluded · {{ config.filters.since }} →
      {{ config.filters.until }}
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
  gap: 16px;
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
</style>
