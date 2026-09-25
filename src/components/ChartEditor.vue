<script setup lang="ts">
import { reactive, computed, watch } from 'vue'
import type { Widget } from '../types'
import {
  DIMENSIONS,
  GEO_DIMENSIONS,
  POPUP_DIMENSIONS,
  POPUP_OPTIONS,
  POPUP_KIND_OPTIONS,
  POPUP_RATE_DIMENSIONS,
  DATASETS,
  CHART_TYPES,
  METRICS,
  SITE_OPTIONS,
} from '../lib/catalog'
import { ringDims, RING_SOFT_CAP } from '../lib/rings'

const props = defineProps<{ widget: Widget; isNew: boolean }>()
const emit = defineEmits<{ save: [Widget]; cancel: []; remove: [] }>()

const draft = reactive<Widget>({ ...props.widget })
watch(
  () => props.widget,
  (w) => Object.assign(draft, w),
)

const isGeo = computed(() => draft.dataset === 'geo')
const isPopup = computed(() => draft.dataset === 'popup')
const isRate = computed(() => draft.type === 'rate')
// A rate tile's "dimension" is a POPUP_RATE_SPECS key, not a group-by field — a wholly
// different picker domain from the count-mode dimensions below it.
const dimOptions = computed(() => (isRate.value ? POPUP_RATE_DIMENSIONS : isPopup.value ? POPUP_DIMENSIONS : isGeo.value ? GEO_DIMENSIONS : DIMENSIONS))
// A count-mode popup chart ('kind'/'reason'/'date'/'outcome') needs to know WHICH pop-up
// it's scoped to; 'reason'/'date' also need which funnel stage they break down/trend.
const popupNeedsPopup = computed(() => isPopup.value && !isRate.value && draft.dimension !== 'eligible' && draft.dimension !== 'installOutcome')
const popupNeedsKind = computed(() => isPopup.value && !isRate.value && (draft.dimension === 'reason' || draft.dimension === 'date'))

// Switching data source: keep the dimension + breakdown valid for the new source. The
// beacon supports a breakdown too (nested doughnut / stacked bar), so we remap rather
// than drop it; only the metric is beacon-agnostic (it's always a count).
function onDatasetChange() {
  if (!dimOptions.value.some((d) => d.key === draft.dimension)) {
    draft.dimension = dimOptions.value[0].key
  }
  if (draft.breakdown && !dimOptions.value.some((d) => d.key === draft.breakdown)) {
    draft.breakdown = undefined
  }
  // Extra rings (RUM vs geo dimension keys don't line up — e.g. 'deviceType' vs 'device') —
  // drop whichever no longer resolve in the new source's catalog.
  if (draft.rings?.length) {
    draft.rings = draft.rings.filter((r) => dimOptions.value.some((d) => d.key === r))
    if (!draft.rings.length) draft.rings = undefined
  }
  if (isGeo.value || isPopup.value) draft.metric = 'pageviews'
  if (isPopup.value && !draft.popup) draft.popup = POPUP_OPTIONS[0]?.value
  if (isPopup.value && !draft.popupKind) draft.popupKind = 'shown'
  if (!isPopup.value) {
    draft.popup = undefined
    draft.popupKind = undefined
  }
}

// Switching chart TYPE also switches dimension domain when it crosses into/out of
// 'rate' (a rate tile's dimension list is a different domain — see dimOptions above).
watch(
  () => draft.type,
  (t, prev) => {
    if (t === 'rate' && draft.dataset !== 'popup') {
      draft.dataset = 'popup'
      onDatasetChange()
    }
    const wasRate = prev === 'rate'
    const nowRate = t === 'rate'
    if (wasRate !== nowRate && !dimOptions.value.some((d) => d.key === draft.dimension)) {
      draft.dimension = dimOptions.value[0]?.key ?? ''
    }
  },
)

