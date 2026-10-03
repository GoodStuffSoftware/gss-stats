<script setup lang="ts">
// The page drawer behind ☰: the whole page tree as an overlay over the charts, on every screen
// size. ★ Overview pinned first (unindented), then each group — its header collapsible, with its
// badge, a ⋯ group menu (Rename, New page in this group, Delete group…) and its page count — its
// pages indented one level under it, and each page's drill pages one level further per level of
// drilling (a page with drill pages can fold them away; remembered per viewer). Every page has the
// ⋯ page menu; drill pages also have × to delete them. Names are renamed in place. "+ New" at the
// bottom runs the create wizards (NewWizards.vue). A modal dialog: focus moves in (the page on
// screen), Tab stays inside, and Esc, the scrim or picking a page closes it (focus goes back to ☰).
import { computed, nextTick, ref, watch } from 'vue'
import type { DashboardPage, GroupMeta } from '../../types'
import { GROUP_NAME_MAX, PAGE_NAME_MAX, cleanGroupName, cleanPageName } from '../../lib/defaults'
import { ancestorsOf, groupNameError, navTree, orderedGroups, rootOf, rootsInGroup, type NavNode, type RenameTarget } from '../../lib/nav'
import type { GroupDraft, PageDraft } from '../../lib/wizards'
import { ChevronDownIcon, CloseIcon, EllipsisIcon, StarIcon } from '../../lib/icons'
import PageIcon from './PageIcon.vue'
import GroupBadge from './GroupBadge.vue'
import GroupMenu from './GroupMenu.vue'
import InlineName from './InlineName.vue'
import NewWizards from './NewWizards.vue'

const props = defineProps<{
  open: boolean
  pages: DashboardPage[]
  active: DashboardPage
  groupMeta?: Record<string, GroupMeta>
  groupOrder?: string[]
  collapsed: string[]
  /** Pages whose drill pages this viewer folded away. */
  collapsedPages?: string[]
  /** The page whose ⋯ menu is open (its ⋯ button shows as pressed). */
  menuFor?: string | null
  /** A name being renamed in place (shown as a text field when it's in the drawer). */
  renaming?: RenameTarget | null
  returnTo?: HTMLElement | null
  /** Phone layout: menus open as bottom sheets. */
  compact?: boolean
}>()
const emit = defineEmits<{
  close: []
  switch: [id: string]
  menu: [id: string, anchor: HTMLElement]
  delete: [id: string]
  'toggle-group': [name: string]
  'toggle-page': [id: string]
  'rename-start': [target: RenameTarget]
  'rename-page': [id: string, name: string]
  'rename-group': [from: string, to: string]
  'rename-cancel': []
  'delete-group': [name: string, anchor: HTMLElement | null]
  'create-page': [draft: PageDraft]
  'create-group': [draft: GroupDraft]
}>()

const panel = ref<HTMLElement | null>(null)
const tree = computed(() => navTree(props.pages, props.groupOrder))
const groups = computed(() => orderedGroups(props.pages, props.groupOrder))
const activeRoot = computed(() => rootOf(props.active, props.pages))
const activeGroup = computed(() => (activeRoot.value.isDefault ? null : activeRoot.value.group))
/** The page on screen and its ancestors: always unfolded, so the page on screen always shows. */
const activeLine = computed(() => new Set([props.active.id, ...ancestorsOf(props.active, props.pages).map((p) => p.id)]))
// The group holding the page on screen always shows, even if this viewer collapsed it.
const isOpenGroup = (name: string) => name === activeGroup.value || !props.collapsed.includes(name)
const gid = (i: number) => `drawer-group-${i}`

