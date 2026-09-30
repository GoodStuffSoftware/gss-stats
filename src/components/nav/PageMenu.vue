<script setup lang="ts">
// The page ⋯ menu, opened from the header (the page on screen) or a row in the page drawer (a drill
// page's too): Rename (in place), Duplicate, Change icon…, Move to group (every group, and "New
// group…" named right there), Restore default charts, Delete (with every drill page under it, asked
// once). ★ Overview can't be moved or deleted. Moving a drill page makes it a page of its own in the
// group picked (its own drill pages come with it). Actions are emitted; the app performs them.
import { computed, nextTick, ref, watch } from 'vue'
import type { DashboardPage, GroupMeta } from '../../types'
import { GROUP_NAME_MAX, cleanGroupName } from '../../lib/defaults'
import { descendantsOf, groupNameError, orderedGroups, parentOf } from '../../lib/nav'
import { CheckIcon, ChevronRightIcon, PlusIcon } from '../../lib/icons'
import NavPopover from './NavPopover.vue'
import GroupBadge from './GroupBadge.vue'
import InlineName from './InlineName.vue'

const props = defineProps<{
  open: boolean
  anchor: HTMLElement | null
  page: DashboardPage | null
  pages: DashboardPage[]
  groupMeta?: Record<string, GroupMeta>
  groupOrder?: string[]
  sheet?: boolean
}>()
const emit = defineEmits<{
  /** 'action': an item was chosen (focus goes back to what opened the menu, unless the action
   * opened a dialog or a rename field of its own); 'dismiss': Esc, Tab or a click elsewhere. */
  close: [reason: 'action' | 'dismiss']
  rename: [id: string]
  duplicate: [id: string]
  'change-icon': [id: string]
  /** Move to an existing group, or to a new one named in the menu. */
  move: [id: string, group: string]
  restore: [id: string]
  delete: [id: string]
}>()

const moveOpen = ref(false)
const naming = ref(false)
watch(
  () => props.open,
  () => {
    moveOpen.value = false
    naming.value = false
  },
)
const isDrill = computed(() => !!props.page && !!parentOf(props.page, props.pages))
const canMove = computed(() => !!props.page && !props.page.isDefault)
const canDelete = computed(() => !!props.page && !props.page.isDefault && props.pages.length > 1)
const drillCount = computed(() => (props.page ? descendantsOf(props.page.id, props.pages).length : 0))
const groups = computed(() => orderedGroups(props.pages, props.groupOrder))
/** The group the page is filed under as a page of its own (a drill page is in none: any group moves it). */
const current = (g: string) => !isDrill.value && g === props.page?.group
// Opened from a row of the page drawer (a modal dialog): the menu goes inside the drawer.
const teleportTo = computed(() => (props.anchor?.closest('#nav-drawer') ? '#nav-drawer' : 'body'))
const deleteLabel = computed(() => (drillCount.value ? `Delete (+${drillCount.value} drill page${drillCount.value === 1 ? '' : 's'})` : 'Delete'))
const newGroupCheck = (name: string) => groupNameError(name, groups.value)

// The action runs first (so it still knows which button opened the menu), then the menu closes.
function act(fn: () => void) {
  fn()
  emit('close', 'action')
}
async function toggleMove() {
  moveOpen.value = !moveOpen.value
  naming.value = false
  if (moveOpen.value) {
    await nextTick()
    const list = document.getElementById('page-menu-groups')
    ;(list?.querySelector<HTMLElement>('[aria-checked="true"]') ?? list?.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus()
  }
}
async function stopNaming() {
  naming.value = false
  await nextTick()
  document.querySelector<HTMLElement>('#page-menu-groups .new')?.focus()
}
function moveToNew(name: string) {
  act(() => emit('move', props.page!.id, cleanGroupName(name)))
}
</script>

<template>
  <NavPopover :open="open && !!page" :anchor="anchor" :label="page ? `Page options: ${page.name}` : 'Page options'" :sheet="sheet" :width="250" :teleport-to="teleportTo" panel-id="page-menu" @close="emit('close', 'dismiss')">
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
            :aria-checked="current(g)"
            @click="!current(g) && act(() => emit('move', page!.id, g))"
            @keydown.left.prevent="moveOpen = false"
          >
            <GroupBadge :name="g" :meta="groupMeta?.[g]" />
            <span class="nm">{{ g }}</span>
            <CheckIcon v-if="current(g)" class="ck" :size="16" aria-hidden="true" />
          </button>
          <div v-if="naming" class="nav-row new-name">
            <PlusIcon :size="16" aria-hidden="true" />
            <InlineName value="" label="New group's name" placeholder="New group's name" :maxlength="GROUP_NAME_MAX" :clean="cleanGroupName" :validate="newGroupCheck" @save="moveToNew" @cancel="stopNaming" />
          </div>
          <button v-else type="button" role="menuitem" class="nav-row new" @click="naming = true" @keydown.left.prevent="moveOpen = false">
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
.new-name {
  cursor: default;
  overflow: visible;
}
.new-name:hover {
  background: transparent;
}
@media (prefers-reduced-motion: reduce) {
  .sub {
    transition: none;
  }
}
</style>