// ── Nested doughnut: extra rings beyond dimension + breakdown ──────────────────────────────
// Options for a ring pick: the same per-dataset catalog the dimension/breakdown selects use,
// minus 'date' (a ring must be a real group-by column — see lib/rings.ts) and whatever's
// already used elsewhere in the ring stack (dimension/breakdown/other rings), so the same
// field can't appear twice.
function ringOptionsFor(idx: number) {
  const used = new Set(ringDims(draft))
  const current = draft.rings?.[idx]
  if (current) used.delete(current) // keep this ring's own current value selectable
  return dimOptions.value.filter((d) => d.key !== 'date' && !used.has(d.key))
}
const canAddRing = computed(() => ringOptionsFor((draft.rings ?? []).length).length > 0)
const totalRingCount = computed(() => ringDims(draft).length)

function addRing() {
  const next = ringOptionsFor((draft.rings ?? []).length)[0]
  if (!next) return
  ;(draft.rings ??= []).push(next.key)
}
function setRing(idx: number, key: string) {
  if (draft.rings) draft.rings[idx] = key
}
function removeRing(idx: number) {
  draft.rings?.splice(idx, 1)
}
function moveRing(idx: number, dir: -1 | 1) {
  const list = draft.rings
  if (!list) return
  const j = idx + dir
  if (j < 0 || j >= list.length) return
  ;[list[idx], list[j]] = [list[j], list[idx]]
}

// The world map is geo-only.
watch(
  () => draft.type,
  (t) => {
    if (t === 'map' && draft.dataset !== 'geo') {
      draft.dataset = 'geo'
      onDatasetChange()
    }
  },
)

const typeDef = computed(() => CHART_TYPES.find((t) => t.value === draft.type))
const siteValue = computed({
  get: () => draft.site ?? 'inherit',
  set: (v: string) => {
    draft.site = v === 'inherit' ? undefined : (v as any)
  },
})

function save() {
  if (typeDef.value && !typeDef.value.needsDimension) draft.dimension = ''
  if (typeDef.value && !typeDef.value.allowsBreakdown) draft.breakdown = undefined
  if (draft.breakdown === '') draft.breakdown = undefined
  if (!popupNeedsPopup.value) draft.popup = undefined
  if (!popupNeedsKind.value) draft.popupKind = undefined
  // Extra rings only make sense for a nested doughnut with a breakdown set; sanitize (drop
  // blanks/duplicates/'date') and clear them entirely otherwise.
  if (draft.type === 'nestedDoughnut' && draft.breakdown) {
    const rings = (draft.rings ?? []).filter(
      (r, i, arr) => r && r !== 'date' && r !== draft.dimension && r !== draft.breakdown && arr.indexOf(r) === i,
    )
    draft.rings = rings.length ? rings : undefined
  } else {
    draft.rings = undefined
  }
  emit('save', { ...draft, i: draft.id })
}
</script>

