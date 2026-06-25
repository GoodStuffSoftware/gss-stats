<script setup lang="ts">
import { reactive, computed, watch, ref, onMounted, onBeforeUnmount } from 'vue'
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

// ── Exclusions popout (noise filters) ─────────────────────────────────────────
const exclOpen = ref(false)
const exclCount = computed(() => (local.excludeSelfReferrals ? 1 : 0) + (local.excludeOwnVisits ? 1 : 0))
function closeExcl() {
  exclOpen.value = false
}
onMounted(() => document.addEventListener('click', closeExcl))
onBeforeUnmount(() => document.removeEventListener('click', closeExcl))
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

    <div class="group">
      <label>Exclusions</label>
      <div class="excl-anchor">
        <button class="excl-btn" :class="{ active: exclCount > 0 }" @click.stop="exclOpen = !exclOpen">
          ⛒ Exclusions<span v-if="exclCount" class="cnt">{{ exclCount }}</span>
        </button>
        <div v-if="exclOpen" class="excl-pop" @click.stop>
          <p class="excl-hint">Filter out noise so you see real audience.</p>
          <label class="excl-check" title="Referrer charts only — drops referrals from our own sites.">
            <input type="checkbox" v-model="local.excludeSelfReferrals" @change="commit" />
            Hide self-referrals
          </label>
          <label class="excl-check" title="Excludes your own machine from all numbers by browser + OS.">
            <input type="checkbox" v-model="local.excludeOwnVisits" @change="commit" />
            Hide my visits
          </label>
          <div v-if="local.excludeOwnVisits" class="excl-ua">
            <span class="ua-label">My browser / OS</span>
            <div class="ua-inputs">
              <input type="text" v-model="local.ownBrowser" @change="commit" placeholder="Opera" />
              <input type="text" v-model="local.ownOS" @change="commit" placeholder="Windows" />
            </div>
          </div>
        </div>
      </div>
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

/* Exclusions popout */
.excl-anchor {
  position: relative;
}
.excl-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 1px solid rgb(var(--line-2));
  background: rgb(var(--surface));
  color: rgb(var(--ink));
  border-radius: 9px;
  padding: 7px 12px;
  font-size: 13px;
  font-weight: 500;
}
.excl-btn:hover {
  border-color: rgb(var(--amber));
}
.excl-btn.active {
  border-color: rgb(var(--amber));
  background: rgb(var(--amber-tint));
  color: rgb(var(--amber-hover));
}
.excl-btn .cnt {
  background: rgb(var(--amber));
  color: #fff;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  min-width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}
.excl-pop {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 40;
  width: 240px;
  max-width: 78vw;
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line-2));
  border-radius: 12px;
  box-shadow: 0 14px 38px rgb(0 0 0 / 0.18);
  padding: 12px 13px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.excl-hint {
  margin: 0;
  font-size: 11px;
  color: rgb(var(--ink-3));
}
.excl-check {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.excl-ua {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.ua-label {
  font-size: 12px;
  color: rgb(var(--ink-2));
  font-weight: 500;
}
.ua-inputs {
  display: flex;
  gap: 6px;
}
.ua-inputs input {
  width: 50%;
}

@media (max-width: 640px) {
  .filter-bar {
    gap: 10px;
    padding: 10px 12px;
  }
  .group {
    flex: 1 1 calc(50% - 5px);
  }
  .group select,
  .group input {
    width: 100%;
  }
}
</style>
