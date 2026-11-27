<script setup lang="ts">
// A smart date field: type words ("last 30 days", "March", "Oct 1 to Nov 15", "11/3") and it picks the dates, or open
// the calendar button and pick one date or a range. Shared UI (ADR 0005/0007): no Budget knowledge in it; any screen can
// use it for a date or a date range. The phrase rules live in lib/smartDate.ts, the calendar in DateCalendar.vue.
// Props: from, to ('YYYY-MM-DD'; one day is from === to), today (tests only; default: the local date),
//        maxDays (longest range, both ends counted), min / max (earliest / latest date), label (accessible name),
//        testid (prefix of the data-testids: `<testid>-input`, `-calendar`, `-note`, `-hint`).
// Emits: `change` ({from, to}) with a range that passed the checks; the field never emits anything it cannot read.
// While typing, a line under the field shows what it understood ("Understood: Oct 1 – Nov 15, 2026"). Enter or leaving the
// field applies it. Text it cannot read (or a range outside min / max / maxDays) shows a short hint, restores the current
// dates and changes nothing. Escape closes the calendar, or drops the typed text. Exposes focus().
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import DateCalendar from './DateCalendar.vue'
import { daysBetween, formatDate, formatRange, localToday, parseSmartDate } from '../../lib/smartDate'

const props = withDefaults(defineProps<{
  from: string
  to: string
  today?: string
  maxDays?: number
  min?: string
  max?: string
  label?: string
  testid?: string
}>(), { label: 'Dates', testid: 'smart-date' })
const emit = defineEmits<{ change: [r: { from: string; to: string }] }>()

const uid = Math.random().toString(36).slice(2, 8)
const root = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const calBtn = ref<HTMLButtonElement | null>(null)
const draft = ref<string | null>(null) // the typed text; null when not editing
const hint = ref('')
const open = ref(false)

// The real clock is re-read on focus, apply and opening the calendar (a tab left open past midnight must not keep yesterday).
const clockTick = ref(0)
const todayStr = computed(() => {
  void clockTick.value
  return props.today ?? localToday()
})
/** The clock for the parser: noon on `today`, so only the calendar date matters. */
const clock = computed(() => {
  void clockTick.value
  if (!props.today) return new Date()
  const [y, m, d] = props.today.split('-').map(Number)
  return new Date(y, m - 1, d, 12, 0, 0)
})
const current = computed(() => (props.from && props.to ? formatRange(props.from, props.to) : ''))
const text = computed(() => draft.value ?? current.value)

/** Why a range cannot be used, or ''. */
function problem(from: string, to: string): string {
  if (props.maxDays && daysBetween(from, to) + 1 > props.maxDays) return `Pick a range of at most ${props.maxDays} days.`
  if ((props.min && from < props.min) || (props.max && to > props.max)) {
    const lo = props.min ? formatDate(props.min) : ''
    const hi = props.max ? formatDate(props.max) : ''
    return lo && hi ? `Pick dates from ${lo} to ${hi}.` : lo ? `Pick dates from ${lo} on.` : `Pick dates up to ${hi}.`
  }
  return ''
}

/** What the typed text means right now (null while there is nothing typed). */
const understood = computed(() => {
  const d = draft.value
  if (d === null || !d.trim()) return null
  const r = parseSmartDate(d, clock.value)
  if (!r.ok) return null
  return { label: r.label, problem: problem(r.from, r.to) }
})
const note = computed<{ kind: 'ok' | 'hint'; text: string } | null>(() => {
  if (hint.value) return { kind: 'hint', text: hint.value }
  const u = understood.value
  if (!u) return null
  return u.problem ? { kind: 'hint', text: u.problem } : { kind: 'ok', text: `Understood: ${u.label}` }
})

function onInput(e: Event) {
  draft.value = (e.target as HTMLInputElement).value
  hint.value = ''
}
function apply() {
  clockTick.value++
  const d = draft.value
  if (d === null) return
  draft.value = null
  if (!d.trim() || d.trim() === current.value) return // blank or unchanged: keep what we have
  const r = parseSmartDate(d, clock.value)
  if (!r.ok) {
    hint.value = r.hint
    return
  }
  const why = problem(r.from, r.to)
  if (why) {
    hint.value = why
    return
  }
  hint.value = ''
  if (r.from !== props.from || r.to !== props.to) emit('change', { from: r.from, to: r.to })
}
function onFocus(e: FocusEvent) {
  clockTick.value++
  hint.value = ''
  ;(e.target as HTMLInputElement).select()
}
function onEnter() {
  apply()
  input.value?.select()
}

