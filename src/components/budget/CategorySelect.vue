<script setup lang="ts">
// The category choice of one transaction: a colour dot beside a native <select> (categories, "Uncategorized",
// then the "Not spending" group). It only reports the choice (`change`); the table decides what it means.
import { computed, nextTick } from 'vue'
import type { SelectOption } from '../table/EditableTable.vue'

const props = defineProps<{
  value: string
  options: SelectOption[]
  /** CSS colour of the dot. */
  color: string
  label: string
  disabled?: boolean
}>()
const emit = defineEmits<{ change: [value: string] }>()

const loose = computed(() => props.options.filter((o) => !o.group))
const groups = computed(() => {
  const names = [...new Set(props.options.filter((o) => o.group).map((o) => o.group as string))]
  return names.map((g) => ({ group: g, options: props.options.filter((o) => o.group === g) }))
})

function onChange(ev: Event) {
  const el = ev.target as HTMLSelectElement
  emit('change', el.value)
  // The table owns the value: if it does not take this one, show the old one again.
  void nextTick(() => {
    el.value = props.value
  })
}
</script>

<template>
  <span class="cs">
    <span class="cs-dot" :style="{ background: color }" aria-hidden="true" />
    <select class="cs-select" :value="value" :disabled="disabled" :aria-label="label" @change="onChange">
      <option v-for="o in loose" :key="o.value" :value="o.value" :disabled="o.disabled">{{ o.label }}</option>
      <optgroup v-for="g in groups" :key="g.group" :label="g.group">
        <option v-for="o in g.options" :key="o.value" :value="o.value" :disabled="o.disabled">{{ o.label }}</option>
      </optgroup>
    </select>
  </span>
</template>

<style scoped>
.cs {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.cs-dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.cs-select {
  flex: 1;
  min-width: 0;
  min-height: 32px;
  font: inherit;
  color: rgb(var(--ink));
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line-2));
  border-radius: 6px;
  padding: 4px 6px;
}
/* Phone card layout: full width, 44 px tall. */
:global(.et-cards) .cs-select {
  min-height: 44px;
  font-size: 15px;
}
</style>
