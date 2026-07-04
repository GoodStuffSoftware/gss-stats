<script setup lang="ts">
import { reactive, watch, ref } from 'vue'
import type { GlobalFilters } from '../types'
import { relativeRange, lastDays, isoToYmd, ymdRangeToISO, rangeLabel, isLastDays } from '../lib/range'

const props = defineProps<{ start: GlobalFilters; active: boolean }>()
const emit = defineEmits<{ apply: [GlobalFilters]; useGlobal: []; close: [] }>()

const local = reactive<GlobalFilters>({ ...props.start })

const rangeInput = ref('')
const fromYmd = ref('')
const toYmd = ref('')
function syncRange() {
  rangeInput.value = rangeLabel(local.since, local.until)
  fromYmd.value = isoToYmd(local.since)
  toYmd.value = isoToYmd(local.until)
}
watch(
  () => props.start,
  (s) => {
    Object.assign(local, s)
    syncRange()
  },
  { deep: true },
)
syncRange()

function commit() {
  emit('apply', { ...local })
}

const rangeOk = ref(true)
function applyRange() {
  const r = relativeRange(rangeInput.value)
  if (r) {
    local.since = r.since
    local.until = r.until
    rangeOk.value = true
    commit()
    syncRange()
  } else if (!rangeInput.value.trim()) {
    syncRange()
    rangeOk.value = true
  } else {
    rangeOk.value = false
  }
}
function setDays(n: number) {
  const r = lastDays(n)
  local.since = r.since
  local.until = r.until
  commit()
  syncRange()
}
function isPreset(n: number) {
  return isLastDays(local.since, local.until, n)
}
function applyCal() {
  if (!fromYmd.value || !toYmd.value) return
  const [a, b] = fromYmd.value <= toYmd.value ? [fromYmd.value, toYmd.value] : [toYmd.value, fromYmd.value]
  const r = ymdRangeToISO(a, b)
  local.since = r.since
  local.until = r.until
  commit()
  rangeInput.value = rangeLabel(local.since, local.until)
}
</script>

<template>
  <div class="fp">
    <header class="fp-head">
      <span class="fp-title">Chart filter</span>
      <button class="x" title="Done" @click="emit('close')">✕</button>
    </header>

    <div class="fp-field">
      <label>Range</label>
      <input
        class="rangefield"
        :class="{ bad: !rangeOk }"
        type="text"
        v-model="rangeInput"
        placeholder="7d · 24h · 3h · 2w"
        @keydown.enter.prevent="applyRange"
        @blur="applyRange"
      />
      <div class="presets">
        <button :class="['chip', { on: isPreset(1) }]" @click="setDays(1)">1d</button>
        <button :class="['chip', { on: isPreset(7) }]" @click="setDays(7)">7d</button>
        <button :class="['chip', { on: isPreset(30) }]" @click="setDays(30)">30d</button>
      </div>
    </div>

    <div class="fp-row">
      <div class="fp-field">
        <label>From</label>
        <input type="date" v-model="fromYmd" @change="applyCal" />
      </div>
      <div class="fp-field">
        <label>To</label>
        <input type="date" v-model="toYmd" @change="applyCal" />
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
.rangefield {
  font-family: 'JetBrains Mono', monospace;
}
.rangefield.bad {
  border-color: #bc4749;
}
.fp-row {
  display: flex;
  gap: 8px;
}
.presets {
  display: flex;
  gap: 4px;
  margin-top: 5px;
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
