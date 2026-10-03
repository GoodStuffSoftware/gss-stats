<script setup lang="ts">
// "+ New": a reusable create-something control. Clicking "+ New" slides its label left and opens a
// drop-down of what can be created (a registry of WizardDefs, lib/wizards.ts); picking one runs its
// steps as a horizontal carousel — each step slides in from the right, Back and Forward sit below
// the step area, and on the last step Forward becomes Create. Forward and Create wait until
// `stepError` says the step is complete (the step content shows why not). Esc or × closes it and
// starts over; focus moves to each step's first field (or its [data-autofocus] element) and back
// to "+ New" at the end. With prefers-reduced-motion nothing slides: the steps swap instantly.
// The step content comes from the `step` slot ({ wizard, step, index }).
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { WizardDef } from '../../lib/wizards'
import { BackIcon, CloseIcon, ForwardIcon, PlusIcon } from '../../lib/icons'

const props = withDefaults(
  defineProps<{
    wizards: readonly WizardDef[]
    /** Why step `stepId` of wizard `wizardId` isn't complete yet, or null. */
    stepError: (wizardId: string, stepId: string) => string | null
    /** The "+ New" button's text. */
    label?: string
    idPrefix?: string
  }>(),
  { label: 'New', idPrefix: 'wz' },
)
const emit = defineEmits<{
  /** A wizard starts (set up its draft). */
  start: [wizardId: string]
  create: [wizardId: string]
  cancel: []
}>()

type Phase = 'idle' | 'choose' | 'run'
const phase = ref<Phase>('idle')
const wizard = ref<WizardDef | null>(null)
const index = ref(0)
const root = ref<HTMLElement | null>(null)
const newBtn = ref<HTMLElement | null>(null)
const bar = ref<HTMLElement | null>(null)
const label = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const viewport = ref<HTMLElement | null>(null)
const stepEls = ref<HTMLElement[]>([])
const height = ref<number | null>(null)

const steps = computed(() => wizard.value?.steps ?? [])
const step = computed(() => steps.value[index.value])
const isLast = computed(() => index.value === steps.value.length - 1)
const error = computed(() => (wizard.value && step.value ? props.stepError(wizard.value.id, step.value.id) : null))
const menuId = computed(() => `${props.idPrefix}-types`)
const liveText = computed(() => (wizard.value && step.value ? `New ${wizard.value.label.toLowerCase()}, step ${index.value + 1} of ${steps.value.length}: ${step.value.title}` : ''))

// "+ New" sits centred in its bar while closed and slides to the left edge when opened (a
// transform, so it can animate): the offset is measured, not guessed.
const centreShift = ref(0)
function measure() {
  const b = bar.value
  const l = label.value
  if (!b || !l) return
  centreShift.value = Math.max(0, (b.clientWidth - l.offsetWidth) / 2 - 10)
}
let barObserver: ResizeObserver | undefined
let stepObserver: ResizeObserver | undefined
onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && bar.value) {
    barObserver = new ResizeObserver(measure)
    barObserver.observe(bar.value)
  }
})
onBeforeUnmount(() => {
  barObserver?.disconnect()
  stepObserver?.disconnect()
})

// The step area is as tall as the step on screen (it animates between steps).
function fitHeight() {
  const el = stepEls.value[index.value]
  height.value = el ? el.scrollHeight : null
}
function watchStepSize() {
  stepObserver?.disconnect()
  const el = stepEls.value[index.value]
  if (!el || typeof ResizeObserver === 'undefined') return
  stepObserver = new ResizeObserver(fitHeight)
  stepObserver.observe(el)
}