<template>
  <div class="overlay" @click.self="emit('cancel')">
    <div class="panel">
      <h2>{{ isNew ? 'Add chart' : 'Edit chart' }}</h2>

      <div class="field">
        <label>Title</label>
        <input type="text" v-model="draft.title" placeholder="Chart title" />
      </div>

      <div class="field">
        <label>Data source</label>
        <select v-model="draft.dataset" @change="onDatasetChange">
          <option v-for="d in DATASETS" :key="d.value" :value="d.value === 'rum' ? undefined : d.value">{{ d.label }}</option>
        </select>
      </div>

      <div class="row">
        <div class="field">
          <label>Chart type</label>
          <select v-model="draft.type">
            <option v-for="t in CHART_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
          </select>
        </div>
        <div class="field" v-if="!isGeo && !isPopup">
          <label>Metric</label>
          <select v-model="draft.metric">
            <option v-for="m in METRICS" :key="m.value" :value="m.value">{{ m.label }}</option>
          </select>
        </div>
      </div>

      <div class="row" v-if="typeDef?.needsDimension">
        <div class="field">
          <label>{{ isRate ? 'Rate' : 'Group by' }}</label>
          <select v-model="draft.dimension">
            <option v-for="d in dimOptions" :key="d.key" :value="d.key">{{ d.label }}</option>
          </select>
        </div>
        <div class="field" v-if="typeDef?.allowsBreakdown">
          <label>Break down by</label>
          <select v-model="draft.breakdown">
            <option :value="undefined">— none —</option>
            <option v-for="d in dimOptions" :key="d.key" :value="d.key">{{ d.label }}</option>
          </select>
        </div>
      </div>

      <!-- Pop-up dataset (count mode): which funnel, and (for reason/date) which stage -->
      <div class="row" v-if="popupNeedsPopup || popupNeedsKind">
        <div class="field" v-if="popupNeedsPopup">
          <label>Pop-up</label>
          <select v-model="draft.popup">
            <option v-for="p in POPUP_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
          </select>
        </div>
        <div class="field" v-if="popupNeedsKind">
          <label>Funnel stage</label>
          <select v-model="draft.popupKind">
            <option v-for="k in POPUP_KIND_OPTIONS" :key="k.value" :value="k.value">{{ k.label }}</option>
          </select>
        </div>
      </div>

      <!-- Nested doughnut: further outward rings beyond dimension + breakdown (e.g. site →
           device → OS → browser). Each ring subdivides the one before it. -->
      <div class="field" v-if="draft.type === 'nestedDoughnut' && draft.breakdown">
        <label>Extra rings (outward from break-down)</label>
        <div class="rings-list">
          <div v-for="(r, idx) in draft.rings ?? []" :key="idx" class="ring-row">
            <select :value="r" @change="setRing(idx, $event.target.value)">
              <option v-for="d in ringOptionsFor(idx)" :key="d.key" :value="d.key">{{ d.label }}</option>
            </select>
            <button type="button" class="btn ring-btn" title="Move toward center" :disabled="idx === 0" @click="moveRing(idx, -1)">↑</button>
            <button
              type="button"
              class="btn ring-btn"
              title="Move outward"
              :disabled="idx === (draft.rings?.length ?? 0) - 1"
              @click="moveRing(idx, 1)"
            >
              ↓
            </button>
            <button type="button" class="btn ring-btn danger" title="Remove ring" @click="removeRing(idx)">✕</button>
          </div>
          <button type="button" class="btn" :disabled="!canAddRing" @click="addRing">+ Add ring</button>
          <p class="hint" v-if="totalRingCount >= RING_SOFT_CAP">
            {{ totalRingCount }} rings — charts get visually dense much past this.
          </p>
        </div>
      </div>

      <div class="row">
        <div class="field">
          <label>Limit (top N)</label>
          <input type="number" v-model.number="draft.limit" min="1" max="500" />
        </div>
        <div class="field">
          <label>Site override</label>
          <select v-model="siteValue">
            <option value="inherit">Inherit global</option>
            <option v-for="o in SITE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
      </div>

      <div class="field check" v-if="draft.dimension === 'refererHost'">
        <label>
          <input type="checkbox" v-model="draft.excludeSelfReferrals" />
          Exclude self-referrals &amp; direct
        </label>
      </div>

      <div class="actions">
        <button v-if="!isNew" class="btn danger" @click="emit('remove')">Delete</button>
        <span class="spacer"></span>
        <button class="btn" @click="emit('cancel')">Cancel</button>
        <button class="btn btn-primary" @click="save">{{ isNew ? 'Add chart' : 'Save' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 20px;
}
.panel {
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line-2));
  border-radius: 16px;
  padding: 22px 24px 20px;
  width: 100%;
  max-width: 460px;
  box-shadow: 0 20px 60px rgb(0 0 0 / 0.25);
}
h2 {
  font-size: 18px;
  margin-bottom: 16px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
  flex: 1;
}
.field input,
.field select {
  width: 100%;
}
.row {
  display: flex;
  gap: 12px;
}
.field.check label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.rings-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ring-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ring-row select {
  flex: 1;
  width: auto;
}
.ring-btn {
  flex-shrink: 0;
  padding: 6px 9px;
  line-height: 1;
}
.ring-btn.danger {
  color: #bc4749;
  border-color: rgb(188 71 73 / 0.4);
}
.hint {
  font-size: 12px;
  color: rgb(var(--ink-3));
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 18px;
}
.spacer {
  flex: 1;
}
.btn.danger {
  color: #bc4749;
  border-color: rgb(188 71 73 / 0.4);
}
.btn.danger:hover {
  border-color: #bc4749;
  background: rgb(188 71 73 / 0.06);
}
</style>
