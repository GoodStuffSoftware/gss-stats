<script setup lang="ts">
// One segmented radio control (shared by SpendingPanel's Group by and BudgetTable's Cards | Table switch).
export interface SegOption {
  value: string
  label: string
  testid?: string
}
defineProps<{ options: SegOption[]; modelValue: string; label: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <div class="seg" role="radiogroup" :aria-label="label">
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
.seg-btn:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: -2px;
}
</style>
