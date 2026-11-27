<script setup lang="ts">
// A month calendar for picking one date or a date range. Shared UI (ADR 0005/0007): no Budget knowledge in it.
// Props: from, to (the current dates, 'YYYY-MM-DD', '' for none), today (the day to mark), min / max (the dates that can be
// picked), maxDays (the longest range, counting both ends).
// Emits: `pick` ({from, to}; from <= to) and `done` (the pick is finished; the owner closes the calendar).
// Click one day: that single date is picked at once (a one-day range). The calendar stays open for a second click:
// another day makes the range (start and end in either order) and finishes; the same day again finishes with just that day.
// While the second day is pending the range highlights from the first day to the day under the pointer or the keyboard.
// Keyboard: arrows move by a day or a week, Home / End go to the start / end of the week, PageUp / PageDown change the
// month (with Shift the year), Enter or Space picks. The owner handles Escape.
// Weeks run Sunday to Saturday.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { addDays, daysBetween, formatDate, monthName, weekday, ymd } from '../../lib/smartDate'

const props = defineProps<{ from: string; to: string; today: string; min?: string; max?: string; maxDays?: number }>()
const emit = defineEmits<{ pick: [r: { from: string; to: string }]; done: [] }>()

const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const root = ref<HTMLElement | null>(null)
const anchor = ref<string | null>(null) // the first click of a range, until the second
const hover = ref<string | null>(null)
const startDate = computed(() => {
  const d = props.from || props.to || props.today
  // Open on a day that can be picked: inside min..max.
  if (props.min && d < props.min) return props.min
  if (props.max && d > props.max) return props.max
  return d
})
const focusDate = ref(startDate.value)
const view = ref<{ y: number; m: number }>({ y: Number(focusDate.value.slice(0, 4)), m: Number(focusDate.value.slice(5, 7)) })

const title = computed(() => monthName(view.value.y, view.value.m))
const weeks = computed(() => {
  const first = ymd(view.value.y, view.value.m, 1)
  const gridStart = addDays(first, -weekday(first))
  return Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(gridStart, w * 7 + d)))
})

/** The one day in the grid that Tab lands on: the focused day when it is shown and pickable, else the first pickable day of the month. */
const tabStop = computed<string | null>(() => {
  const days = weeks.value.flat()
  if (days.includes(focusDate.value) && !disabled(focusDate.value)) return focusDate.value
  return days.find((d) => Number(d.slice(5, 7)) === view.value.m && !disabled(d)) ?? null
})

/** The range being shown: the pending first click through the hovered day, else the current value. */
const shown = computed<{ a: string; b: string } | null>(() => {
  if (anchor.value) {
    const h = hover.value ?? anchor.value
    return h < anchor.value ? { a: h, b: anchor.value } : { a: anchor.value, b: h }
  }
  if (props.from && props.to) return { a: props.from, b: props.to }
  return null
})

function disabled(d: string): boolean {
  if (props.min && d < props.min) return true
  if (props.max && d > props.max) return true
  if (anchor.value && props.maxDays && Math.abs(daysBetween(anchor.value, d)) + 1 > props.maxDays) return true
  return false
}
function cellClass(d: string) {
  const s = shown.value
  return {
    out: Number(d.slice(5, 7)) !== view.value.m,
    today: d === props.today,
    sel: !!s && d >= s.a && d <= s.b,
    edge: !!s && (d === s.a || d === s.b),
    start: !!s && d === s.a,
    end: !!s && d === s.b,
    pending: !!anchor.value && d === anchor.value,
  }
}
function label(d: string): string {
  return `${DOW_LONG[weekday(d)]}, ${formatDate(d)}`
}

function setView(y: number, m: number) {
  const t = ymd(y, m, 1)
  view.value = { y: Number(t.slice(0, 4)), m: Number(t.slice(5, 7)) }
}
function prev() { setView(view.value.y, view.value.m - 1); focusDate.value = shiftMonths(focusDate.value, -1) }
function next() { setView(view.value.y, view.value.m + 1); focusDate.value = shiftMonths(focusDate.value, 1) }
function focusCell() {
  void nextTick(() => root.value?.querySelector<HTMLButtonElement>(`button[data-date="${tabStop.value ?? focusDate.value}"]`)?.focus())
}
function goToday() {
  focusDate.value = props.today
  setView(Number(props.today.slice(0, 4)), Number(props.today.slice(5, 7)))
  focusCell()
}
function moveFocus(to: string) {
  if (disabled(to)) return // a day outside the allowed dates: focus stays where it is
  focusDate.value = to
  setView(Number(to.slice(0, 4)), Number(to.slice(5, 7)))
  if (anchor.value) hover.value = to
  focusCell()
}
function shiftMonths(d: string, n: number): string {
  const [y, m, day] = [Number(d.slice(0, 4)), Number(d.slice(5, 7)), Number(d.slice(8, 10))]
  const lastOfTarget = Number(ymd(y, m + n + 1, 0).slice(8, 10))
  return ymd(y, m + n, Math.min(day, lastOfTarget))
}
function onKey(e: KeyboardEvent) {
  const f = focusDate.value
  let to: string | null = null
  switch (e.key) {
    case 'ArrowLeft': to = addDays(f, -1); break
    case 'ArrowRight': to = addDays(f, 1); break
    case 'ArrowUp': to = addDays(f, -7); break
    case 'ArrowDown': to = addDays(f, 7); break
    case 'Home': to = addDays(f, -weekday(f)); break
    case 'End': to = addDays(f, 6 - weekday(f)); break
    case 'PageUp': to = shiftMonths(f, e.shiftKey ? -12 : -1); break
    case 'PageDown': to = shiftMonths(f, e.shiftKey ? 12 : 1); break
    default: return
  }
  e.preventDefault()
  moveFocus(to)
}

