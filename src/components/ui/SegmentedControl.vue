<script setup lang="ts">
// One segmented radio control (shared by SpendingPanel's Group by and BudgetTable's Cards | Table switch).
export interface SegOption {
  value: string
  label: string
  testid?: string
}
// `size="compact"` (opt-in) is a 36px control for a crowded line; the default is the 44px touch size.
defineProps<{ options: SegOption[]; modelValue: string; label: string; size?: 'default' | 'compact' }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <div class="seg" :class="{ 'seg-compact': size === 'compact' }" role="radiogroup" :aria-label="label">
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
</style>
