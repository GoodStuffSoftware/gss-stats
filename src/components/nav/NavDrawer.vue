<script setup lang="ts">
// The page drawer behind ☰: the whole page tree as an overlay over the charts, on every screen
// size. ★ Overview pinned first, then each group (collapsible, with its badge and page count), its
// pages with their icons, drill pages indented under their page with × to delete them, a ⋯ page menu
// on every page, and "New page". A modal dialog: focus moves in (the page on screen), Tab stays
// inside, and Esc, the scrim or picking a page closes it (focus goes back to ☰).
import { computed, nextTick, ref, watch } from 'vue'
import type { DashboardPage, GroupMeta } from '../../types'
import { navTree, rootOf } from '../../lib/nav'
import { ChevronDownIcon, CloseIcon, EllipsisIcon, PlusIcon, StarIcon } from '../../lib/icons'
import PageIcon from './PageIcon.vue'
import GroupBadge from './GroupBadge.vue'

const props = defineProps<{
  open: boolean
  pages: DashboardPage[]
  active: DashboardPage
  groupMeta?: Record<string, GroupMeta>
  collapsed: string[]
  /** The page whose ⋯ menu is open (its ⋯ button shows as pressed). */
  menuFor?: string | null
  returnTo?: HTMLElement | null
}>()
const emit = defineEmits<{
  close: []
  switch: [id: string]
  menu: [id: string, anchor: HTMLElement]
  delete: [id: string]
  'new-page': []
  'toggle-group': [name: string]
}>()

const panel = ref<HTMLElement | null>(null)
const tree = computed(() => navTree(props.pages))
const activeGroup = computed(() => {
  const r = rootOf(props.active, props.pages)
  return r.isDefault ? null : r.group
})
// The group holding the page on screen always shows, even if this viewer collapsed it.
const isOpenGroup = (name: string) => name === activeGroup.value || !props.collapsed.includes(name)
const gid = (i: number) => `drawer-group-${i}`

watch(
  () => props.open,
  async (open) => {
    if (open) {
      await nextTick()
      const current = panel.value?.querySelector<HTMLElement>('.dr-page[aria-current="page"]')
      ;(current ?? panel.value?.querySelector<HTMLElement>('button'))?.focus()
    } else {
      await nextTick()
      if (props.returnTo?.isConnected) props.returnTo.focus()
    }
  },
)

function focusables(): HTMLElement[] {
  return panel.value ? Array.from(panel.value.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input')) : []
}
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
    } else if (!e.shiftKey && i === f.length - 1) {
      e.preventDefault()
      f[0].focus()
    }
  }
}
function openMenu(id: string, e: MouseEvent) {
  emit('menu', id, e.currentTarget as HTMLElement)
}
</script>

<template>
  <Teleport to="body">
    <template v-if="open">
      <div class="dr-scrim" aria-hidden="true" @click="emit('close')"></div>
      <aside id="nav-drawer" ref="panel" class="drawer" role="dialog" aria-modal="true" aria-label="Pages" @keydown="onKeydown">
        <div class="dr-head">
          <span class="logo" aria-hidden="true">S</span>
          <div class="dr-title">
            <strong>Stats</strong>
            <span class="overline">Good Stuff Software · bot-free RUM</span>
          </div>
          <button type="button" class="btn btn-ghost dr-close" aria-label="Close pages" @click="emit('close')">
            <CloseIcon :size="16" aria-hidden="true" />
          </button>
        </div>
        <nav class="dr-body" aria-label="All pages">
          <ul v-if="tree.pinned" class="dr-list">
            <li class="dr-item">
              <button type="button" class="nav-row dr-page" :aria-current="tree.pinned.page.id === active.id ? 'page' : undefined" @click="emit('switch', tree.pinned.page.id)">
                <PageIcon :page="tree.pinned.page" :pages="pages" />
                <span class="nm">{{ tree.pinned.page.name }}</span>
                <StarIcon class="star" :size="14" aria-hidden="true" />
                <span class="visually-hidden">(pinned)</span>
              </button>
              <button
                type="button"
                class="dr-act dr-more"
                :aria-label="`Page options: ${tree.pinned.page.name}`"
                aria-haspopup="menu"
                :aria-expanded="menuFor === tree.pinned.page.id"
                @click="openMenu(tree.pinned.page.id, $event)"
              >
                <EllipsisIcon :size="16" aria-hidden="true" />
              </button>
            </li>
            <li v-for="k in tree.pinned.children" :key="k.id" class="dr-item">
              <button type="button" class="nav-row kid dr-page" :aria-current="k.id === active.id ? 'page' : undefined" @click="emit('switch', k.id)">
                <PageIcon :page="k" :pages="pages" />
                <span class="nm">{{ k.name }}</span>
              </button>
              <button type="button" class="dr-act dr-x" :aria-label="`Delete drill page ${k.name}`" @click="emit('delete', k.id)">
                <CloseIcon :size="14" aria-hidden="true" />
              </button>
            </li>
          </ul>
          <section v-for="(g, gi) in tree.groups" :key="g.name" class="dr-group">
            <h3 class="dr-gh">
              <button type="button" class="dr-gbtn" :aria-expanded="isOpenGroup(g.name)" :aria-controls="gid(gi)" @click="emit('toggle-group', g.name)">
                <ChevronDownIcon class="dr-cv" :class="{ shut: !isOpenGroup(g.name) }" :size="14" aria-hidden="true" />
                <GroupBadge :name="g.name" :meta="groupMeta?.[g.name]" />
                <span class="nm">{{ g.name }}</span>
                <span class="cnt" :aria-label="`${g.nodes.length} pages`">{{ g.nodes.length }}</span>
              </button>
            </h3>
            <ul v-if="isOpenGroup(g.name)" :id="gid(gi)" class="dr-list">
              <template v-for="n in g.nodes" :key="n.page.id">
                <li class="dr-item">
                  <button type="button" class="nav-row dr-page" :aria-current="n.page.id === active.id ? 'page' : undefined" @click="emit('switch', n.page.id)">
                    <PageIcon :page="n.page" :pages="pages" />
                    <span class="nm">{{ n.page.name }}</span>
                  </button>
                  <button
                    type="button"
                    class="dr-act dr-more"
                    :aria-label="`Page options: ${n.page.name}`"
                    aria-haspopup="menu"
                    :aria-expanded="menuFor === n.page.id"
                    @click="openMenu(n.page.id, $event)"
                  >
                    <EllipsisIcon :size="16" aria-hidden="true" />
                  </button>
                </li>
                <li v-for="k in n.children" :key="k.id" class="dr-item">
                  <button type="button" class="nav-row kid dr-page" :aria-current="k.id === active.id ? 'page' : undefined" @click="emit('switch', k.id)">
                    <PageIcon :page="k" :pages="pages" />
                    <span class="nm">{{ k.name }}</span>
                  </button>
                  <button type="button" class="dr-act dr-x" :aria-label="`Delete drill page ${k.name}`" @click="emit('delete', k.id)">
                    <CloseIcon :size="14" aria-hidden="true" />
                  </button>
                </li>
              </template>
            </ul>
          </section>
          <div class="nav-sep"></div>
          <button type="button" class="nav-row new dr-new" @click="emit('new-page')">
            <PlusIcon :size="16" aria-hidden="true" />
            <span class="nm">New page</span>
          </button>
        </nav>
      </aside>
    </template>
  </Teleport>