function choose(d: string) {
  if (disabled(d)) return
  focusDate.value = d
  const a = anchor.value
  if (a === null) {
    anchor.value = d
    hover.value = d
    emit('pick', { from: d, to: d })
    return
  }
  anchor.value = null
  hover.value = null
  if (d !== a) emit('pick', d < a ? { from: d, to: a } : { from: a, to: d })
  emit('done')
}

onMounted(focusCell)
// The owner changed the dates under us (typed text): follow them.
watch(() => [props.from, props.to], () => {
  if (anchor.value) return
  focusDate.value = startDate.value
  setView(Number(focusDate.value.slice(0, 4)), Number(focusDate.value.slice(5, 7)))
})
defineExpose({ focus: focusCell })
</script>

<template>
  <div ref="root" class="dc" data-testid="date-calendar">
    <div class="dc-head">
      <button type="button" class="dc-nav" aria-label="Previous month" data-testid="cal-prev" @click="prev">‹</button>
      <span class="dc-title" aria-live="polite" data-testid="cal-title">{{ title }}</span>
      <button type="button" class="dc-nav" aria-label="Next month" data-testid="cal-next" @click="next">›</button>
      <button type="button" class="dc-today" data-testid="cal-today" @click="goToday">Today</button>
    </div>
    <div class="dc-grid" role="grid" :aria-label="title" @keydown="onKey" @mouseleave="hover = anchor">
      <div class="dc-row" role="row">
        <span v-for="(d, i) in DOW" :key="d" class="dc-dow" role="columnheader" :aria-label="DOW_LONG[i]">{{ d }}</span>
      </div>
      <div v-for="(week, wi) in weeks" :key="wi" class="dc-row" role="row">
        <span v-for="d in week" :key="d" role="gridcell" :aria-selected="cellClass(d).sel" class="dc-cell">
          <button
            type="button"
            class="dc-day"
            :class="cellClass(d)"
            :data-date="d"
            :tabindex="d === tabStop ? 0 : -1"
            :disabled="disabled(d)"
            :aria-label="label(d)"
            :aria-current="d === today ? 'date' : undefined"
            @click="choose(d)"
            @mouseenter="anchor && (hover = d)"
          >{{ Number(d.slice(8, 10)) }}</button>
        </span>
      </div>
    </div>
    <p v-if="anchor" class="dc-tip" data-testid="cal-tip">Click another day to make a range, or the same day again to keep just this one.</p>
  </div>
</template>

<style scoped>
.dc {
  width: 308px;
  max-width: 100%;
  box-sizing: border-box;
  padding: 10px;
  background: rgb(var(--surface));
  color: rgb(var(--ink));
  font-size: 13px;
}
.dc-head {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
}
.dc-title {
  flex: 1;
  text-align: center;
  font-weight: 600;
}
.dc-nav,
.dc-today {
  min-height: 36px;
  min-width: 36px;
  padding: 0 8px;
  border: 1px solid rgb(var(--line-2));
  border-radius: 9px;
  background: rgb(var(--surface));
  color: rgb(var(--ink));
  font: inherit;
  cursor: pointer;
}
.dc-nav {
  font-size: 18px;
  line-height: 1;
}
.dc-grid {
  display: flex;
  flex-direction: column;
}
.dc-row {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
}
.dc-dow {
  padding: 4px 0;
  text-align: center;
  font-size: 11px;
  color: rgb(var(--ink-3));
}
.dc-cell {
  display: block;
}
.dc-day {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 36px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.dc-day.out {
  color: rgb(var(--ink-3));
  opacity: 0.6;
}
.dc-day.today {
  font-weight: 700;
  box-shadow: inset 0 -3px 0 rgb(var(--amber));
}
.dc-day.sel {
  background: rgb(var(--amber) / 0.22);
}
.dc-day.edge {
  background: rgb(var(--amber));
  color: #fff;
  opacity: 1;
}
.dc-day.start {
  border-radius: 9px 0 0 9px;
}
.dc-day.end {
  border-radius: 0 9px 9px 0;
}
.dc-day.start.end {
  border-radius: 9px;
}
.dc-day:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.dc-day:focus-visible,
.dc-nav:focus-visible,
.dc-today:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: -2px;
  position: relative;
}
.dc-tip {
  margin: 6px 0 0;
  font-size: 12px;
  color: rgb(var(--ink-3));
}
@media (max-width: 700px) {
  .dc {
    width: 100%;
    padding: 8px 6px;
  }
  .dc-day,
  .dc-nav,
  .dc-today {
    min-height: 44px; /* a touch target */
  }
  .dc-nav {
    min-width: 44px;
  }
}
</style>