const FOCUSABLE = 'input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'
async function focusStep() {
  await nextTick()
  fitHeight()
  watchStepSize()
  const el = stepEls.value[index.value]
  const target = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE)
  // preventScroll: the step is still sliding in; letting the browser scroll it into view would
  // shift the carousel's own scroll position.
  target?.focus({ preventScroll: true })
}
async function focusMenu(id?: string) {
  await nextTick()
  const items = Array.from(menu.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
  ;(items.find((b) => b.dataset.wizard === id) ?? items[0])?.focus()
}

function toggleChoose() {
  if (phase.value === 'choose') return reset()
  phase.value = 'choose'
  focusMenu(wizard.value?.id)
}
/** Start a wizard straight away (e.g. "New page in this group"), or show the menu. */
function start(id?: string) {
  const w = id ? props.wizards.find((x) => x.id === id) : undefined
  if (!w) {
    phase.value = 'choose'
    focusMenu()
    return
  }
  wizard.value = w
  index.value = 0
  phase.value = 'run'
  emit('start', w.id)
  focusStep()
}
function back() {
  if (index.value > 0) {
    index.value--
    focusStep()
  } else {
    phase.value = 'choose'
    focusMenu(wizard.value?.id)
  }
}
function forward() {
  if (error.value || isLast.value) return
  index.value++
  focusStep()
}
function create() {
  const w = wizard.value
  if (!w) return
  // every step must be complete (a change on an earlier step can undo one): go to the first that isn't
  const bad = w.steps.findIndex((s) => props.stepError(w.id, s.id))
  if (bad >= 0) {
    index.value = bad
    focusStep()
    return
  }
  emit('create', w.id)
  reset(false, false)
}
/** Close and start over; focus goes back to "+ New" (unless `refocus` is false: Create hands focus
 * to what it made). */
function reset(refocus = true, cancelled = true) {
  const was = phase.value
  phase.value = 'idle'
  wizard.value = null
  index.value = 0
  height.value = null
  stepObserver?.disconnect()
  if (was === 'run' && cancelled) emit('cancel')
  if (refocus) nextTick(() => newBtn.value?.focus())
}
function cancel() {
  reset()
}

function onMenuKeydown(e: KeyboardEvent) {
  const items = Array.from(menu.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
  const i = items.indexOf(document.activeElement as HTMLElement)
  const n = items.length
  if (!n) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    items[e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n].focus()
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault()
    items[e.key === 'Home' ? 0 : n - 1].focus()
  }
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && phase.value !== 'idle') {
    e.preventDefault()
    e.stopPropagation() // only the wizard closes, not the drawer around it
    reset()
  } else if (e.key === 'Enter' && phase.value === 'run') {
    const t = e.target as HTMLElement
    if (t instanceof HTMLInputElement && (t.type === 'text' || t.type === 'search')) {
      e.preventDefault()
      if (isLast.value) create()
      else forward()
    }
  }
}
watch(
  () => props.wizards,
  () => measure(),
)
defineExpose({ start, reset })
</script>

