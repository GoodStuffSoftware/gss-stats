<script setup lang="ts">
// ONE "insert something into this text" control, used by every text box that takes inserts: the
// chart caption and note widget's "Insert value" and "Insert from library", and the card editor's
// label "Insert value" (notes plan, slice 1d release 2).
//
// Insertion is an explicit choice. A closed native <select> fires `change` on every arrow key
// (Windows Chrome and Edge, review N3), so a keyboard user stepping through the list would drop
// one token per option into the text. The select here only PICKS; the Insert button commits, and
// is disabled until something is picked. After a commit the pick resets, so the same entry can be
// inserted again. The select keeps its accessible name (`label`) and the button names what it
// will insert.
import { computed, ref } from 'vue'

export interface InsertOption {
  value: string
  label: string
}
export interface InsertGroup {
  /** The optgroup heading; '' renders its options ungrouped. */
  group: string
  options: InsertOption[]
}

const props = defineProps<{
  /** The select's accessible name, e.g. "Insert value". */
  label: string
  /** The empty first option, e.g. "Insert value ▾". */
  placeholder: string
  groups: InsertGroup[]
  /** A class on the select, so a caller's existing hooks stay (e.g. `insert-value`). */
  selectClass?: string
}>()
const emit = defineEmits<{ insert: [value: string] }>()

const picked = ref('')
const pickedLabel = computed(() => {
  for (const g of props.groups) for (const o of g.options) if (o.value === picked.value) return o.label
  return ''
})
function commit() {
  if (!picked.value) return
  const value = picked.value
  picked.value = ''
  emit('insert', value)
}
</script>

<template>
  <span class="insert-picker">
    <select v-model="picked" :class="selectClass" :aria-label="label">
      <option value="">{{ placeholder }}</option>
      <template v-for="g in groups" :key="g.group">
        <optgroup v-if="g.group" :label="g.group">
          <option v-for="o in g.options" :key="o.value" :value="o.value">{{ o.label }}</option>
        </optgroup>
        <template v-else>
          <option v-for="o in g.options" :key="o.value" :value="o.value">{{ o.label }}</option>
        </template>
      </template>
    </select>
    <button type="button" class="btn insert-picker-btn" :disabled="!picked" :aria-label="pickedLabel ? `Insert ${pickedLabel}` : `${label}: pick one first`" @click="commit">Insert</button>
  </span>
</template>

<style scoped>
.insert-picker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.insert-picker select {
  flex: 1;
  width: auto;
  min-width: 0;
}
.insert-picker-btn {
  flex: none;
  padding: 5px 10px;
}
.insert-picker-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
