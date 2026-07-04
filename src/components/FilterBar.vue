<script setup lang="ts">
import { reactive, computed, watch, ref, onMounted, onBeforeUnmount } from 'vue'
import type { GlobalFilters } from '../types'
import { SITE_OPTIONS, SITES } from '../lib/catalog'
import { relativeRange, lastDays, isoToYmd, ymdRangeToISO, rangeLabel, isLastDays } from '../lib/range'

const props = defineProps<{ filters: GlobalFilters }>()
const emit = defineEmits<{ change: [GlobalFilters] }>()

const local = reactive<GlobalFilters>({ ...props.filters })

// Range display state (kept in sync with local.since/until).
const rangeInput = ref('')
const fromYmd = ref('')
const toYmd = ref('')
function syncRange() {
  rangeInput.value = rangeLabel(local.since, local.until)
  fromYmd.value = isoToYmd(local.since)
  toYmd.value = isoToYmd(local.until)
}
watch(
  () => props.filters,
  (f) => {
    Object.assign(local, f)
    syncRange()
  },
  { deep: true },
)
onMounted(syncRange)

function commit() {
  emit('change', { ...local })
}

const hostOptions = computed(() => SITES.find((x) => x.key === local.site)?.hosts ?? [])
function onSiteChange() {
  local.host = ''
  commit()
}