/** A node's rows, one per page, each with its depth: a page and — unless folded — its drill pages. */
interface Row {
  page: DashboardPage
  depth: number
  kids: number
  unfolded: boolean
}
function rowsOf(n: NavNode, depth: number, out: Row[] = []): Row[] {
  const unfolded = !props.collapsedPages?.includes(n.page.id) || activeLine.value.has(n.page.id)
  out.push({ page: n.page, depth, kids: n.children.length, unfolded })
  if (unfolded) for (const c of n.children) rowsOf(c, depth + 1, out)
  return out
}
const pinnedRows = computed(() => (tree.value.pinned ? rowsOf(tree.value.pinned, 0) : []))
const groupRows = computed(() => tree.value.groups.map((g) => ({ group: g, rows: g.nodes.flatMap((n) => rowsOf(n, 1)) })))

const renamingPage = (id: string) => props.renaming?.where === 'drawer' && props.renaming.kind === 'page' && props.renaming.key === id
const renamingGroup = (name: string) => props.renaming?.where === 'drawer' && props.renaming.kind === 'group' && props.renaming.key === name
const groupNameCheck = (self: string) => (name: string) => groupNameError(name, groups.value, self)

watch(
  () => props.open,
  async (open) => {
    if (open) {
      await nextTick()
      const current = panel.value?.querySelector<HTMLElement>('.dr-page[aria-current="page"]')
      ;(current ?? panel.value?.querySelector<HTMLElement>('button'))?.focus()
    } else {
      groupMenu.value = null
      await nextTick()
      if (props.returnTo?.isConnected) props.returnTo.focus()
    }
  },
)

function focusables(): HTMLElement[] {
  if (!panel.value) return []
  return Array.from(panel.value.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled])')).filter(
    (el) => !el.closest('[inert], [aria-hidden="true"]') && !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked),
  )
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

// ── In-place rename: focus goes back to the row (or group header) afterwards ──
async function focusRow(sel: string) {
  await nextTick()
  panel.value?.querySelector<HTMLElement>(sel)?.focus()
}
const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'))
function savePage(id: string, name: string) {
  emit('rename-page', id, name)
  focusRow(`[data-page="${esc(id)}"] > .dr-page`)
}
function saveGroup(from: string, to: string) {
  emit('rename-group', from, to)
  focusRow(`[data-group="${esc(to)}"] .dr-gbtn`)
}
function cancelPageRename(id: string) {
  emit('rename-cancel')
  focusRow(`[data-page="${esc(id)}"] > .dr-page`)
}
function cancelGroupRename(name: string) {
  emit('rename-cancel')
  focusRow(`[data-group="${esc(name)}"] .dr-gbtn`)
}

// ── Group ⋯ menu ──
const groupMenu = ref<{ name: string; anchor: HTMLElement } | null>(null)
const groupMenuCount = computed(() => (groupMenu.value ? rootsInGroup(groupMenu.value.name, props.pages).length : 0))
function openGroupMenu(name: string, e: MouseEvent) {
  const anchor = e.currentTarget as HTMLElement
  groupMenu.value = groupMenu.value?.name === name ? null : { name, anchor }
}
function closeGroupMenu(reason: 'action' | 'dismiss') {
  const anchor = groupMenu.value?.anchor
  groupMenu.value = null
  if (reason === 'action') nextTick(() => {
    // the action moved focus on (a rename field, the wizard, a dialog): leave it there
    if (panel.value?.contains(document.activeElement) && document.activeElement !== document.body) return
    if (anchor?.isConnected) anchor.focus()
  })
}
const wizards = ref<InstanceType<typeof NewWizards> | null>(null)
function newPageIn(group: string) {
  wizards.value?.start('page', { group })
}

