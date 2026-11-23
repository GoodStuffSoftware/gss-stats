<script setup lang="ts">
// A generic breadcrumb trail: every item but the last is a button that goes back to it; the last is where you
// are. It knows nothing about what the items are.
//
// Props
//   items: { key: string; label: string }[]   first = the top; last = the current place
//   label: string ('Breadcrumb')              accessible name of the <nav>
//   wrap: boolean (false)                      let a long trail wrap onto more lines (a page trail); off, it stays one line and the earlier items shorten
// Emits
//   go(index: number)                          an earlier item was picked (its index in `items`)
withDefaults(defineProps<{ items: Array<{ key: string; label: string }>; label?: string; wrap?: boolean }>(), { label: 'Breadcrumb', wrap: false })
const emit = defineEmits<{ go: [index: number] }>()
</script>

<template>
  <nav class="crumbs" :class="{ 'cr-wrap': wrap }" :aria-label="label" data-testid="crumbs">
    <ol class="cr-list">
      <li v-for="(it, i) in items" :key="`${i}:${it.key}`" class="cr-item">
        <span v-if="i > 0" class="cr-sep" aria-hidden="true">›</span>
        <span v-if="i === items.length - 1" class="cr-here" aria-current="page">{{ it.label }}</span>
        <button v-else type="button" class="cr-btn" :data-testid="`crumb-${i}`" @click="emit('go', i)">{{ it.label }}</button>
      </li>
    </ol>
  </nav>
</template>

<style scoped>
.crumbs {
  min-width: 0;
  overflow-x: auto; /* a long trail scrolls sideways instead of wrapping */
  scrollbar-width: thin;
}
.cr-list {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  white-space: nowrap;
}
.cr-item {
  display: flex;
  align-items: center;
  gap: 2px;
  animation: cr-fade 150ms ease-out;
}
/* On a narrow bar the earlier crumbs give way first (ellipsis); the current page keeps its room. */
.cr-item:not(:last-child) {
  flex: 0 1 auto;
  min-width: 0;
}
.cr-item:last-child {
  flex: 0 0 auto;
}
.cr-item:not(:last-child) .cr-btn {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Under about 360 px there is no room for the trail: only the current place is shown (no parent, no separator). */
@media (max-width: 359px) {
  .cr-item:not(:last-child),
  .cr-sep {
    display: none;
  }
}
.cr-sep {
  color: rgb(var(--ink-3));
  padding: 0 2px;
}
.cr-btn,
.cr-here {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 8px;
  font: inherit;
  font-size: 14px;
}
.cr-btn {
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: rgb(var(--ink-2));
  cursor: pointer;
}
.cr-btn:hover {
  background: rgb(var(--sunken));
  color: rgb(var(--ink));
}
.cr-btn:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: -2px;
}
.cr-here {
  font-weight: 600;
  color: rgb(var(--ink));
}
/* Opt-in: wrap onto a second line instead of shortening or scrolling (every item stays whole and tappable). */
.cr-wrap {
  overflow-x: visible;
}
.cr-wrap .cr-list {
  flex-wrap: wrap;
  white-space: normal;
}
.cr-wrap .cr-item:not(:last-child),
.cr-wrap .cr-item:last-child {
  flex: 0 1 auto;
  min-width: 0;
}
.cr-wrap .cr-here {
  text-align: left;
  overflow-wrap: anywhere;
}
.cr-wrap .cr-item:not(:last-child) .cr-btn {
  overflow: visible;
  text-overflow: clip;
  white-space: normal;
  text-align: left;
}
@media (max-width: 359px) {
  .cr-wrap .cr-item:not(:last-child),
  .cr-wrap .cr-sep {
    display: flex;
  }
}
@keyframes cr-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .cr-item {
    animation: none;
  }
}
</style>
