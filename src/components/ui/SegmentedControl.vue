<script setup lang="ts">
// One segmented radio control (shared by SpendingPanel's Group by and BudgetTable's Cards | Table switch).
export interface SegOption {
  value: string
  label: string
  testid?: string
}
// `size="compact"` (opt-in) is a 36px control for a crowded line; the default is the 44px touch size.
// `collapsed` (opt-in) folds the options into ONE native dropdown with the same label and choices, for a line with no room:
// the owner decides when (it measures its own line); left off, the control is the buttons it always was.
defineProps<{ options: SegOption[]; modelValue: string; label: string; size?: 'default' | 'compact'; collapsed?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <select
    v-if="collapsed"
    class="seg-select"
    :class="{ 'seg-compact': size === 'compact' }"
    :aria-label="label"
    :value="modelValue"
    @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <option v-for="o in options" :key="o.value" :value="o.value" :data-testid="o.testid">{{ o.label }}</option>
  </select>
  <div v-else class="seg" :class="{ 'seg-compact': size === 'compact' }" role="radiogroup" :aria-label="label">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      class="seg-btn"
      role="radio"
      :aria-checked="modelValue === o.value"
      :data-testid="o.testid"
      @click="emit('update:modelValue', o.value)"
    >{{ o.label }}</button>
  </div>
</template>

<style scoped>
.seg {
  display: inline-flex;
  border: 1px solid rgb(var(--line));
  border-radius: 8px;
  overflow: hidden;
}
.seg-btn {
  min-height: 44px;
  padding: 0 14px;
  border: 0;
  background: transparent;
  color: rgb(var(--ink-2));
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}
.seg-btn[aria-checked='true'] {
  background: rgb(var(--sunken));
  color: rgb(var(--ink));
  font-weight: 600;
}
.seg-compact .seg-btn {
  min-height: 36px;
  padding: 0 10px;
  font-size: 13px;
}
.seg-btn:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: -2px;
}
/* The folded form: one dropdown, the same height as the buttons it replaces. */
.seg-select {
  min-height: 44px;
  max-width: 100%;
  padding: 0 8px;
  border: 1px solid rgb(var(--line));
  border-radius: 8px;
  background: rgb(var(--surface));
  color: rgb(var(--ink));
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.seg-select.seg-compact {
  min-height: 36px;
  font-size: 13px;
}
.seg-select:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: 1px;
}
</style>
