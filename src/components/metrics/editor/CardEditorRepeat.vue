<script setup lang="ts">
// One RepeatSpec editor, reused at card/section/item level (ADR 0003 section 4, "Repeat").
// Card-level repeat only ever offers campaigns/popups (the owner's "one per campaign, or one
// per pop-up"); a section/item repeat may also use windows/readings, per the type.
import { computed, useId } from 'vue'
import { CAMPAIGN_ID_OPTIONS, POPUP_ID_OPTIONS, withRepeatOver } from '../../../lib/metrics/editorModel'
import type { RepeatSpec } from '../../../lib/metrics/types'

const props = defineProps<{
  allow: RepeatSpec['over'][]
  label?: string
}>()
const repeat = defineModel<RepeatSpec | undefined>({ required: true })

const overId = useId()
const campaignsGroupId = useId()
const statusGroupId = useId()
const popupsGroupId = useId()

const OVER_LABELS: Record<RepeatSpec['over'], string> = {
  campaigns: 'One per campaign',
  popups: 'One per pop-up',
  windows: 'One per before/after window',
  readings: 'One per stored reading',
}

const overValue = computed<RepeatSpec['over'] | ''>({
  get: () => repeat.value?.over ?? '',
  set: (v) => {
    repeat.value = withRepeatOver(repeat.value, v)
  },
})

const idsValue = computed<string[]>({
  get: () => repeat.value?.ids ?? [],
  set: (v) => {
    if (!repeat.value) return
    repeat.value = { ...repeat.value, ids: v.length ? v : undefined }
  },
})
function toggleId(id: string, checked: boolean, all: { value: string }[]) {
  const set = new Set(idsValue.value)
  if (checked) set.add(id)
  else set.delete(id)
  idsValue.value = all.map((o) => o.value).filter((v) => set.has(v))
}

const STATUS_OPTIONS: NonNullable<RepeatSpec['status']>[number][] = ['closed', 'active', 'upcoming']
const statusValue = computed<NonNullable<RepeatSpec['status']>>({
  get: () => repeat.value?.status ?? [],
  set: (v) => {
    if (!repeat.value) return
    repeat.value = { ...repeat.value, status: v.length ? v : undefined }
  },
})
function toggleStatus(s: (typeof STATUS_OPTIONS)[number], checked: boolean) {
  const set = new Set(statusValue.value)
  if (checked) set.add(s)
  else set.delete(s)
  statusValue.value = STATUS_OPTIONS.filter((o) => set.has(o))
}

const flightingToday = computed<boolean>({
  get: () => !!repeat.value?.flightingToday,
  set: (v) => {
    if (!repeat.value) return
    repeat.value = { ...repeat.value, flightingToday: v || undefined }
  },
})
</script>

<template>
  <div class="field">
    <label :for="overId">{{ label ?? 'Repeat' }}</label>
    <select :id="overId" v-model="overValue">
      <option value="">None — a single card/item</option>
      <option v-for="o in allow" :key="o" :value="o">{{ OVER_LABELS[o] }}</option>
    </select>
  </div>

  <div class="field" v-if="overValue === 'campaigns'">
    <label :id="campaignsGroupId">Campaigns <span class="hint">— none checked = all</span></label>
    <div class="campaign-list" role="group" :aria-labelledby="campaignsGroupId">
      <label v-for="c in CAMPAIGN_ID_OPTIONS" :key="c.value" class="campaign-row">
        <input type="checkbox" :checked="idsValue.includes(c.value)" @change="toggleId(c.value, ($event.target as HTMLInputElement).checked, CAMPAIGN_ID_OPTIONS)" />
        {{ c.label }}
      </label>
    </div>
  </div>
  <div class="row" v-if="overValue === 'campaigns'">
    <div class="field">
      <label :id="statusGroupId">Status <span class="hint">— none checked = all</span></label>
      <div class="campaign-list" role="group" :aria-labelledby="statusGroupId">
        <label v-for="s in STATUS_OPTIONS" :key="s" class="campaign-row">
          <input type="checkbox" :checked="statusValue.includes(s)" @change="toggleStatus(s, ($event.target as HTMLInputElement).checked)" />
          {{ s }}
        </label>
      </div>
    </div>
    <div class="field check">
      <label><input type="checkbox" v-model="flightingToday" /> Flighting today only</label>
    </div>
  </div>

  <div class="field" v-if="overValue === 'popups'">
    <label :id="popupsGroupId">Pop-ups <span class="hint">— none checked = all</span></label>
    <div class="campaign-list" role="group" :aria-labelledby="popupsGroupId">
      <label v-for="p in POPUP_ID_OPTIONS" :key="p.value" class="campaign-row">
        <input type="checkbox" :checked="idsValue.includes(p.value)" @change="toggleId(p.value, ($event.target as HTMLInputElement).checked, POPUP_ID_OPTIONS)" />
        {{ p.label }}
      </label>
    </div>
  </div>
</template>

<style scoped src="./editor.css"></style>
