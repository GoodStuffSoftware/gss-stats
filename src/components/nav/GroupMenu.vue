<script setup lang="ts">
// A group's ⋯ menu in the page drawer: Rename (in place), New page in this group (the "+ New" page
// wizard with this group picked), Delete group… (asks where its pages go). Actions are emitted; the
// drawer and the app perform them.
import NavPopover from './NavPopover.vue'

const props = defineProps<{ open: boolean; anchor: HTMLElement | null; group: string | null; pageCount: number; sheet?: boolean }>()
const emit = defineEmits<{ close: [reason: 'action' | 'dismiss']; rename: [group: string]; 'new-page': [group: string]; delete: [group: string] }>()

function act(fn: () => void) {
  fn()
  emit('close', 'action')
}
</script>

<template>
  <NavPopover
    :open="open && !!group"
    :anchor="anchor"
    :label="group ? `Group options: ${group}` : 'Group options'"
    :sheet="sheet"
    :width="230"
    :teleport-to="open && anchor ? '#nav-drawer' : 'body'"
    panel-id="group-menu"
    @close="emit('close', 'dismiss')"
  >
    <template v-if="group">
      <div v-if="sheet" class="nav-head">{{ group }}</div>
      <button type="button" role="menuitem" class="nav-row" @click="act(() => emit('rename', props.group!))"><span class="nm">Rename</span></button>
      <button type="button" role="menuitem" class="nav-row" @click="act(() => emit('new-page', props.group!))"><span class="nm">New page in this group</span></button>
      <div class="nav-sep" role="separator"></div>
      <button type="button" role="menuitem" class="nav-row danger" @click="act(() => emit('delete', props.group!))">
        <span class="nm">Delete group…</span>
        <span class="meta">{{ pageCount }} page{{ pageCount === 1 ? '' : 's' }}</span>
      </button>
    </template>
  </NavPopover>
</template>
