<script setup lang="ts">
import { reactive, computed, watch, ref, onMounted, onBeforeUnmount } from 'vue'
import type { GlobalFilters } from '../types'
import { sitesTree } from '../sitesStore'
import type { SiteGroup, SiteSub } from '../types'
import { relativeRange, isoToYmd, ymdRangeToISO, rangeLabel } from '../lib/range'

const props = defineProps<{ filters: GlobalFilters; syncRange?: boolean }>()
const emit = defineEmits<{ change: [GlobalFilters]; toggleSync: [boolean] }>()

const local = reactive<GlobalFilters>({ ...props.filters })
if (!Array.isArray(local.siteSel)) local.siteSel = []

// Range display state (kept in sync with local.since/until).
const rangeInput = ref('')
const fromYmd = ref('')
const toYmd = ref('')
function syncRange() {
  rangeInput.value = rangeLabel(local.since, local.until)
  fromYmd.value = isoToYmd(local.since)
  toYmd.value = isoToYmd(local.until)
  const idx = currentStepIdx()
  if (idx >= 0) sliderIdx.value = idx
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

// ── Sites multi-select ────────────────────────────────────────────────────────
// Selection = a list of full-host tokens; a whole site is just all its subs checked;
// empty = all real sites. Standard tri-state parent (all/some/none) + child model.
const siteOpen = ref(false)
function closeSites() {
  siteOpen.value = false
}
onMounted(() => document.addEventListener('click', closeSites))
onBeforeUnmount(() => document.removeEventListener('click', closeSites))

// v-indeterminate: set the checkbox's indeterminate (dash) state for partial sites.
const vIndeterminate = {
  mounted(el: HTMLInputElement, b: { value: boolean }) {
    el.indeterminate = !!b.value
  },
  updated(el: HTMLInputElement, b: { value: boolean }) {
    el.indeterminate = !!b.value
  },
}

function setSel(next: string[]) {
  local.siteSel = next
  commit()
}
// Whole site = a domain token; a subdomain = a full-host token; empty = all sites.
// The apex host (host === domain) is hidden — it's a redirect, so it's covered by the
// whole-site selection (which includes it via resolveSelection) rather than a
// redundant row. Sites whose ONLY host is the apex show just the site row.
function displayedSubs(d: SiteGroup): SiteSub[] {
  return d.subs.filter((s) => s.host !== d.domain)
}
function isSubSelected(d: SiteGroup, s: SiteSub) {
  const sel = local.siteSel ?? []
  return sel.includes(d.domain) || sel.includes(s.host)
}
function siteState(d: SiteGroup): 'all' | 'some' | 'none' {
  const sel = local.siteSel ?? []
  if (sel.includes(d.domain)) return 'all'
  const subs = displayedSubs(d)
  if (!subs.length) return 'none'
  const n = subs.filter((s) => sel.includes(s.host)).length
  return n === 0 ? 'none' : n === subs.length ? 'all' : 'some'
}
function toggleSite(d: SiteGroup) {
  const sel = local.siteSel ?? []
  const cleared = sel.filter((t) => t !== d.domain && !d.subs.some((s) => s.host === t))
  setSel(siteState(d) === 'all' ? cleared : [...cleared, d.domain]) // whole site = one domain token
}
function toggleSub(d: SiteGroup, s: SiteSub) {
  let sel = [...(local.siteSel ?? [])]
  // expand a whole-site token into its subdomains so one can be toggled off
  if (sel.includes(d.domain)) sel = sel.filter((t) => t !== d.domain).concat(displayedSubs(d).map((x) => x.host))
  sel = sel.includes(s.host) ? sel.filter((t) => t !== s.host) : [...sel, s.host]
  setSel(sel)
}
function subLabel(d: SiteGroup, s: SiteSub) {
  return s.host.endsWith('.' + d.domain) ? s.host.slice(0, -(d.domain.length + 1)) : s.host
}
function clearSites() {
  setSel([])
}
const siteSummary = computed(() => {
  const sel = local.siteSel ?? []
  if (!sel.length) return 'All sites'
  if (sel.length === 1) {
    if (sitesTree.value.some((g) => g.domain === sel[0])) return sel[0]
    for (const g of sitesTree.value) {
      const s = g.subs.find((x) => x.host === sel[0])
      if (s) return subLabel(g, s)
    }
    return sel[0]
  }
  return `${sel.length} selected`
})

// ── Smart range ───────────────────────────────────────────────────────────────
const rangeOk = ref(true)
function applyRange() {
  const r = relativeRange(rangeInput.value)
  if (r) {
    local.since = r.since
    local.until = r.until
    local.rangeRel = rangeInput.value.trim() // remember the relative span
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
// ── Range slider ──────────────────────────────────────────────────────────────
// One control replaces the day chips: a vertical slider where the bottom is hours
// (1h–23h) and the top is days (1d–30d). Index 0 = 1h (bottom) … 52 = 30d (top).
const RANGE_STEPS: { label: string; ms: number }[] = [
  ...Array.from({ length: 23 }, (_, i) => ({ label: `${i + 1}h`, ms: (i + 1) * 3_600_000 })),
  ...Array.from({ length: 30 }, (_, i) => ({ label: `${i + 1}d`, ms: (i + 1) * 86_400_000 })),
]
const sliderOpen = ref(false)
const sliderIdx = ref(29) // default = 7d (index 22 + 7)
function closeSlider() {
  sliderOpen.value = false
}
onMounted(() => document.addEventListener('click', closeSlider))
onBeforeUnmount(() => document.removeEventListener('click', closeSlider))

// Nearest step to the current "last N" window, or -1 if it's a custom (calendar) range.
function currentStepIdx(): number {
  const s = new Date(local.since).getTime()
  const u = new Date(local.until).getTime()
  if (!isFinite(s) || !isFinite(u) || Math.abs(Date.now() - u) > 180_000) return -1
  const span = u - s
  let best = 0
  let bestD = Infinity
  RANGE_STEPS.forEach((st, i) => {
    const d = Math.abs(st.ms - span)
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}
// Button caption: the current step ("7d" / "6h") or "Range" for a custom window.
const sliderLabel = computed(() => {
  const idx = currentStepIdx()
  return idx >= 0 ? RANGE_STEPS[idx].label : 'Range'
})
// Apply the picked step (fires on release). Rolling window ending now.
function onSlider() {
  const st = RANGE_STEPS[sliderIdx.value] ?? RANGE_STEPS[29]
  const until = new Date()
  local.since = new Date(until.getTime() - st.ms).toISOString()
  local.until = until.toISOString()
  local.rangeRel = st.label // stays this relative span across reloads
  commit()
  syncRange()
}

// ── Calendar popover ──────────────────────────────────────────────────────────
const calOpen = ref(false)
function applyCal() {
  if (!fromYmd.value || !toYmd.value) return
  const [a, b] = fromYmd.value <= toYmd.value ? [fromYmd.value, toYmd.value] : [toYmd.value, fromYmd.value]
  const r = ymdRangeToISO(a, b)
  local.since = r.since
  local.until = r.until
  local.rangeRel = '' // absolute (calendar) range — keep exactly these dates
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
      <label>Sites</label>
      <div class="site-anchor">
        <button class="site-btn" :class="{ active: (local.siteSel?.length || 0) > 0 }" @click.stop="siteOpen = !siteOpen">
          <span class="glyph">🌐</span>{{ siteSummary }}
        </button>
        <div v-if="siteOpen" class="site-pop" @click.stop>
          <div class="site-pop-head">
            <span>Sites &amp; subdomains</span>
            <button v-if="(local.siteSel?.length || 0) > 0" class="site-clear" @click="clearSites">All</button>
          </div>
          <p v-if="!sitesTree.length" class="site-empty">No sites with data yet.</p>
          <div v-for="d in sitesTree" :key="d.domain" class="site-group">
            <label class="site-row domain">
              <input
                type="checkbox"
                :checked="siteState(d) === 'all'"
                v-indeterminate="siteState(d) === 'some'"
                @change="toggleSite(d)"
              />
              <span class="site-name">{{ d.domain }}</span>
              <span class="site-count">{{ d.rum + d.geo }}</span>
            </label>
            <label v-for="s in displayedSubs(d)" :key="s.host" class="site-row sub">
              <input type="checkbox" :checked="isSubSelected(d, s)" @change="toggleSub(d, s)" />
              <span class="site-name">{{ subLabel(d, s) }}</span>
              <span class="site-count">{{ s.rum + s.geo }}</span>
            </label>
          </div>
        </div>
      </div>
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
        <div class="slider-anchor">
          <button
            class="chip slider-btn"
            :class="{ on: sliderOpen }"
            title="Drag to pick how far back — hours at the bottom, days up to 30 at the top"
            @click.stop="sliderOpen = !sliderOpen"
          >
            ⏱ {{ sliderLabel }}
          </button>
          <div v-if="sliderOpen" class="slider-pop" @click.stop>
            <div class="slider-cur">Last {{ RANGE_STEPS[sliderIdx]?.label ?? '7d' }}</div>
            <div class="slider-body">
              <span class="slider-cap">30d</span>
              <input
                class="range-slider"
                type="range"
                min="0"
                max="52"
                step="1"
                v-model.number="sliderIdx"
                @change="onSlider"
              />
              <span class="slider-cap">1h</span>
            </div>
          </div>
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

    <div class="group">
      <label>Pages</label>
      <label
        class="sync-toggle"
        :class="{ on: syncRange }"
        title="When on, the date range applies to every page at once. Each page keeps its own sites and drill-downs."
      >
        <input
          type="checkbox"
          :checked="syncRange"
          @change="emit('toggleSync', ($event.target as HTMLInputElement).checked)"
        />
        🔗 Sync range
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

/* Range slider — one control for the whole 1h…30d span. */
.slider-anchor {
  position: relative;
}
.slider-btn {
  cursor: pointer;
}
.slider-pop {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 40;
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line-2));
  border-radius: 12px;
  box-shadow: 0 14px 38px rgb(0 0 0 / 0.18);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.slider-cur {
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  font-weight: 600;
  color: rgb(var(--amber-hover));
}
.slider-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.slider-cap {
  font-size: 11px;
  font-weight: 500;
  color: rgb(var(--ink-2));
}
.range-slider {
  writing-mode: vertical-lr;
  direction: rtl;
  width: 24px;
  height: 190px;
  accent-color: rgb(var(--amber));
  cursor: pointer;
}

/* Sync-range toggle — share the date window across every page. */
.sync-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid rgb(var(--line-2));
  background: rgb(var(--surface));
  color: rgb(var(--ink-2));
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.sync-toggle:hover {
  border-color: rgb(var(--amber));
}
.sync-toggle.on {
  background: rgb(var(--amber-tint));
  border-color: rgb(var(--amber));
  color: rgb(var(--amber-hover));
}
.sync-toggle input {
  accent-color: rgb(var(--amber));
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

/* Sites multi-select */
.site-anchor {
  position: relative;
}
.site-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 1px solid rgb(var(--line-2));
  background: rgb(var(--surface));
  color: rgb(var(--ink));
  border-radius: 9px;
  padding: 7px 12px;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.site-btn.active {
  border-color: rgb(var(--amber));
  color: rgb(var(--amber));
}
.site-btn .glyph {
  opacity: 0.8;
}
.site-btn .cnt {
  background: rgb(var(--amber));
  color: #fff;
  border-radius: 999px;
  min-width: 17px;
  height: 17px;
  padding: 0 5px;
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.site-pop {
  position: absolute;
  left: 0;
  top: calc(100% + 6px);
  z-index: 40;
  width: 280px;
  max-width: 82vw;
  max-height: 340px;
  overflow-y: auto;
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line-2));
  border-radius: 12px;
  box-shadow: 0 14px 38px rgb(0 0 0 / 0.18);
  padding: 8px;
}
.site-pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px 8px;
  font-size: 11px;
  font-weight: 600;
  color: rgb(var(--ink-3));
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.site-clear {
  border: none;
  background: transparent;
  color: rgb(var(--amber));
  font-weight: 700;
  font-size: 11px;
  cursor: pointer;
}
.site-group {
  padding: 2px 0;
  border-top: 1px solid rgb(var(--line));
}
.site-group:first-of-type {
  border-top: none;
}
.site-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 7px;
  cursor: pointer;
}
.site-row:hover {
  background: rgb(var(--line) / 0.6);
}
.site-row.domain .site-name {
  font-weight: 600;
}
.site-row.sub {
  padding-left: 22px;
}
.site-row .site-name {
  flex: 1;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.site-row .site-count {
  font-size: 11px;
  color: rgb(var(--ink-3));
  font-variant-numeric: tabular-nums;
}
.site-empty {
  margin: 8px 6px;
  font-size: 12px;
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
  .site-pop {
    max-width: calc(100vw - 40px);
  }
}
</style>