</template>

<style scoped>
.dr-scrim {
  position: fixed;
  inset: 0;
  z-index: 1290;
  background: rgb(var(--scrim) / 0.32);
  animation: dr-fade 0.15s ease;
}
.drawer {
  position: fixed;
  z-index: 1300;
  top: 0;
  bottom: 0;
  left: 0;
  width: 300px;
  max-width: 85vw;
  display: flex;
  flex-direction: column;
  background: rgb(var(--surface));
  border-right: 1px solid rgb(var(--line-2));
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.16);
  padding: 10px 8px calc(10px + env(safe-area-inset-bottom));
  animation: dr-in 0.18s ease;
}
@keyframes dr-in {
  from {
    transform: translateX(-16px);
    opacity: 0;
  }
}
@keyframes dr-fade {
  from {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .drawer,
  .dr-scrim {
    animation: none;
  }
}
.dr-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 2px 4px 10px;
  border-bottom: 1px solid rgb(var(--line));
  margin-bottom: 4px;
}
.logo {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: rgb(var(--amber));
  color: #fff;
  font: 700 15px 'JetBrains Mono', monospace;
  display: grid;
  place-items: center;
  flex: none;
}
.dr-title {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.15;
}
.dr-title strong {
  font: 600 15px 'Space Grotesk', system-ui, sans-serif;
}
.dr-title .overline {
  font-size: 9px;
  letter-spacing: 0.1em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dr-close {
  margin-left: auto;
  padding: 6px;
}
.dr-body {
  overflow-y: auto;
  min-height: 0;
  flex: 1;
}
.dr-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.dr-item {
  position: relative;
  display: flex;
  align-items: center;
}
.dr-item .nav-row {
  padding-right: 34px;
}
.dr-act {
  position: absolute;
  right: 4px;
  top: 50%;
  translate: 0 -50%;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: rgb(var(--ink-3));
  opacity: 0;
}
.dr-act:hover {
  background: rgb(var(--line));
  color: rgb(var(--ink));
}
.dr-act:focus-visible {
  opacity: 1;
  outline: 2px solid rgb(var(--amber));
  outline-offset: -2px;
}
.dr-item:hover .dr-act,
.dr-item:focus-within .dr-act,
.dr-act[aria-expanded='true'],
.dr-page[aria-current='page'] + .dr-act {
  opacity: 1;
}
.dr-x:hover {
  color: #bc4749;
}
/* No hover on touch: the actions are always there. */
@media (hover: none) {
  .dr-act {
    opacity: 1;
  }
}
.dr-gh {
  margin: 0;
  font: inherit;
  letter-spacing: 0;
}
.dr-gbtn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 12px 9px 5px 4px;
  border: none;
  background: transparent;
  font: 600 12px Inter, system-ui, sans-serif;
  color: rgb(var(--ink-2));
  text-align: left;
}
.dr-gbtn:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: -2px;
  border-radius: 6px;
}
.dr-gbtn .nm {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dr-cv {
  color: rgb(var(--ink-3));
  transition: transform 0.12s ease;
}
.dr-cv.shut {
  transform: rotate(-90deg);
}
.cnt {
  font: 500 10.5px 'JetBrains Mono', monospace;
  color: rgb(var(--ink-3));
}
.dr-new {
  margin-top: 2px;
  color: rgb(var(--ink-3));
}
</style>
