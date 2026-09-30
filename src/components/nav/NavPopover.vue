<script setup lang="ts">
// A menu that opens from a trigger: the breadcrumb's sibling lists and the page ⋯ menu. On a wide
// screen it drops down under its trigger; on a phone (`sheet`) it rises as a bottom sheet over a
// scrim. Either way: focus moves into it (the current item, else the first), ↑/↓/Home/End move
// between its items, Esc or Tab closes it and puts focus back on the trigger, and a click outside
// closes it. Teleported to <body> (or `teleportTo`: a menu opened from inside a modal dialog — the
// page drawer — goes into that dialog, so assistive tech doesn't treat it as outside the modal)
// so no scroll container clips it.
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    anchor: HTMLElement | null
    label: string
    sheet?: boolean
    width?: number
    panelId?: string
    teleportTo?: string
  }>(),
  { sheet: false, width: 260, panelId: undefined, teleportTo: 'body' },
)
const emit = defineEmits<{ close: [reason: 'escape' | 'outside' | 'tab' | 'viewport'] }>()

const panel = ref<HTMLElement | null>(null)
const pos = ref({ top: 0, left: 0, width: 260, maxHeight: 400 })

function place() {
  if (props.sheet || !props.anchor) return
  const r = props.anchor.getBoundingClientRect()
  const width = Math.min(props.width, window.innerWidth - 16)
  const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
  const top = r.bottom + 6
  pos.value = { top, left, width, maxHeight: Math.max(180, window.innerHeight - top - 12) }
}

const ITEM = '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled])'
function items(): HTMLElement[] {
  return panel.value ? Array.from(panel.value.querySelectorAll<HTMLElement>(ITEM)) : []
}
function focusInitial() {
  const list = items()
  const current = list.find((el) => el.getAttribute('aria-current') === 'page' || el.getAttribute('aria-checked') === 'true')
  ;(current ?? list[0])?.focus()
}
watch(
  () => props.open,
  async (open) => {
    if (!open) return
    place()
    await nextTick()
    focusInitial()
  },
  { immediate: true },
)

function closeTo(reason: 'escape' | 'tab') {
  emit('close', reason)
  props.anchor?.focus()
}
function onKeydown(e: KeyboardEvent) {
  const list = items()
  const n = list.length
  const i = list.indexOf(document.activeElement as HTMLElement)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (!n) return
    const next = e.key === 'ArrowDown' ? (i < 0 ? 0 : (i + 1) % n) : i < 0 ? n - 1 : (i - 1 + n) % n
    list[next].focus()
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault()
    list[e.key === 'Home' ? 0 : n - 1]?.focus()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation() // only this menu closes, not the drawer or dialog it opened from
    closeTo('escape')
  } else if (e.key === 'Tab') {
    e.preventDefault()
    e.stopPropagation()
    closeTo('tab')
  }
}
function onDocPointer(e: Event) {
  if (!props.open) return
  const t = e.target as Node
  if (panel.value?.contains(t) || props.anchor?.contains(t)) return
  emit('close', 'outside')
}
function onViewport() {
  // The drop-down is placed against its trigger; if the page scrolls or resizes under it, close it
  // rather than leave it floating away from what opened it. (The phone sheet doesn't move.)
  if (props.open && !props.sheet) emit('close', 'viewport')
}
onMounted(() => {
  document.addEventListener('pointerdown', onDocPointer, true)
  window.addEventListener('resize', onViewport)
  window.addEventListener('scroll', onViewport)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer, true)
  window.removeEventListener('resize', onViewport)
  window.removeEventListener('scroll', onViewport)
})
</script>

<template>
  <Teleport :to="teleportTo">
    <template v-if="open">
      <div v-if="sheet" class="np-scrim" aria-hidden="true" @click="emit('close', 'outside')"></div>
      <div
        :id="panelId"
        ref="panel"
        class="np-panel"
        :class="{ sheet }"
        role="menu"
        :aria-label="label"
        :style="sheet ? undefined : { top: pos.top + 'px', left: pos.left + 'px', width: pos.width + 'px', maxHeight: pos.maxHeight + 'px' }"
        @keydown="onKeydown"
      >
        <div v-if="sheet" class="np-handle" aria-hidden="true"></div>
        <slot />
      </div>
    </template>
  </Teleport>
</template>

<style scoped>
.np-panel {
  position: fixed;
  z-index: 1400;
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line-2));
  border-radius: 11px;
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.16);
  padding: 5px;
  overflow-y: auto;
  font-size: 13px;
  color: rgb(var(--ink));
}
.np-panel.sheet {
  left: 0;
  right: 0;
  bottom: 0;
  top: auto;
  max-height: 75vh;
  border-radius: 18px 18px 0 0;
  border-width: 1px 0 0;
  padding: 8px 10px calc(14px + env(safe-area-inset-bottom));
  box-shadow: 0 -10px 30px rgb(0 0 0 / 0.22);
}
.np-handle {
  width: 40px;
  height: 4px;
  border-radius: 2px;
  background: rgb(var(--line-2));
  margin: 0 auto 8px;
}
.np-scrim {
  position: fixed;
  inset: 0;
  z-index: 1390;
  background: rgb(var(--scrim) / 0.4);
}
</style>
