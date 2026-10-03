<script setup lang="ts">
// "Delete group…": says how many pages the group holds and asks where they go — "Mine" by default
// (the first other group when "Mine" is the one going), any other group on offer. ★ Overview never
// moves. A modal dialog: focus moves in (the destination picked), Tab stays inside, Esc or the
// scrim cancels, and focus goes back to `returnTo` on close.
import { computed, nextTick, ref, watch } from 'vue'
import type { DashboardPage, GroupMeta } from '../../types'
import { deleteGroupTargets, descendantsOf, orderedGroups, rootsInGroup } from '../../lib/nav'
import GroupBadge from './GroupBadge.vue'

const props = defineProps<{
  group: string | null
  pages: DashboardPage[]
  groupOrder?: string[]
  groupMeta?: Record<string, GroupMeta>
  returnTo?: HTMLElement | null
}>()
const emit = defineEmits<{ cancel: []; confirm: [group: string, dest: string | null] }>()

const panel = ref<HTMLElement | null>(null)
const dest = ref<string | null>(null)
const roots = computed(() => (props.group ? rootsInGroup(props.group, props.pages) : []))
const drills = computed(() => roots.value.reduce((n, r) => n + descendantsOf(r.id, props.pages).length, 0))
const targets = computed(() => (props.group ? deleteGroupTargets(props.group, orderedGroups(props.pages, props.groupOrder)) : { options: [], fallback: null }))
const blocked = computed(() => roots.value.length > 0 && !targets.value.options.length)
let returnFocus: HTMLElement | null = null

watch(
  () => props.group,
  async (g) => {
    if (g) {
      returnFocus = props.returnTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      dest.value = targets.value.fallback
      await nextTick()
      ;(panel.value?.querySelector<HTMLElement>('input:checked') ?? panel.value?.querySelector<HTMLElement>('button'))?.focus()
    } else {
      const el = returnFocus
      returnFocus = null
      await nextTick()
      // the group's ⋯ went with the group: back to the drawer's current row instead
      if (el?.isConnected) el.focus()
      else document.querySelector<HTMLElement>('#nav-drawer .dr-page[aria-current="page"], #nav-drawer .dr-close')?.focus()
    }
  },
  { immediate: true },
)

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('cancel')
  } else if (e.key === 'Tab') {
    const f = panel.value ? Array.from(panel.value.querySelectorAll<HTMLElement>('input:checked, button:not([disabled])')) : []
    if (!f.length) return
    const i = f.indexOf(document.activeElement as HTMLElement)
    if (e.shiftKey && i <= 0) {
      e.preventDefault()
      f[f.length - 1].focus()
    } else if (!e.shiftKey && i === f.length - 1) {
      e.preventDefault()
      f[0].focus()
    }
  }
}
const pagesText = computed(() => {
  const n = roots.value.length
  const d = drills.value
  return `${n} page${n === 1 ? '' : 's'}${d ? ` (and ${d} drill page${d === 1 ? '' : 's'})` : ''}`
})
</script>

<template>
  <Teleport to="body">
    <template v-if="group">
      <div class="dg-scrim" aria-hidden="true" @click="emit('cancel')"></div>
      <div ref="panel" class="dg-panel" role="dialog" aria-modal="true" aria-labelledby="dg-title" aria-describedby="dg-desc" @keydown="onKeydown">
        <h2 id="dg-title" class="dg-title">
          Delete group
          <GroupBadge :name="group" :meta="groupMeta?.[group]" />
          <span class="dg-name">{{ group }}</span>?
        </h2>
        <p v-if="!roots.length" id="dg-desc" class="dg-desc">It has no pages. Nothing else changes.</p>
        <template v-else>
          <p id="dg-desc" class="dg-desc">
            It holds <b>{{ pagesText }}</b>. They move to:
          </p>
          <div v-if="!blocked" class="dg-list" role="radiogroup" aria-label="Move its pages to">
            <label v-for="g in targets.options" :key="g" class="nav-row dg-opt">
              <input v-model="dest" type="radio" name="dg-dest" :value="g" class="visually-hidden" />
              <GroupBadge :name="g" :meta="groupMeta?.[g]" />
              <span class="nm">{{ g }}</span>
              <span class="dg-radio" :class="{ on: dest === g }" aria-hidden="true"></span>
            </label>
          </div>
          <p v-else class="dg-desc">There's no other group to move them to: make one first.</p>
        </template>
        <p class="dg-note">★ Overview stays pinned and doesn't move.</p>
        <div class="dg-actions">
          <button type="button" class="btn" @click="emit('cancel')">Cancel</button>
          <button type="button" class="btn dg-delete" :disabled="blocked || (roots.length > 0 && !dest)" @click="emit('confirm', group!, roots.length ? dest : null)">Delete group</button>
        </div>
      </div>
    </template>
  </Teleport>
</template>

<style scoped>
.dg-scrim {
  position: fixed;
  inset: 0;
  z-index: 1490;
  background: rgb(var(--scrim) / 0.4);
}
.dg-panel {
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
.dg-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 8px;
  font: 600 16px 'Space Grotesk', system-ui, sans-serif;
}
.dg-name {
  overflow-wrap: anywhere;
}
.dg-desc {
  margin: 0 0 8px;
  color: rgb(var(--ink-2));
}
.dg-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 220px;
  overflow-y: auto;
  margin-bottom: 8px;
}
.dg-opt {
  cursor: pointer;
}
.dg-opt:focus-within {
  background: rgb(var(--sunken));
  box-shadow: inset 0 0 0 2px rgb(var(--amber) / 0.55);
}
.dg-radio {
  width: 14px;
  height: 14px;
  flex: none;
  border: 1.5px solid rgb(var(--line-2));
  border-radius: 50%;
}
.dg-radio.on {
  border-color: rgb(var(--amber));
  background: radial-gradient(circle, rgb(var(--amber)) 0 3.5px, transparent 4px);
}
.dg-note {
  margin: 0 0 12px;
  font-size: 12px;
  color: rgb(var(--ink-3));
}
.dg-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.dg-delete {
  background: #bc4749;
  border-color: #bc4749;
  color: #fff;
}
.dg-delete:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