// ── "+ New" ──
const flash = ref<string | null>(null)
let flashTimer: number | undefined
async function onCreateGroup(d: GroupDraft) {
  emit('create-group', d)
  const name = cleanGroupName(d.name)
  await nextTick()
  const sec = panel.value?.querySelector<HTMLElement>(`[data-group="${esc(name)}"]`)
  sec?.scrollIntoView?.({ block: 'nearest', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  sec?.querySelector<HTMLElement>('.dr-gbtn')?.focus({ preventScroll: true })
  flash.value = name
  clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => (flash.value = null), 2200)
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
            <li v-for="r in pinnedRows" :key="r.page.id" class="dr-item" :data-page="r.page.id" :style="{ '--depth': r.depth }">
              <button
                v-if="r.kids"
                type="button"
                class="dr-fold"
                :aria-expanded="r.unfolded"
                :aria-label="`${r.unfolded ? 'Fold' : 'Unfold'} the drill pages of ${r.page.name}`"
                @click="emit('toggle-page', r.page.id)"
              >
                <ChevronDownIcon :class="{ shut: !r.unfolded }" :size="13" aria-hidden="true" />
              </button>
              <div v-if="renamingPage(r.page.id)" class="nav-row dr-page dr-editing" :class="{ kid: r.depth > 0 }">
                <PageIcon :page="r.page" :pages="pages" />
                <InlineName
                  :value="r.page.name"
                  :label="`Rename page ${r.page.name}`"
                  :maxlength="PAGE_NAME_MAX"
                  :clean="cleanPageName"
                  @save="savePage(r.page.id, $event)"
                  @cancel="cancelPageRename(r.page.id)"
                />
              </div>
              <button v-else type="button" class="nav-row dr-page" :class="{ kid: r.depth > 0 }" :aria-current="r.page.id === active.id ? 'page' : undefined" @click="emit('switch', r.page.id)">
                <PageIcon :page="r.page" :pages="pages" />
                <span class="nm">{{ r.page.name }}</span>
                <template v-if="r.depth === 0">
                  <StarIcon class="star" :size="14" aria-hidden="true" />
                  <span class="visually-hidden">(pinned)</span>
                </template>
              </button>
              <button
                type="button"
                class="dr-act dr-more"
                :aria-label="`Page options: ${r.page.name}`"
                aria-haspopup="menu"
                :aria-expanded="menuFor === r.page.id"
                @click="openMenu(r.page.id, $event)"
              >
                <EllipsisIcon :size="16" aria-hidden="true" />
              </button>
              <button v-if="r.depth > 0" type="button" class="dr-act dr-x" :aria-label="`Delete drill page ${r.page.name}`" @click="emit('delete', r.page.id)">
                <CloseIcon :size="14" aria-hidden="true" />
              </button>
            </li>
          </ul>
          <section v-for="({ group: g, rows }, gi) in groupRows" :key="g.name" class="dr-group" :class="{ flash: flash === g.name }" :data-group="g.name">
            <div class="dr-gh" :class="{ cur: g.name === activeGroup, pressed: groupMenu?.name === g.name }">
              <h3 class="dr-gh-h">
                <div v-if="renamingGroup(g.name)" class="dr-gbtn dr-editing">
                  <ChevronDownIcon class="dr-cv" :class="{ shut: !isOpenGroup(g.name) }" :size="14" aria-hidden="true" />
                  <GroupBadge :name="g.name" :meta="groupMeta?.[g.name]" />
                  <InlineName
                    :value="g.name"
                    :label="`Rename group ${g.name}`"
                    :maxlength="GROUP_NAME_MAX"
                    :clean="cleanGroupName"
                    :validate="groupNameCheck(g.name)"
                    @save="saveGroup(g.name, $event)"
                    @cancel="cancelGroupRename(g.name)"
                  />
                </div>
                <button v-else type="button" class="dr-gbtn" :aria-expanded="isOpenGroup(g.name)" :aria-controls="gid(gi)" @click="emit('toggle-group', g.name)">
                  <ChevronDownIcon class="dr-cv" :class="{ shut: !isOpenGroup(g.name) }" :size="14" aria-hidden="true" />
                  <GroupBadge :name="g.name" :meta="groupMeta?.[g.name]" />
                  <span class="nm">{{ g.name }}</span>
                  <span class="visually-hidden">, {{ g.nodes.length }} page{{ g.nodes.length === 1 ? '' : 's' }}</span>
                </button>
              </h3>
              <button
                type="button"
                class="dr-gmore"
                :aria-label="`Group options: ${g.name}`"
                aria-haspopup="menu"
                :aria-expanded="groupMenu?.name === g.name"
                @click="openGroupMenu(g.name, $event)"
              >
                <EllipsisIcon :size="16" aria-hidden="true" />
              </button>
              <span class="cnt" aria-hidden="true">{{ g.nodes.length }}</span>
            </div>
            <ul v-if="isOpenGroup(g.name)" :id="gid(gi)" class="dr-list">
              <li v-for="r in rows" :key="r.page.id" class="dr-item" :data-page="r.page.id" :style="{ '--depth': r.depth }">
                <button
                  v-if="r.kids"
                  type="button"
                  class="dr-fold"
                  :aria-expanded="r.unfolded"
                  :aria-label="`${r.unfolded ? 'Fold' : 'Unfold'} the drill pages of ${r.page.name}`"
                  @click="emit('toggle-page', r.page.id)"
                >
                  <ChevronDownIcon :class="{ shut: !r.unfolded }" :size="13" aria-hidden="true" />
                </button>
                <div v-if="renamingPage(r.page.id)" class="nav-row dr-page dr-editing" :class="{ kid: r.depth > 1 }">
                  <PageIcon :page="r.page" :pages="pages" />
                  <InlineName
                    :value="r.page.name"
                    :label="`Rename page ${r.page.name}`"
                    :maxlength="PAGE_NAME_MAX"
                    :clean="cleanPageName"
                    @save="savePage(r.page.id, $event)"
                    @cancel="cancelPageRename(r.page.id)"
                  />
                </div>
                <button v-else type="button" class="nav-row dr-page" :class="{ kid: r.depth > 1 }" :aria-current="r.page.id === active.id ? 'page' : undefined" @click="emit('switch', r.page.id)">
                  <PageIcon :page="r.page" :pages="pages" />
                  <span class="nm">{{ r.page.name }}</span>
                </button>
                <button
                  type="button"
                  class="dr-act dr-more"
                  :aria-label="`Page options: ${r.page.name}`"
                  aria-haspopup="menu"
                  :aria-expanded="menuFor === r.page.id"
                  @click="openMenu(r.page.id, $event)"
                >
                  <EllipsisIcon :size="16" aria-hidden="true" />
                </button>
                <button v-if="r.depth > 1" type="button" class="dr-act dr-x" :aria-label="`Delete drill page ${r.page.name}`" @click="emit('delete', r.page.id)">
                  <CloseIcon :size="14" aria-hidden="true" />
                </button>
              </li>
              <li v-if="!g.nodes.length" class="dr-empty">No pages yet</li>
            </ul>
          </section>
        </nav>
        <div class="dr-foot">
          <NewWizards ref="wizards" :pages="pages" :active="active" :group-order="groupOrder" :group-meta="groupMeta" @create-page="emit('create-page', $event)" @create-group="onCreateGroup" />
        </div>
        <GroupMenu
          :open="!!groupMenu"
          :anchor="groupMenu?.anchor ?? null"
          :group="groupMenu?.name ?? null"
          :page-count="groupMenuCount"
          :sheet="compact"
          @close="closeGroupMenu"
          @rename="(g) => emit('rename-start', { kind: 'group', key: g, where: 'drawer' })"
          @new-page="newPageIn"
          @delete="(g) => emit('delete-group', g, groupMenu?.anchor ?? null)"
        />
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
/* ── Rows: one indent step per level (★ Overview at 0, a group's pages at 1, their drill pages 2…) ── */
.dr-item {
  --depth: 0;
  --step: 18px;
  position: relative;
  display: flex;
  align-items: center;
}
.dr-item .nav-row.dr-page {
  padding-left: calc(24px + var(--depth) * var(--step));
  padding-right: 34px;
}
.dr-item:has(.dr-x) .nav-row.dr-page {
  padding-right: 62px;
}
.dr-item .nav-row.dr-page.kid {
  font-size: 12.5px;
}
.dr-item .nav-row.dr-page.kid::before {
  left: calc(24px + (var(--depth) - 1) * var(--step) + 7px);
}
/* A drill page with drill pages of its own: its fold chevron takes the connector's place. */
.dr-item:has(.dr-fold) .nav-row.dr-page.kid::before {
  display: none;
}
.dr-editing {
  cursor: default;
}
.dr-editing:hover {
  background: transparent;
}
.dr-fold {
  position: absolute;
  z-index: 1;
  left: calc(4px + var(--depth) * var(--step));
  top: 50%;
  translate: 0 -50%;
  width: 18px;
  height: 22px;
  display: grid;
  place-items: center;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: rgb(var(--ink-3));
}
.dr-fold:hover {
  background: rgb(var(--line));
  color: rgb(var(--ink));
}
.dr-fold:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: -2px;
}
.dr-fold .shut,
.dr-cv.shut {
  transform: rotate(-90deg);
}
.dr-fold svg,
.dr-cv {
  transition: transform 0.12s ease;
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
.dr-item:has(.dr-x) .dr-more {
  right: 32px;
}
.dr-act:hover,
.dr-gmore:hover {
  background: rgb(var(--line));
  color: rgb(var(--ink));
}
.dr-act:focus-visible,
.dr-gmore:focus-visible {
  opacity: 1;
  outline: 2px solid rgb(var(--amber));
  outline-offset: -2px;
}
.dr-item:hover .dr-act,
.dr-item:focus-within .dr-act,
.dr-act[aria-expanded='true'],
.dr-page[aria-current='page'] ~ .dr-act {
  opacity: 1;
}
.dr-x:hover {
  color: #bc4749;
}
/* ── Group headers: the same hover, focus and pressed look as the page rows ── */
.dr-group {
  margin-top: 8px;
  border-radius: 9px;
  transition: box-shadow 0.3s ease, background 0.3s ease;
}
.dr-group.flash {
  background: rgb(var(--amber-tint));
  box-shadow: 0 0 0 2px rgb(var(--amber) / 0.55);
}
.dr-gh {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-right: 6px;
  border-radius: 7px;
}
.dr-gh:hover,
.dr-gh.pressed,
.dr-gh:has(.dr-gbtn:focus-visible) {
  background: rgb(var(--sunken));
}
.dr-gh:has(.dr-gbtn:focus-visible) {
  box-shadow: inset 0 0 0 2px rgb(var(--amber) / 0.55);
}
.dr-gh.cur .dr-gbtn {
  color: rgb(var(--ink));
}
.dr-gh-h {
  flex: 1;
  min-width: 0;
  margin: 0;
  font: inherit;
  letter-spacing: 0;
}
.dr-gbtn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 7px 4px 7px 6px;
  border: none;
  border-radius: 7px;
  background: transparent;
  font: 600 12px Inter, system-ui, sans-serif;
  color: rgb(var(--ink-2));
  text-align: left;
  cursor: pointer;
}
.dr-gbtn:focus-visible {
  outline: none;
}
.dr-gbtn .nm {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dr-cv {
  flex: none;
  color: rgb(var(--ink-3));
}
.dr-gmore {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  flex: none;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: rgb(var(--ink-3));
  opacity: 0;
}
.dr-gh:hover .dr-gmore,
.dr-gh:focus-within .dr-gmore,
.dr-gmore[aria-expanded='true'] {
  opacity: 1;
}
.cnt {
  min-width: 14px;
  text-align: right;
  font: 500 10.5px 'JetBrains Mono', monospace;
  color: rgb(var(--ink-3));
}
.dr-empty {
  padding: 5px 9px 5px 42px;
  font-size: 12px;
  font-style: italic;
  color: rgb(var(--ink-3));
}
/* No hover on touch: the actions are always there. */
@media (hover: none) {
  .dr-act,
  .dr-gmore {
    opacity: 1;
  }
}
.dr-foot {
  flex: none;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid rgb(var(--line));
}
</style>
