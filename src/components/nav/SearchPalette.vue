<script setup lang="ts">
// The / search: one box over every page in every group — page names first, then pages matched by a
// chart title (lib/nav.ts searchPages) — each result with its page icon, its path for a drill page
// ("Traffic › mobile › California") and its group's badge, so
// same-named pages in two groups stay apart. ↑/↓ move, ↵ opens, Esc closes and puts focus back
// where it was. A modal dialog: the input keeps focus (the results are its listbox, announced via
// aria-activedescendant), and Tab stays inside.
import { computed, nextTick, ref, watch } from 'vue'
import type { DashboardPage, GroupMeta } from '../../types'
import { DRILL_TRAIL_SEP, ancestorsOf, highlightParts, rootOf, searchPages, type SearchHit } from '../../lib/nav'
import { SearchIcon, StarIcon } from '../../lib/icons'
import PageIcon from './PageIcon.vue'
import GroupBadge from './GroupBadge.vue'

const props = defineProps<{ open: boolean; pages: DashboardPage[]; groupMeta?: Record<string, GroupMeta>; groupOrder?: string[] }>()
const emit = defineEmits<{ close: []; pick: [id: string] }>()

const query = ref('')
const activeIdx = ref(0)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null

const hits = computed(() => searchPages(query.value, props.pages, props.groupOrder))
/** A drill page's ancestors, top-level page first ("Traffic › mobile › "), shown before its name. */
const pathPrefix = (p: DashboardPage) => {
  const up = ancestorsOf(p, props.pages).reverse()
  return up.length ? up.map((a) => a.name).join(DRILL_TRAIL_SEP) + DRILL_TRAIL_SEP : ''
}
const optId = (i: number) => `nav-search-opt-${i}`
watch(query, () => (activeIdx.value = 0))
watch(
  () => props.open,
  async (open) => {
    if (open) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      query.value = ''
      activeIdx.value = 0
      await nextTick()
      input.value?.focus()
    } else if (returnFocus?.isConnected) {
      returnFocus.focus()
      returnFocus = null
    }
  },
  { immediate: true },
)

function groupOf(p: DashboardPage) {
  const r = rootOf(p, props.pages)
  return { name: r.group, pinned: r.isDefault }
}
function move(delta: number) {
  const n = hits.value.length
  if (!n) return
  activeIdx.value = (activeIdx.value + delta + n) % n
  nextTick(() => list.value?.querySelector<HTMLElement>(`#${optId(activeIdx.value)}`)?.scrollIntoView?.({ block: 'nearest' }))
}
function choose(h: SearchHit | undefined) {
  if (h) emit('pick', h.page.id)
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    move(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    move(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    choose(hits.value[activeIdx.value])
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('close')
  } else if (e.key === 'Tab') {
    e.preventDefault() // the input is the dialog's only stop
  }
}
const nameParts = (h: SearchHit) => (h.match === 'name' ? highlightParts(h.page.name, h.at, h.len) : [{ text: h.page.name, mark: false }])
const chartParts = (h: SearchHit) => (h.chart ? highlightParts(h.chart, h.at, h.len) : [])
</script>

<template>
  <Teleport to="body">
    <template v-if="open">
      <div class="sp-scrim" aria-hidden="true" @click="emit('close')"></div>
      <div class="sp-panel" role="dialog" aria-modal="true" aria-label="Search pages" @keydown="onKeydown">
        <div class="sp-q">
          <SearchIcon :size="18" aria-hidden="true" />
          <input
            ref="input"
            v-model="query"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="nav-search-list"
            :aria-activedescendant="hits.length ? optId(activeIdx) : undefined"
            aria-label="Search pages and charts"
            placeholder="Search pages and charts"
            autocomplete="off"
            spellcheck="false"
          />
          <kbd>esc</kbd>
        </div>
        <ul id="nav-search-list" ref="list" class="sp-list" role="listbox" aria-label="Pages">
          <li
            v-for="(h, i) in hits"
            :id="optId(i)"
            :key="h.page.id"
            role="option"
            class="nav-row sp-opt"
            :class="{ active: i === activeIdx }"
            :aria-selected="i === activeIdx"
            @mousemove="activeIdx = i"
            @mousedown.prevent
            @click="choose(h)"
          >
            <PageIcon :page="h.page" :pages="pages" />
            <span class="nm">
              <span v-if="pathPrefix(h.page)" class="path">{{ pathPrefix(h.page) }}</span>
              <template v-for="(part, j) in nameParts(h)" :key="j"><mark v-if="part.mark">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template>
              <span v-if="h.match === 'chart'" class="meta">
                · chart “<template v-for="(part, j) in chartParts(h)" :key="j"><mark v-if="part.mark">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template>”
              </span>
            </span>
            <template v-if="groupOf(h.page).pinned">
              <span class="gname">pinned</span>
              <StarIcon class="star" :size="16" aria-hidden="true" />
            </template>
            <template v-else>
              <span class="gname">{{ groupOf(h.page).name }}</span>
              <GroupBadge :name="groupOf(h.page).name" :meta="groupMeta?.[groupOf(h.page).name]" />
            </template>
          </li>
          <li v-if="!hits.length" class="sp-empty" role="presentation">No page or chart matches “{{ query }}”.</li>
        </ul>
        <div class="sp-keys" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </template>
  </Teleport>
</template>

<style scoped>
.sp-scrim {
  position: fixed;
  inset: 0;
  z-index: 1300;
  background: rgb(var(--scrim) / 0.32);
}
.sp-panel {
  position: fixed;
  z-index: 1310;
  left: 50%;
  top: 70px;
  translate: -50% 0;
  width: min(580px, calc(100vw - 24px));
  max-height: calc(100vh - 100px);
  display: flex;
  flex-direction: column;
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line-2));
  border-radius: 14px;
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.16);
  overflow: hidden;
}
.sp-panel:focus-within {
  border-color: rgb(var(--amber));
}
.sp-q {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 16px;
  border-bottom: 1px solid rgb(var(--line));
  color: rgb(var(--ink-3));
}
.sp-q input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  padding: 2px 0;
  font-size: 15px;
  color: rgb(var(--ink));
}
.sp-q input:focus {
  outline: none;
  border: none;
}
.sp-list {
  list-style: none;
  margin: 0;
  padding: 6px 8px;
  overflow-y: auto;
}
.sp-opt {
  padding: 8px 10px;
}
.sp-opt.active {
  background: rgb(var(--amber-tint));
}
.sp-opt .meta {
  margin-left: 4px;
}
.path {
  color: rgb(var(--ink-3));
  font-weight: 400;
}
.gname {
  color: rgb(var(--ink-3));
  font-size: 12px;
  flex: none;
}
mark {
  background: none;
  color: rgb(var(--amber-hover));
  font-weight: 600;
}
.sp-empty {
  padding: 14px 10px;
  color: rgb(var(--ink-3));
  font-size: 13px;
}
.sp-keys {
  display: flex;
  gap: 16px;
  padding: 9px 16px;
  border-top: 1px solid rgb(var(--line));
  background: rgb(var(--sunken));
  font-size: 11.5px;
  color: rgb(var(--ink-3));
}
.sp-keys span {
  display: flex;
  gap: 5px;
  align-items: center;
}
@media (max-width: 700px) {
  .sp-panel {
    top: 12px;
    max-height: calc(100vh - 24px);
  }
  .sp-keys {
    display: none;
  }
  .gname {
    display: none;
  }
}
</style>
