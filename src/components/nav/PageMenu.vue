<script setup lang="ts">
// The page ⋯ menu, opened from the header (the page on screen) or a row in the page drawer: Rename,
// Duplicate, Change icon…, Move to group (the groups in use, and "New group…"), Restore default
// charts, Delete (with the page's drill pages, asked once). ★ Overview can't be moved or deleted;
// a drill page follows its page's group, so it can't be moved on its own. Actions are emitted; the
// app performs them (and asks for names / confirmation).
import { computed, nextTick, ref, watch } from 'vue'
import type { DashboardPage, GroupMeta } from '../../types'
import { drillChildren, groupNames, parentOf } from '../../lib/nav'
import { CheckIcon, ChevronRightIcon, PlusIcon } from '../../lib/icons'
import NavPopover from './NavPopover.vue'
import GroupBadge from './GroupBadge.vue'

const props = defineProps<{
  open: boolean
  anchor: HTMLElement | null
  page: DashboardPage | null
  pages: DashboardPage[]
  groupMeta?: Record<string, GroupMeta>
  sheet?: boolean
}>()
const emit = defineEmits<{
  /** 'action': an item was chosen (focus goes back to what opened the menu, unless the action
   * opened a dialog of its own); 'dismiss': Esc, Tab or a click elsewhere. */
  close: [reason: 'action' | 'dismiss']
  rename: [id: string]
  duplicate: [id: string]
  'change-icon': [id: string]
  move: [id: string, group: string]
  'new-group': [id: string]
  restore: [id: string]
  delete: [id: string]
}>()

const moveOpen = ref(false)
watch(
  () => props.open,
  () => (moveOpen.value = false),
)
const isDrill = computed(() => !!props.page && !!parentOf(props.page, props.pages))
const canMove = computed(() => !!props.page && !props.page.isDefault && !isDrill.value)
const canDelete = computed(() => !!props.page && !props.page.isDefault && props.pages.length > 1)
const drillCount = computed(() => (props.page ? drillChildren(props.page.id, props.pages).length : 0))
const groups = computed(() => groupNames(props.pages))
const deleteLabel = computed(() => (drillCount.value ? `Delete (+${drillCount.value} drill page${drillCount.value === 1 ? '' : 's'})` : 'Delete'))

// The action runs first (so it still knows which button opened the menu), then the menu closes.
function act(fn: () => void) {
  fn()
  emit('close', 'action')
}
async function toggleMove() {
  moveOpen.value = !moveOpen.value
  if (moveOpen.value) {
    await nextTick()
    const list = document.getElementById('page-menu-groups')
    ;(list?.querySelector<HTMLElement>('[aria-checked="true"]') ?? list?.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus()
  }
}
</script>

<template>
  <NavPopover :open="open && !!page" :anchor="anchor" :label="page ? `Page options: ${page.name}` : 'Page options'" :sheet="sheet" :width="240" panel-id="page-menu" @close="emit('close', 'dismiss')">
    <template v-if="page">
      <div v-if="sheet" class="nav-head">{{ page.name }}</div>
      <button type="button" role="menuitem" class="nav-row" @click="act(() => emit('rename', page!.id))"><span class="nm">Rename</span></button>
      <button type="button" role="menuitem" class="nav-row" @click="act(() => emit('duplicate', page!.id))"><span class="nm">Duplicate</span></button>
      <button type="button" role="menuitem" class="nav-row" @click="act(() => emit('change-icon', page!.id))"><span class="nm">Change icon…</span></button>
      <template v-if="canMove">
        <button
          type="button"
          role="menuitem"
          class="nav-row"
          aria-haspopup="true"
          :aria-expanded="moveOpen"
          aria-controls="page-menu-groups"
          @click="toggleMove"
          @keydown.right.prevent="!moveOpen && toggleMove()"
        >
          <span class="nm">Move to group</span>
          <ChevronRightIcon class="sub" :class="{ open: moveOpen }" :size="15" aria-hidden="true" />
        </button>
        <div v-if="moveOpen" id="page-menu-groups" class="submenu" role="group" aria-label="Move to group">
          <button
            v-for="g in groups"
            :key="g"
            type="button"
            role="menuitemradio"
            class="nav-row"
            :aria-checked="g === page.group"
            @click="g !== page!.group && act(() => emit('move', page!.id, g))"
            @keydown.left.prevent="moveOpen = false"
          >
            <GroupBadge :name="g" :meta="groupMeta?.[g]" />
            <span class="nm">{{ g }}</span>
            <CheckIcon v-if="g === page.group" class="ck" :size="16" aria-hidden="true" />
          </button>
          <button type="button" role="menuitem" class="nav-row new" @click="act(() => emit('new-group', page!.id))" @keydown.left.prevent="moveOpen = false">
            <PlusIcon :size="16" aria-hidden="true" />
            <span class="nm">New group…</span>
          </button>
        </div>
      </template>
      <button type="button" role="menuitem" class="nav-row" @click="act(() => emit('restore', page!.id))"><span class="nm">Restore default charts</span></button>
      <template v-if="canDelete">
        <div class="nav-sep" role="separator"></div>
        <button type="button" role="menuitem" class="nav-row danger" @click="act(() => emit('delete', page!.id))"><span class="nm">{{ deleteLabel }}</span></button>
      </template>
    </template>
  </NavPopover>
</template>

<style scoped>
.sub {
  color: rgb(var(--ink-3));
  transition: transform 0.12s ease;
}
.sub.open {
  transform: rotate(90deg);
}
.submenu {
  margin: 2px 0 4px 10px;
  padding-left: 6px;
  border-left: 1px solid rgb(var(--line));
}
@media (prefers-reduced-motion: reduce) {
  .sub {
    transition: none;
  }
}
</style>
