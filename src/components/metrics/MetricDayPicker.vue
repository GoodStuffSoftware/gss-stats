<script setup lang="ts">
// The day selector of a "today so far" card: previous / next day arrows and a date pick. `day` is
// the chosen ET day, `null` = today (the live view); "next" is disabled at today and the date input
// never offers a day past today or before the server's floor. Pure view: the parent holds the state.
import { computed } from 'vue'
import { dayBounds, dayLabel, effectiveDay, stepDay } from '../../lib/glanceDay'

const props = defineProps<{ day: string | null; todayEt: string }>()
const emit = defineEmits<{ 'update:day': [day: string | null] }>()

const bounds = computed(() => dayBounds(props.todayEt))
const shown = computed(() => props.day ?? props.todayEt)
const atFloor = computed(() => shown.value <= bounds.value.min)
const atToday = computed(() => props.day === null)

function step(delta: -1 | 1) {
  emit('update:day', stepDay(props.day, delta, props.todayEt))
}
function onPick(e: Event) {
  const v = (e.target as HTMLInputElement).value
  // Cleared (the control's own Clear): back to today.
  emit('update:day', v ? effectiveDay(v, props.todayEt) : null)
}
</script>

<template>
  <span class="mc-day" role="group" aria-label="Choose day">
    <button type="button" class="mc-day-btn" :disabled="atFloor" title="Previous day" aria-label="Previous day" @click.stop="step(-1)">‹</button>
    <input class="mc-day-input" type="date" :value="shown" :min="bounds.min" :max="bounds.max" :aria-label="`Day: ${dayLabel(shown)}`" @change="onPick" @click.stop />
    <button type="button" class="mc-day-btn" :disabled="atToday" title="Next day" aria-label="Next day" @click.stop="step(1)">›</button>
    <button v-if="!atToday" type="button" class="mc-day-today" @click.stop="emit('update:day', null)">Today</button>
  </span>
</template>

<style scoped>
.mc-day {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.mc-day-btn,
.mc-day-today {
  font: inherit;
  font-size: 12px;
  line-height: 1;
  padding: 3px 7px;
  border: 1px solid rgb(var(--ink-3) / 0.35);
  border-radius: 5px;
  background: transparent;
  color: rgb(var(--ink-2));
  cursor: pointer;
}
.mc-day-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.mc-day-input {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  padding: 2px 4px;
  border: 1px solid rgb(var(--ink-3) / 0.35);
  border-radius: 5px;
  background: transparent;
  color: rgb(var(--ink-2));
}
</style>
