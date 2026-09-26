<script setup lang="ts">
// type 'note' widget body — a static text tile carrying a caveat/definition that used to be
// fixed page copy on a bespoke page (e.g. the small-sample note, the Android/Play rollout
// caveat, "no outcome tracking yet"). Movable/removable like any other widget; editable via
// ChartEditor (pick a registry note, or type custom text — see lib/notes.ts). Renders
// through the SAME NoteBlock/TextBlock every inline caveat elsewhere in the app uses (owner
// requirement, 2026-09-26: "one reusable, configurable component, not bespoke code per page
// or widget"). `widget.noteId` (a registry id) takes priority over `widget.note` (custom
// text) when both are set; `widget.longText` picks TextBlock (longer/multi-paragraph prose)
// over NoteBlock (a single short caveat line).
import type { Widget } from '../../types'
import NoteBlock from '../NoteBlock.vue'
import TextBlock from '../TextBlock.vue'
defineProps<{ widget: Widget }>()
</script>

<template>
  <div class="note-body">
    <TextBlock v-if="widget.longText" :note-id="widget.noteId" :text="widget.noteId ? undefined : widget.note" />
    <NoteBlock v-else :note-id="widget.noteId" :text="widget.noteId ? undefined : widget.note || '(empty note)'" />
  </div>
</template>

<style scoped>
.note-body {
  height: 100%;
  display: flex;
  align-items: center;
  overflow-y: auto;
}
.note-body :deep(.text-block) {
  width: 100%;
}
</style>
