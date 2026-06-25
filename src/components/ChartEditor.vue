<script setup lang="ts">
import { reactive, computed, watch } from 'vue'
import type { Widget } from '../types'
import { DIMENSIONS, GEO_DIMENSIONS, DATASETS, CHART_TYPES, METRICS, SITE_OPTIONS } from '../lib/catalog'

const props = defineProps<{ widget: Widget; isNew: boolean }>()
const emit = defineEmits<{ save: [Widget]; cancel: []; remove: [] }>()

const draft = reactive<Widget>({ ...props.widget })
watch(
  () => props.widget,
  (w) => Object.assign(draft, w),
)

const isGeo = computed(() => draft.dataset === 'geo')
const dimOptions = computed(() => (isGeo.value ? GEO_DIMENSIONS : DIMENSIONS))

// Switching data source: keep the dimension valid for the new source.
function onDatasetChange() {
  if (!dimOptions.value.some((d) => d.key === draft.dimension)) {
    draft.dimension = dimOptions.value[0].key
  }
  if (isGeo.value) {
    draft.breakdown = undefined
    draft.metric = 'pageviews'
  }
}

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
        <div class="field" v-if="!isGeo">
          <label>Metric</label>
          <select v-model="draft.metric">
            <option v-for="m in METRICS" :key="m.value" :value="m.value">{{ m.label }}</option>
          </select>
        </div>
      </div>

      <div class="row" v-if="typeDef?.needsDimension">
        <div class="field">
          <label>Group by</label>
          <select v-model="draft.dimension">
            <option v-for="d in dimOptions" :key="d.key" :value="d.key">{{ d.label }}</option>
          </select>
        </div>
        <div class="field" v-if="typeDef?.allowsBreakdown && !isGeo">
          <label>Break down by</label>
          <select v-model="draft.breakdown">
            <option :value="undefined">— none —</option>
            <option v-for="d in dimOptions" :key="d.key" :value="d.key">{{ d.label }}</option>
          </select>
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