<template>
  <div ref="root" class="wz" :class="[`wz-${phase}`]" @keydown="onKeydown">
    <div ref="bar" class="wz-bar">
      <button
        ref="newBtn"
        type="button"
        class="wz-new"
        :aria-expanded="phase === 'choose'"
        aria-haspopup="menu"
        :aria-controls="phase === 'choose' ? menuId : undefined"
        @click="toggleChoose"
      >
        <span ref="label" class="wz-new-lbl" :style="{ '--shift': centreShift + 'px' }">
          <PlusIcon :size="16" aria-hidden="true" />
          <span>{{ props.label }}</span>
        </span>
      </button>
      <span v-if="phase === 'run' && wizard" class="wz-kind">
        <span class="wz-sep" aria-hidden="true">›</span>
        <component :is="wizard.icon" :size="15" aria-hidden="true" />
        <span>{{ wizard.label }}</span>
      </span>
      <span v-else-if="phase === 'choose'" class="wz-kind wz-ask">What?</span>
      <button v-if="phase !== 'idle'" type="button" class="wz-x" :aria-label="phase === 'run' && wizard ? `Cancel new ${wizard.label.toLowerCase()}` : 'Close'" @click="cancel">
        <CloseIcon :size="15" aria-hidden="true" />
      </button>
    </div>

    <div v-if="phase === 'choose'" :id="menuId" ref="menu" class="wz-menu" role="menu" aria-label="Create" @keydown="onMenuKeydown">
      <button v-for="w in wizards" :key="w.id" type="button" role="menuitem" class="nav-row wz-type" :data-wizard="w.id" @click="start(w.id)">
        <component :is="w.icon" :size="17" aria-hidden="true" />
        <span class="nm">
          <b>{{ w.label }}</b>
          <small>{{ w.description }}</small>
        </span>
      </button>
    </div>

    <section v-if="phase === 'run' && wizard" class="wz-run" :aria-label="`New ${wizard.label.toLowerCase()}`">
      <div class="wz-head">
        <ol class="wz-dots" aria-hidden="true">
          <li v-for="(s, i) in steps" :key="s.id" :class="{ on: i === index, done: i < index }"></li>
        </ol>
        <span class="wz-step-title">{{ index + 1 }}/{{ steps.length }} · {{ step?.title }}</span>
        <span class="visually-hidden" aria-live="polite">{{ liveText }}</span>
      </div>
      <div ref="viewport" class="wz-viewport" :style="height ? { height: height + 'px' } : undefined">
        <div class="wz-track" :style="{ transform: `translateX(${-index * 100}%)` }">
          <div
            v-for="(s, i) in steps"
            :key="s.id"
            ref="stepEls"
            class="wz-step"
            :class="{ current: i === index }"
            :data-step="s.id"
            :inert="i !== index || undefined"
            :aria-hidden="i !== index || undefined"
          >
            <slot name="step" :wizard="wizard" :step="s" :index="i" />
          </div>
        </div>
      </div>
      <div class="wz-nav">
        <button type="button" class="btn wz-back" @click="back">
          <BackIcon :size="15" aria-hidden="true" />
          <span>Back</span>
        </button>
        <button v-if="!isLast" type="button" class="btn btn-primary wz-fwd" :disabled="!!error" :title="error ?? undefined" @click="forward">
          <span>Next</span>
          <ForwardIcon :size="15" aria-hidden="true" />
        </button>
        <button v-else type="button" class="btn btn-primary wz-create" :disabled="!!error" :title="error ?? undefined" @click="create">
          <span>Create</span>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.wz {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.wz-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
}
.wz-new {
  flex: 1;
  display: flex;
  align-items: center;
  min-width: 0;
  padding: 6px 9px;
  border: 1px dashed rgb(var(--line-2));
  border-radius: 8px;
  background: transparent;
  color: rgb(var(--ink-2));
  font: 500 13px Inter, system-ui, sans-serif;
  cursor: pointer;
  transition:
    border-color 0.18s ease,
    background 0.18s ease,
    flex-grow 0.22s ease;
}
.wz-new:hover {
  background: rgb(var(--sunken));
  color: rgb(var(--ink));
}
.wz-new:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px rgb(var(--amber) / 0.55);
}
.wz-new-lbl {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transform: translateX(var(--shift, 0));
  transition: transform 0.22s ease;
}
/* Open: the label slides left and the button shrinks to it; what to create shows beside it. */
.wz-choose .wz-new,
.wz-run .wz-new {
  flex: 0 0 auto;
  border-style: solid;
  border-color: transparent;
  background: rgb(var(--amber-tint));
  color: rgb(var(--ink));
}
.wz-choose .wz-new-lbl,
.wz-run .wz-new-lbl {
  transform: translateX(0);
}
.wz-kind {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
  font: 600 13px Inter, system-ui, sans-serif;
  color: rgb(var(--ink));
  animation: wz-in 0.22s ease;
}
.wz-ask {
  font-weight: 500;
  color: rgb(var(--ink-3));
}
.wz-sep {
  color: rgb(var(--ink-3));
}
.wz-x {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  flex: none;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: rgb(var(--ink-3));
}
.wz-x:hover {
  background: rgb(var(--line));
  color: rgb(var(--ink));
}
.wz-x:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: -2px;
}
/* The type drop-down: the breadcrumb menus' panel (NavPopover), in the flow of the drawer. */
.wz-menu {
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line-2));
  border-radius: 11px;
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.16);
  padding: 5px;
  font-size: 13px;
  animation: wz-drop 0.18s ease;
}
.wz-type .nm {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}
.wz-type small {
  color: rgb(var(--ink-3));
  font-size: 11.5px;
  white-space: normal;
}
.wz-run {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  border: 1px solid rgb(var(--line-2));
  border-radius: 11px;
  background: rgb(var(--surface));
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.12);
  animation: wz-drop 0.18s ease;
}
.wz-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wz-dots {
  display: flex;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.wz-dots li {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgb(var(--line-2));
  transition: background 0.18s ease, width 0.18s ease;
}
.wz-dots li.done {
  background: rgb(var(--amber) / 0.55);
}
.wz-dots li.on {
  width: 16px;
  border-radius: 4px;
  background: rgb(var(--amber));
}
.wz-step-title {
  font: 600 10.5px Inter, system-ui, sans-serif;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: rgb(var(--ink-3));
}
.wz-viewport {
  overflow: hidden;
  max-height: min(52vh, 440px);
  transition: height 0.22s ease;
}
.wz-track {
  display: flex;
  align-items: flex-start;
  transition: transform 0.26s cubic-bezier(0.2, 0.7, 0.2, 1);
}
.wz-step {
  flex: 0 0 100%;
  min-width: 0;
  max-height: min(52vh, 440px);
  overflow-y: auto;
  padding: 2px;
  box-sizing: border-box;
}
.wz-step:not(.current) {
  visibility: hidden;
  transition: visibility 0s linear 0.26s;
}
.wz-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.wz-nav .btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 11px;
}
.wz-nav .btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
@keyframes wz-in {
  from {
    opacity: 0;
    transform: translateX(10px);
  }
}
@keyframes wz-drop {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .wz-new,
  .wz-new-lbl,
  .wz-track,
  .wz-viewport,
  .wz-dots li {
    transition: none;
  }
  .wz-step:not(.current) {
    transition: none;
  }
  .wz-kind,
  .wz-menu,
  .wz-run {
    animation: none;
  }
}
</style>
