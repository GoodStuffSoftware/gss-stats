<script setup lang="ts">
import { reactive, computed, watch } from 'vue'
import type { GlobalFilters } from '../types'
import { SITE_OPTIONS, SITES } from '../lib/catalog'

const props = defineProps<{ filters: GlobalFilters }>()
const emit = defineEmits<{ change: [GlobalFilters] }>()

const local = reactive<GlobalFilters>({ ...props.filters })
watch(
  () => props.filters,
  (f) => Object.assign(local, f),
  { deep: true },
)

function commit() {
  emit('change', { ...local })
}

const hostOptions = computed(() => {
  const s = SITES.find((x) => x.key === local.site)
  return s ? s.hosts : []
})

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
  const until = new Date(local.until + 'T00:00:00Z')
  const since = new Date(local.since + 'T00:00:00Z')
  const days = Math.round((until.getTime() - since.getTime()) / 86400000) + 1
  const today = new Date().toISOString().slice(0, 10)
  return local.until === today ? days : -1
})
</script>

<template>
  <div class="filter-bar">
    <div class="group">
      <label>Site</label>
      <select v-model="local.site" @change="onSiteChange">
        <option v-for="o in SITE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>

    <div v-if="hostOptions.length" class="group">
      <label>Subdomain</label>
      <select v-model="local.host" @change="commit">
        <option value="">All</option>
        <option v-for="h in hostOptions" :key="h" :value="h">{{ h.replace('.goodstuff.software', '') }}</option>
      </select>
    </div>

    <div class="group presets">
      <label>Range</label>
      <div class="preset-btns">
        <button :class="['chip', { on: activePreset === 7 }]" @click="preset(7)">7d</button>
        <button :class="['chip', { on: activePreset === 30 }]" @click="preset(30)">30d</button>
        <button :class="['chip', { on: activePreset === 90 }]" @click="preset(90)">90d</button>
      </div>
    </div>

    <div class="group">
      <label>From</label>
      <input type="date" v-model="local.since" @change="commit" />
    </div>
    <div class="group">
      <label>To</label>
      <input type="date" v-model="local.until" @change="commit" />
    </div>

    <div class="group check">
      <label>
        <input type="checkbox" v-model="local.excludeSelfReferrals" @change="commit" />
        Hide self-referrals
      </label>
    </div>
  </div>
</template>

<style scoped>
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 14px;
  padding: 12px 16px;
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line));
  border-radius: 14px;
}
.group {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.group.check {
  justify-content: flex-end;
}
.group.check label {
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
  padding-bottom: 7px;
}
.preset-btns {
  display: flex;
  gap: 4px;
}
.chip {
  border: 1px solid rgb(var(--line-2));
  background: rgb(var(--surface));
  color: rgb(var(--ink-2));
  border-radius: 8px;
  padding: 6px 11px;
  font-size: 12px;
  font-weight: 500;
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
</style>
