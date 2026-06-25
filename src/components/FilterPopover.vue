<script setup lang="ts">
import { reactive, computed, watch } from 'vue'
import type { GlobalFilters } from '../types'
import { SITE_OPTIONS, SITES } from '../lib/catalog'

const props = defineProps<{ start: GlobalFilters; active: boolean }>()
const emit = defineEmits<{ apply: [GlobalFilters]; useGlobal: []; close: [] }>()

const local = reactive<GlobalFilters>({ ...props.start })
watch(
  () => props.start,
  (s) => Object.assign(local, s),
  { deep: true },
)

// Any edit creates / updates the override (live).
function commit() {
  emit('apply', { ...local })
}

const hostOptions = computed(() => SITES.find((x) => x.key === local.site)?.hosts ?? [])
function onSiteChange() {
  local.host = ''
  commit()
}
function preset(days: number) {
  const until = new Date()
  const since = new Date()
  since.setUTCDate(since.getUTCDate() - (days - 1))
  local.since = since.toISOString().slice(0, 10)
  local.until = until.toISOString().slice(0, 10)
  commit()
}
const activePreset = computed(() => {
  const days = Math.round((Date.parse(local.until) - Date.parse(local.since)) / 86400000) + 1
  const today = new Date().toISOString().slice(0, 10)
  return local.until === today ? days : -1
})
</script>

<template>
  <div class="fp">
    <header class="fp-head">
      <span class="fp-title">Chart filter</span>
      <button class="x" title="Done" @click="emit('close')">✕</button>
    </header>

    <div class="fp-field">
      <label>Site</label>
      <select v-model="local.site" @change="onSiteChange">
        <option v-for="o in SITE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>

    <div v-if="hostOptions.length" class="fp-field">
      <label>Subdomain</label>
      <select v-model="local.host" @change="commit">
        <option value="">All</option>
        <option v-for="h in hostOptions" :key="h" :value="h">{{ h.replace('.goodstuff.software', '') }}</option>
      </select>
    </div>

    <div class="fp-field">
      <label>Range</label>
      <div class="presets">
        <button :class="['chip', { on: activePreset === 7 }]" @click="preset(7)">7d</button>
        <button :class="['chip', { on: activePreset === 30 }]" @click="preset(30)">30d</button>
        <button :class="['chip', { on: activePreset === 90 }]" @click="preset(90)">90d</button>
      </div>
    </div>

    <div class="fp-row">
      <div class="fp-field">
        <label>From</label>
        <input type="date" v-model="local.since" @change="commit" />
      </div>
      <div class="fp-field">
        <label>To</label>
        <input type="date" v-model="local.until" @change="commit" />
      </div>
    </div>

    <label class="fp-check">
      <input type="checkbox" v-model="local.excludeSelfReferrals" @change="commit" />
      Hide self-referrals
    </label>
    <label class="fp-check">
      <input type="checkbox" v-model="local.excludeOwnVisits" @change="commit" />
      Hide my visits
    </label>
    <div v-if="local.excludeOwnVisits" class="ua">
      <input type="text" v-model="local.ownBrowser" @change="commit" placeholder="Opera" />
      <input type="text" v-model="local.ownOS" @change="commit" placeholder="Windows" />
    </div>

    <footer class="fp-foot">
      <button v-if="active" class="btn-link" @click="emit('useGlobal')">↺ Use global filter</button>
      <span v-else class="hint">Editing creates an override</span>
      <button class="btn-done" @click="emit('close')">Done</button>
    </footer>
  </div>
</template>

<style scoped>
.fp {
  width: 270px;
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line-2));
  border-radius: 12px;
  box-shadow: 0 16px 44px rgb(0 0 0 / 0.22);
  padding: 12px 13px 11px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.fp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.fp-title {
  font-family: 'Space Grotesk', sans-serif;
  font-weight: 600;
  font-size: 13px;
}
.x {
  border: none;
  background: transparent;
  color: rgb(var(--ink-3));
  font-size: 13px;
  padding: 2px 5px;
  border-radius: 6px;
}
.x:hover {
  background: rgb(var(--sunken));
}
.fp-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}
.fp-field select,
.fp-field input {
  width: 100%;
}
.fp-row {
  display: flex;
  gap: 8px;
}
.presets {
  display: flex;
  gap: 4px;
}
.chip {
  border: 1px solid rgb(var(--line-2));
  background: rgb(var(--surface));
  color: rgb(var(--ink-2));
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
}
.chip:hover {
  border-color: rgb(var(--amber));
}
.chip.on {
  background: rgb(var(--amber-tint));
  border-color: rgb(var(--amber));
  color: rgb(var(--amber-hover));
}
.fp-check {
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
}
.ua {
  display: flex;
  gap: 6px;
}
.ua input {
  width: 50%;
}
.fp-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 2px;
  padding-top: 9px;
  border-top: 1px solid rgb(var(--line));
}
.btn-link {
  border: none;
  background: transparent;
  color: rgb(var(--amber-hover));
  font-size: 12px;
  font-weight: 500;
  padding: 4px 2px;
}
.btn-link:hover {
  text-decoration: underline;
}
.hint {
  font-size: 11px;
  color: rgb(var(--ink-3));
}
.btn-done {
  border: 1px solid rgb(var(--amber));
  background: rgb(var(--amber));
  color: #fff;
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 500;
}
.btn-done:hover {
  background: rgb(var(--amber-hover));
}
</style>