// ── Smart range ───────────────────────────────────────────────────────────────
const rangeOk = ref(true)
function applyRange() {
  const r = relativeRange(rangeInput.value)
  if (r) {
    local.since = r.since
    local.until = r.until
    rangeOk.value = true
    commit()
    syncRange()
  } else if (rangeInput.value.trim() === '') {
    syncRange() // empty → revert to label
    rangeOk.value = true
  } else {
    rangeOk.value = false // invalid token — flag, keep what they typed
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

// ── Calendar popover ──────────────────────────────────────────────────────────
const calOpen = ref(false)
function applyCal() {
  if (!fromYmd.value || !toYmd.value) return
  const [a, b] = fromYmd.value <= toYmd.value ? [fromYmd.value, toYmd.value] : [toYmd.value, fromYmd.value]
  const r = ymdRangeToISO(a, b)
  local.since = r.since
  local.until = r.until
  commit()
  rangeInput.value = rangeLabel(local.since, local.until)
}
function closeCal() {
  calOpen.value = false
}
onMounted(() => document.addEventListener('click', closeCal))
onBeforeUnmount(() => document.removeEventListener('click', closeCal))

// ── Exclusions popout ─────────────────────────────────────────────────────────
const exclOpen = ref(false)
const exclCount = computed(() => (local.excludeSelfReferrals ? 1 : 0) + (local.excludeOwnVisits ? 1 : 0))
function closeExcl() {
  exclOpen.value = false
}
onMounted(() => document.addEventListener('click', closeExcl))
onBeforeUnmount(() => document.removeEventListener('click', closeExcl))

// ── Exclude this device (beacon self-mute) ────────────────────────────────────
// The /mute page drops a durable gssb_mute cookie on .goodstuff.software (not
// HttpOnly), so we can read it here to show status. Opening it in a new tab sets
// the cookie on whichever device tapped the button.
const BEACON = 'https://beacon.goodstuff.software'
const deviceExcluded = ref(false)
function readMuteCookie() {
  deviceExcluded.value = /(?:^|;\s*)gssb_mute=1(?:;|$)/.test(document.cookie)
}
function excludeDevice() {
  window.open(`${BEACON}/mute`, '_blank', 'noopener')
}
function includeDevice() {
  window.open(`${BEACON}/unmute`, '_blank', 'noopener')
}
onMounted(() => {
  readMuteCookie()
  window.addEventListener('focus', readMuteCookie) // re-check when they return from the mute tab
})
onBeforeUnmount(() => window.removeEventListener('focus', readMuteCookie))
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

    <div class="group range">
      <label>Range</label>
      <div class="range-row">
        <input
          class="range-field"
          :class="{ bad: !rangeOk }"
          type="text"
          v-model="rangeInput"
          placeholder="7d · 24h · 3h · 2w"
          title="Type a span like 3h, 24h, 7d, 2w, 1mo — or use the calendar"
          @keydown.enter.prevent="applyRange"
          @blur="applyRange"
        />
        <button class="cal-btn" :class="{ on: calOpen }" title="Pick exact dates" @click.stop="calOpen = !calOpen">📅</button>
        <div class="chips">
          <button :class="['chip', { on: isPreset(1) }]" @click="setDays(1)">1d</button>
          <button :class="['chip', { on: isPreset(7) }]" @click="setDays(7)">7d</button>
          <button :class="['chip', { on: isPreset(30) }]" @click="setDays(30)">30d</button>
        </div>
        <div v-if="calOpen" class="cal-pop" @click.stop>
          <div class="cal-field">
            <label>From</label>
            <input type="date" v-model="fromYmd" @change="applyCal" />
          </div>
          <div class="cal-field">
            <label>To</label>
            <input type="date" v-model="toYmd" @change="applyCal" />
          </div>
          <button class="btn-done" @click="calOpen = false">Done</button>
        </div>
      </div>
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
          <div class="excl-device">
            <span class="ua-label">This device</span>
            <p class="dev-status" :class="{ on: deviceExcluded }">
              {{ deviceExcluded ? '✓ Excluded — visits from this device aren’t counted' : 'Counted in the data' }}
            </p>
            <button v-if="!deviceExcluded" class="dev-btn" @click="excludeDevice">Exclude this device</button>
            <button v-else class="dev-btn ghost" @click="includeDevice">Start counting it again</button>
            <p class="dev-note">
              Tag the exact phone or computer you tap this from — covers every goodstuff.software site, on Wi-Fi or
              cellular. Open the dashboard on each device you want excluded and tap once.
            </p>
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

/* Range */
.range-row {
  display: flex;
  align-items: center;
  gap: 6px;
  position: relative;
}
.range-field {
  width: 110px;
  font-family: 'JetBrains Mono', monospace;
}
.range-field.bad {
  border-color: #bc4749;
  outline-color: rgb(188 71 73 / 0.4);
}
.cal-btn {
  border: 1px solid rgb(var(--line-2));
  background: rgb(var(--surface));
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 13px;
  line-height: 1;
}
.cal-btn:hover,
.cal-btn.on {
  border-color: rgb(var(--amber));
}
.chips {
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
.cal-pop {
  position: absolute;
  left: 0;
  top: calc(100% + 6px);
  z-index: 40;
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line-2));
  border-radius: 12px;
  box-shadow: 0 14px 38px rgb(0 0 0 / 0.18);
  padding: 12px 13px;
  display: flex;
  align-items: flex-end;
  gap: 10px;
}
.cal-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.btn-done {
  border: 1px solid rgb(var(--amber));
  background: rgb(var(--amber));
  color: #fff;
  border-radius: 8px;
  padding: 7px 14px;
  font-size: 12px;
  font-weight: 500;
}
.btn-done:hover {
  background: rgb(var(--amber-hover));
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
.excl-device {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid rgb(var(--line-2));
}
.dev-status {
  margin: 0;
  font-size: 11px;
  color: rgb(var(--ink-3));
}
.dev-status.on {
  color: rgb(var(--amber));
  font-weight: 600;
}
.dev-btn {
  padding: 7px 10px;
  border: none;
  border-radius: 8px;
  background: rgb(var(--amber));
  color: #fff;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
}
.dev-btn.ghost {
  background: transparent;
  color: rgb(var(--ink-2));
  border: 1px solid rgb(var(--line-2));
}
.dev-note {
  margin: 0;
  font-size: 10.5px;
  line-height: 1.35;
  color: rgb(var(--ink-3));
}

@media (max-width: 640px) {
  .filter-bar {
    gap: 10px;
    padding: 10px 12px;
  }
  /* The Exclusions button sits on the left on mobile, so a right-anchored popout
     runs off the left edge. Anchor it left and clamp to the viewport instead. */
  .excl-pop {
    left: 0;
    right: auto;
    width: 264px;
    max-width: calc(100vw - 40px);
  }
  /* Keep the calendar's two date fields from overflowing the right edge. */
  .cal-pop {
    flex-wrap: wrap;
    max-width: calc(100vw - 40px);
  }
}
</style>
