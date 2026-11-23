<script setup lang="ts">
// The shared modal shell (ADR 0005: one pattern, no one-off dialogs): a scrim plus a `role="dialog"
// aria-modal` panel. Focus moves in on open (`initialFocus`, else the first control), Tab stays inside,
// Esc or the scrim emits `close`, and focus goes back to `returnTo` (or the element that was focused) on
// close; when that element is gone, `returnLost` fires so the owner can pick another. `wide` is the
// centred 1100px panel; `sheet` turns it into a bottom sheet under 600px and locks body scroll.
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    titleId?: string
    describedBy?: string
    wide?: boolean
    sheet?: boolean
    returnTo?: HTMLElement | null
    /** CSS selector inside the panel for the first focus. */
    initialFocus?: string
  }>(),
  { titleId: 'mp-title' },
)
const emit = defineEmits<{ close: []; returnLost: [] }>()

const panel = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null
let lockedBody = false

const FOCUSABLE = 'input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
function focusables(): HTMLElement[] {
  return panel.value ? Array.from(panel.value.querySelectorAll<HTMLElement>(FOCUSABLE)) : []
}

function unlock() {
  if (lockedBody) {
    document.body.style.overflow = ''
    lockedBody = false
  }
}

watch(
  () => props.open,
  async (o) => {
    if (o) {
      returnFocus = props.returnTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      if (props.sheet) {
        document.body.style.overflow = 'hidden'
        lockedBody = true
      }
      await nextTick()
      ;((props.initialFocus ? panel.value?.querySelector<HTMLElement>(props.initialFocus) : null) ?? focusables()[0])?.focus()
    } else {
      unlock()
      const el = returnFocus
      returnFocus = null
      await nextTick()
      if (el?.isConnected) el.focus()
      else emit('returnLost')
    }
  },
  { immediate: true },
)
onBeforeUnmount(unlock)

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('close')
  } else if (e.key === 'Tab') {
    const f = focusables()
    if (!f.length) return
    const i = f.indexOf(document.activeElement as HTMLElement)
    if (e.shiftKey && i <= 0) {
      e.preventDefault()
      f[f.length - 1].focus()
    } else if (!e.shiftKey && (i === f.length - 1 || i < 0)) {
      e.preventDefault()
      f[0].focus()
    }
  }
}
</script>

<template>
  <Teleport to="body">
    <template v-if="open">
      <div class="mp-scrim" aria-hidden="true" @click="emit('close')"></div>
      <div
        ref="panel"
        class="mp-panel"
        :class="{ 'mp-wide': wide, 'mp-sheet': sheet }"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-describedby="describedBy"
        @keydown="onKeydown"
      >
        <h2 :id="titleId" class="mp-title"><slot name="title">{{ title }}</slot></h2>
        <slot />
        <div v-if="$slots.actions" class="mp-actions"><slot name="actions" /></div>
      </div>
    </template>
  </Teleport>
</template>

<style scoped>
.mp-scrim {
  position: fixed;
  inset: 0;
  z-index: 1490;
  background: rgb(var(--scrim) / 0.4);
}
.mp-panel {
  position: fixed;
  z-index: 1500;
  top: 50%;
  left: 50%;
  translate: -50% -50%;
  width: min(380px, calc(100vw - 24px));
  max-height: calc(100vh - 40px);
  overflow-y: auto;
  box-sizing: border-box;
  padding: 16px;
  border: 1px solid rgb(var(--line-2));
  border-radius: 14px;
  background: rgb(var(--surface));
  box-shadow: 0 16px 40px rgb(0 0 0 / 0.24);
  color: rgb(var(--ink));
  font-size: 13px;
}
.mp-panel.mp-wide {
  width: min(1100px, 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}
.mp-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 8px;
  font: 600 16px 'Space Grotesk', system-ui, sans-serif;
}
.mp-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
@media (max-width: 599px) {
  .mp-panel.mp-sheet {
    top: auto;
    left: 0;
    bottom: 0;
    translate: none;
    width: 100%;
    max-height: 85vh;
    border-radius: 14px 14px 0 0;
    border-bottom: 0;
    padding-bottom: 0;
  }
  .mp-sheet .mp-actions {
    position: sticky;
    bottom: 0;
    margin: 0 -16px;
    padding: 10px 16px calc(10px + env(safe-area-inset-bottom));
    background: rgb(var(--surface));
    border-top: 1px solid rgb(var(--line-2));
  }
}
</style>