function toggleCalendar() {
  if (open.value) {
    open.value = false
    return
  }
  apply()
  hint.value = ''
  open.value = true
}
function onPick(r: { from: string; to: string }) {
  hint.value = ''
  draft.value = null
  emit('change', r)
}
function onDone() {
  open.value = false
  calBtn.value?.focus()
}
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (open.value) {
    e.stopPropagation()
    onDone()
  } else if (draft.value !== null || hint.value) {
    e.stopPropagation()
    draft.value = null
    hint.value = ''
  }
}
function onDocPointer(e: Event) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
onMounted(() => document.addEventListener('pointerdown', onDocPointer, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointer, true))
// The dates changed from outside (a preset, the URL): drop any half-typed text.
watch(() => [props.from, props.to], () => { draft.value = null })

defineExpose({ focus: () => input.value?.focus() })
</script>

<template>
  <div ref="root" class="sdr" @keydown="onKeydown">
    <div class="sdr-field">
      <input
        ref="input"
        type="text"
        class="sdr-input"
        :value="text"
        :aria-label="label"
        :aria-describedby="`sdr-note-${uid}`"
        :aria-invalid="hint ? 'true' : undefined"
        placeholder="e.g. last 30 days, Oct 1 to Nov 15"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        :data-testid="`${testid}-input`"
        @input="onInput"
        @focus="onFocus"
        @blur="apply"
        @keydown.enter.prevent="onEnter"
      />
      <button
        ref="calBtn"
        type="button"
        class="sdr-cal"
        :aria-label="`${label}: open calendar`"
        aria-haspopup="dialog"
        :aria-expanded="open"
        :data-testid="`${testid}-calendar`"
        @click="toggleCalendar"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4.5" width="18" height="16.5" rx="2.5" />
          <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
        </svg>
      </button>
    </div>
    <p :id="`sdr-note-${uid}`" class="sdr-note" :class="{ hint: note?.kind === 'hint', none: !note }" aria-live="polite" :data-testid="note ? `${testid}-${note.kind === 'hint' ? 'hint' : 'note'}` : undefined">{{ note?.text ?? '' }}</p>
    <div v-if="open" class="sdr-pop" role="dialog" aria-label="Choose dates" :data-testid="`${testid}-popover`">
      <DateCalendar :from="from" :to="to" :today="todayStr" :min="min" :max="max" :max-days="maxDays" @pick="onPick" @done="onDone" />
    </div>
  </div>
</template>

<style scoped>
.sdr {
  position: relative;
  min-width: 0;
}
.sdr-field {
  display: flex;
  align-items: stretch;
}
.sdr-input {
  box-sizing: border-box;
  width: 17em;
  max-width: 100%;
  min-width: 0;
  min-height: 36px;
  padding: 4px 8px;
  border: 1px solid rgb(var(--line-2));
  border-right: 0;
  border-radius: 9px 0 0 9px;
  background: rgb(var(--surface));
  color: rgb(var(--ink));
  font: inherit;
  font-size: 13px;
}
.sdr-cal {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 36px;
  min-height: 36px;
  padding: 0;
  border: 1px solid rgb(var(--line-2));
  border-radius: 0 9px 9px 0;
  background: rgb(var(--surface));
  color: rgb(var(--ink));
  cursor: pointer;
}
.sdr-input:focus-visible,
.sdr-cal:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: 1px;
}
.sdr-note {
  margin: 4px 0 0;
  font-size: 12px;
  color: rgb(var(--ink-3));
  overflow-wrap: anywhere;
}
.sdr-note.none {
  height: 0;
  margin: 0;
  overflow: hidden;
}
@media (min-width: 701px) {
  /* On a wide screen the note floats under the field, so a long hint never moves the controls beside it. */
  .sdr-note:not(.none) {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 29;
    width: max-content;
    max-width: min(28em, 90vw);
    margin: 2px 0 0;
    padding: 2px 6px;
    border-radius: 6px;
    background: rgb(var(--surface));
    box-shadow: 0 2px 8px rgb(0 0 0 / 0.12);
  }
}
.sdr-note.hint {
  color: #b3261e;
}
.sdr-pop {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 30;
  border: 1px solid rgb(var(--line-2));
  border-radius: 12px;
  overflow: hidden;
  background: rgb(var(--surface));
  box-shadow: 0 8px 28px rgb(0 0 0 / 0.2);
}
@media (max-width: 700px) {
  .sdr {
    width: 100%;
  }
  .sdr-field {
    width: 100%;
  }
  .sdr-input {
    flex: 1 1 auto;
    width: auto;
    min-height: 44px;
    font-size: 16px; /* no zoom-in on focus in iOS */
  }
  .sdr-cal {
    min-width: 44px;
    min-height: 44px;
  }
  .sdr-pop {
    left: 0;
    right: 0;
  }
}
</style>
