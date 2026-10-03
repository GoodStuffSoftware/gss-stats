<script setup lang="ts">
// The header breadcrumb, the everyday way to move around: Group / Page / Drill / Drill… — the whole
// path to the page on screen. Each segment opens a list: the group segment ★ Overview and every
// group (and "Rename group"), the page segment the pages in that group with their drill pages
// nested under them (and "New page in <group>"), a drill segment its sibling drill pages with its
// own drill pages under it (and the way back to its parent). On ★ Overview the group segment is
// ★ Overview itself. When the path doesn't fit — and always on a phone (`compact`) — the segments
// between the group and the last one or two fold into "…", whose list holds them. On a phone the
// lists open as a bottom sheet. Double-clicking the group or a page segment (or Rename in a menu)
// renames it in place.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DashboardPage, GroupMeta } from '../../types'
import { GROUP_NAME_MAX, PAGE_NAME_MAX, cleanGroupName, cleanPageName } from '../../lib/defaults'
import { childrenOf, descendantsOf, depthOf, groupNameError, navTree, orderedGroups, parentOf, pathOf, type NavNode, type RenameTarget } from '../../lib/nav'
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon, PlusIcon, RenameIcon, StarIcon } from '../../lib/icons'
import NavPopover from './NavPopover.vue'
import PageIcon from './PageIcon.vue'
import GroupBadge from './GroupBadge.vue'
import InlineName from './InlineName.vue'

const props = defineProps<{
  pages: DashboardPage[]
  active: DashboardPage
  groupMeta?: Record<string, GroupMeta>
  groupOrder?: string[]
  compact?: boolean
  renaming?: RenameTarget | null
}>()
const emit = defineEmits<{
  switch: [id: string]
  'switch-group': [group: string]
  'new-page': [group: string]
  'rename-start': [target: RenameTarget]
  'rename-page': [id: string, name: string]
  'rename-group': [from: string, to: string]
  'rename-cancel': []
}>()

const tree = computed(() => navTree(props.pages, props.groupOrder))
const groups = computed(() => orderedGroups(props.pages, props.groupOrder))
const path = computed(() => pathOf(props.active, props.pages))
const root = computed(() => path.value[0])
const pinnedRoot = computed(() => root.value.isDefault)
const group = computed(() => root.value.group)
const groupNode = computed(() => tree.value.groups.find((g) => g.name === group.value))
const meta = (g: string) => props.groupMeta?.[g]

// ── Segments ──
/** The pages after the group segment: the whole path (on ★ Overview, its drill pages only — the
 * group segment is ★ Overview itself). */
const pageSegs = computed(() => (pinnedRoot.value ? path.value.slice(1) : path.value))
// How much of the middle is folded into "…": 0 none, 1 all but the last two, 2 all but the last.
const fold = ref(0)
const level = computed(() => (props.compact ? 2 : fold.value))
type Seg = { kind: 'page'; page: DashboardPage } | { kind: 'more'; hidden: DashboardPage[] }
const shownSegs = computed<Seg[]>(() => {
  const segs = pageSegs.value
  const keep = level.value === 2 ? 1 : level.value === 1 ? 2 : segs.length
  if (segs.length <= keep) return segs.map((page) => ({ kind: 'page', page }))
  const hidden = segs.slice(0, segs.length - keep)
  return [{ kind: 'more', hidden }, ...segs.slice(segs.length - keep).map((page): Seg => ({ kind: 'page', page }))]
})

// Desktop: fold the middle only when the full path doesn't fit (a segment's name gets cut off).
const crumbs = ref<HTMLElement | null>(null)
function overflowing(): boolean {
  const names = crumbs.value?.querySelectorAll<HTMLElement>('.seg-name') ?? []
  return Array.from(names).some((n) => n.scrollWidth > n.clientWidth + 1)
}
let fitting = 0
async function fit() {
  if (props.compact) return
  const run = ++fitting
  fold.value = 0
  await nextTick()
  while (run === fitting && fold.value < 2 && pageSegs.value.length > (fold.value === 0 ? 2 : 1) && overflowing()) {
    fold.value++
    await nextTick()
  }
}
watch(
  () => [props.compact, path.value.map((p) => `${p.id}:${p.name}`).join('|'), group.value],
  () => fit(),
  { flush: 'post' },
)
onMounted(() => {
  fit()
  window.addEventListener('resize', fit)
})
onBeforeUnmount(() => window.removeEventListener('resize', fit))

// ── Menus ──
/** 'group', 'more', or `p:<page id>` for a page or drill segment. */
const open = ref<string | null>(null)
const anchors = new Map<string, HTMLElement>()
const setAnchor = (key: string) => (el: unknown) => {
  if (el instanceof HTMLElement) anchors.set(key, el)
  else anchors.delete(key)
}
const anchorOf = (key: string | null) => (key ? anchors.get(key) ?? null : null)
const openPage = computed(() => (open.value?.startsWith('p:') ? props.pages.find((p) => `p:${p.id}` === open.value) ?? null : null))
const openIsRoot = computed(() => !!openPage.value && !parentOf(openPage.value, props.pages))

function toggle(key: string) {
  open.value = open.value === key ? null : key
}
function close() {
  open.value = null
}
async function refocus() {
  await nextTick()
  const segs = Array.from(crumbs.value?.querySelectorAll<HTMLElement>('.seg') ?? [])
  segs.at(-1)?.focus()
}
function pick(id: string) {
  close()
  emit('switch', id)
  refocus()
}
function pickGroup(g: string) {
  close()
  emit('switch-group', g)
  refocus()
}
function newPage() {
  close()
  emit('new-page', group.value)
  refocus()
}
function switchGroupList() {
  // the phone sheet's "Switch group" button
  open.value = 'group'
}

// The page list: each page of the group with its drill pages nested under it. A page with many drill
// pages shows them folded ("Show 9 drill pages") unless the page on screen is one of them.
const BIG = 6
const unfolded = ref<Set<string>>(new Set())
interface ListRow {
  page: DashboardPage
  depth: number
}
function listRows(n: NavNode, depth: number, out: ListRow[] = []): ListRow[] {
  out.push({ page: n.page, depth })
  for (const c of n.children) listRows(c, depth + 1, out)
  return out
}
const onLine = (id: string) => path.value.some((p) => p.id === id)
const pageList = computed(() =>
  (groupNode.value?.nodes ?? []).map((n) => {
    const kids = n.children.flatMap((c) => listRows(c, 1))
    const folded = kids.length > BIG && !onLine(n.page.id) && !unfolded.value.has(n.page.id)
    return { page: n.page, kids, folded }
  }),
)
function unfold(id: string) {
  unfolded.value = new Set([...unfolded.value, id])
  nextTick(() => document.querySelector<HTMLElement>(`#crumb-pages [data-page="${id}"] + [role="menuitem"]`)?.focus())
}
// A drill segment's list: its siblings (the drill pages of its parent), its own drill pages under it.
const drillParent = computed(() => (openPage.value ? parentOf(openPage.value, props.pages) : undefined))
const drillSiblings = computed(() => (drillParent.value ? childrenOf(drillParent.value.id, props.pages) : []))
const ownKids = computed(() => {
  const p = openPage.value
  if (!p) return []
  const base = depthOf(p, props.pages)
  return descendantsOf(p.id, props.pages).map((k) => ({ page: k, depth: depthOf(k, props.pages) - base }))
})
const hiddenSegs = computed(() => (shownSegs.value[0]?.kind === 'more' ? shownSegs.value[0].hidden : []))
const drillCount = (n: number) => (n === 1 ? '1 drill page' : `${n} drill pages`)

// ── In-place rename ──
const renamingGroup = computed(() => props.renaming?.where === 'crumb' && props.renaming.kind === 'group' && props.renaming.key === group.value && !pinnedRoot.value)
const renamingPage = (id: string) => props.renaming?.where === 'crumb' && props.renaming.kind === 'page' && props.renaming.key === id
const groupNameCheck = (name: string) => groupNameError(name, groups.value, group.value)
function startRenameGroupSeg() {
  close()
  if (pinnedRoot.value) emit('rename-start', { kind: 'page', key: root.value.id, where: 'crumb' })
  else emit('rename-start', { kind: 'group', key: group.value, where: 'crumb' })
}
function startRenamePage(id: string) {
  close()
  emit('rename-start', { kind: 'page', key: id, where: 'crumb' })
}
async function focusSeg(key: string) {
  await nextTick()
  ;(anchors.get(key) ?? crumbs.value?.querySelector<HTMLElement>('.seg'))?.focus()
}
function savePage(id: string, name: string, key: string) {
  emit('rename-page', id, name)
  focusSeg(key)
}
function saveGroup(to: string) {
  emit('rename-group', group.value, to)
  focusSeg('group')
}
function cancelRename(key: string) {
  emit('rename-cancel')
  focusSeg(key)
}
</script>

<template>
  <nav ref="crumbs" class="crumbs" :class="{ compact }" aria-label="Pages">
    <ol>
      <li>
        <span v-if="renamingGroup" class="seg editing">
          <GroupBadge :name="group" :meta="meta(group)" />
          <InlineName :value="group" :label="`Rename group ${group}`" :maxlength="GROUP_NAME_MAX" :clean="cleanGroupName" :validate="groupNameCheck" @save="saveGroup" @cancel="cancelRename('group')" />
        </span>
        <span v-else-if="pinnedRoot && renamingPage(root.id)" class="seg editing">
          <StarIcon class="star" :size="15" aria-hidden="true" />
          <InlineName :value="root.name" :label="`Rename page ${root.name}`" :maxlength="PAGE_NAME_MAX" :clean="cleanPageName" @save="savePage(root.id, $event, 'group')" @cancel="cancelRename('group')" />
        </span>
        <button
          v-else
          :ref="setAnchor('group')"
          type="button"
          class="seg"
          :class="{ open: open === 'group' }"
          aria-haspopup="menu"
          :aria-expanded="open === 'group'"
          :aria-label="pinnedRoot ? `${root.name} (pinned), switch group` : `Group: ${group}, switch group`"
          :aria-current="pinnedRoot && pageSegs.length === 0 ? 'page' : undefined"
          @click="toggle('group')"
          @dblclick="startRenameGroupSeg"
        >
          <template v-if="pinnedRoot">
            <StarIcon class="star" :size="15" aria-hidden="true" />
            <span class="seg-name">{{ root.name }}</span>
          </template>
          <template v-else>
            <GroupBadge :name="group" :meta="meta(group)" />
            <span class="seg-name">{{ group }}</span>
          </template>
          <ChevronDownIcon class="cv" :size="14" aria-hidden="true" />
        </button>
      </li>
      <li v-for="(s, i) in shownSegs" :key="s.kind === 'more' ? 'more' : s.page.id" :class="{ last: i === shownSegs.length - 1 }">
        <span class="sl" aria-hidden="true">/</span>
        <button
          v-if="s.kind === 'more'"
          :ref="setAnchor('more')"
          type="button"
          class="seg more"
          :class="{ open: open === 'more' }"
          aria-haspopup="menu"
          :aria-expanded="open === 'more'"
          :aria-label="`${s.hidden.length} more page${s.hidden.length === 1 ? '' : 's'} on the way here: ${s.hidden.map((p) => p.name).join(', ')}`"
          @click="toggle('more')"
        >
          <span aria-hidden="true">…</span>
        </button>
        <span v-else-if="renamingPage(s.page.id)" class="seg editing">
          <PageIcon :page="s.page" :pages="pages" />
          <InlineName :value="s.page.name" :label="`Rename page ${s.page.name}`" :maxlength="PAGE_NAME_MAX" :clean="cleanPageName" @save="savePage(s.page.id, $event, `p:${s.page.id}`)" @cancel="cancelRename(`p:${s.page.id}`)" />
        </span>
        <button
          v-else
          :ref="setAnchor(`p:${s.page.id}`)"
          type="button"
          class="seg"
          :class="{ open: open === `p:${s.page.id}` }"
          aria-haspopup="menu"
          :aria-expanded="open === `p:${s.page.id}`"
          :aria-label="parentOf(s.page, pages) ? `Drill page: ${s.page.name}, switch drill page` : `Page: ${s.page.name}, switch page`"
          :aria-current="s.page.id === active.id ? 'page' : undefined"
          @click="toggle(`p:${s.page.id}`)"
          @dblclick="startRenamePage(s.page.id)"
        >
          <PageIcon :page="s.page" :pages="pages" />
          <span class="seg-name">{{ s.page.name }}</span>
          <ChevronDownIcon class="cv" :size="14" aria-hidden="true" />
        </button>
      </li>
    </ol>

    <!-- Group list: ★ Overview, then every group -->
    <NavPopover :open="open === 'group'" :anchor="anchorOf('group')" label="Groups" :sheet="compact" panel-id="crumb-groups" @close="close">
      <div v-if="compact" class="nav-head sheet-title">Groups</div>
      <button v-if="tree.pinned" type="button" role="menuitem" class="nav-row" :aria-current="pinnedRoot ? 'page' : undefined" @click="pick(tree.pinned.page.id)">
        <StarIcon class="star" :size="16" aria-hidden="true" />
        <span class="nm">{{ tree.pinned.page.name }}</span>
        <span class="meta">pinned</span>
        <CheckIcon v-if="pinnedRoot" class="ck" :size="16" aria-hidden="true" />
      </button>
      <div v-if="tree.pinned && tree.groups.length" class="nav-sep" role="separator"></div>
      <button
        v-for="g in tree.groups"
        :key="g.name"
        type="button"
        role="menuitem"
        class="nav-row"
        :disabled="!g.nodes.length"
        :aria-current="!pinnedRoot && g.name === group ? 'page' : undefined"
        @click="pickGroup(g.name)"
      >
        <GroupBadge :name="g.name" :meta="meta(g.name)" />
        <span class="nm">{{ g.name }}</span>
        <span class="meta">{{ g.nodes.length || 'empty' }}</span>
        <CheckIcon v-if="!pinnedRoot && g.name === group" class="ck" :size="16" aria-hidden="true" />
      </button>
      <template v-if="!pinnedRoot">
        <div class="nav-sep" role="separator"></div>
        <button type="button" role="menuitem" class="nav-row new" @click="startRenameGroupSeg">
          <RenameIcon :size="15" aria-hidden="true" />
          <span class="nm">Rename {{ group }}</span>
        </button>
      </template>
    </NavPopover>

    <!-- Page list: the pages in this group, each with its drill pages nested under it -->
    <NavPopover :open="!!openPage && openIsRoot" :anchor="anchorOf(open)" :label="`Pages in ${group}`" :sheet="compact" :width="300" panel-id="crumb-pages" @close="close">
      <div class="nav-head" :class="{ 'sheet-title': compact }">
        <GroupBadge :name="group" :meta="meta(group)" />
        <span class="nm">{{ group }}</span>
        <button v-if="compact" type="button" class="btn switch-group" @click="switchGroupList">Switch group</button>
      </div>
      <template v-for="n in pageList" :key="n.page.id">
        <button type="button" role="menuitem" class="nav-row" :data-page="n.page.id" :aria-current="n.page.id === active.id ? 'page' : undefined" @click="pick(n.page.id)">
          <PageIcon :page="n.page" :pages="pages" />
          <span class="nm">{{ n.page.name }}</span>
          <CheckIcon v-if="onLine(n.page.id)" class="ck" :size="16" aria-hidden="true" />
        </button>
        <button v-if="n.folded" type="button" role="menuitem" class="nav-row kid more-kids" aria-expanded="false" :style="{ '--d': 1 }" @click="unfold(n.page.id)">
          <ChevronRightIcon :size="14" aria-hidden="true" />
          <span class="nm">Show {{ drillCount(n.kids.length) }}</span>
        </button>
        <template v-else>
          <button
            v-for="k in n.kids"
            :key="k.page.id"
            type="button"
            role="menuitem"
            class="nav-row kid"
            :style="{ '--d': k.depth }"
            :aria-current="k.page.id === active.id ? 'page' : undefined"
            @click="pick(k.page.id)"
          >
            <PageIcon :page="k.page" :pages="pages" />
            <span class="nm">{{ k.page.name }}</span>
            <CheckIcon v-if="onLine(k.page.id)" class="ck" :size="16" aria-hidden="true" />
          </button>
        </template>
      </template>
      <div class="nav-sep" role="separator"></div>
      <button type="button" role="menuitem" class="nav-row new" @click="newPage">
        <PlusIcon :size="16" aria-hidden="true" />
        <span class="nm">New page in {{ group }}</span>
      </button>
    </NavPopover>

    <!-- Drill list: the drill pages of this one's parent, this one's own drill pages under it, and back -->
    <NavPopover
      :open="!!openPage && !openIsRoot"
      :anchor="anchorOf(open)"
      :label="`Drills from ${drillParent?.name ?? ''}`"
      :sheet="compact"
      :width="300"
      panel-id="crumb-drills"
      @close="close"
    >
      <div class="nav-head">Drills from {{ drillParent?.name }}</div>
      <template v-for="k in drillSiblings" :key="k.id">
        <button type="button" role="menuitem" class="nav-row" :aria-current="k.id === active.id ? 'page' : undefined" @click="pick(k.id)">
          <PageIcon :page="k" :pages="pages" />
          <span class="nm">{{ k.name }}</span>
          <span v-if="k.id !== openPage?.id && childrenOf(k.id, pages).length" class="meta">{{ drillCount(descendantsOf(k.id, pages).length) }}</span>
          <CheckIcon v-if="onLine(k.id)" class="ck" :size="16" aria-hidden="true" />
        </button>
        <template v-if="k.id === openPage?.id">
          <button
            v-for="c in ownKids"
            :key="c.page.id"
            type="button"
            role="menuitem"
            class="nav-row kid"
            :style="{ '--d': c.depth }"
            :aria-current="c.page.id === active.id ? 'page' : undefined"
            @click="pick(c.page.id)"
          >
            <PageIcon :page="c.page" :pages="pages" />
            <span class="nm">{{ c.page.name }}</span>
            <CheckIcon v-if="onLine(c.page.id)" class="ck" :size="16" aria-hidden="true" />
          </button>
        </template>
      </template>
      <div class="nav-sep" role="separator"></div>
      <button v-if="drillParent" type="button" role="menuitem" class="nav-row new" @click="pick(drillParent.id)">
        <CloseIcon :size="16" aria-hidden="true" />
        <span class="nm">Back to {{ drillParent.name }}</span>
      </button>
    </NavPopover>

    <!-- "…": the folded middle of the path -->
    <NavPopover :open="open === 'more'" :anchor="anchorOf('more')" label="On the way here" :sheet="compact" panel-id="crumb-more" @close="close">
      <div class="nav-head">On the way here</div>
      <button
        v-for="(p, i) in hiddenSegs"
        :key="p.id"
        type="button"
        role="menuitem"
        class="nav-row"
        :class="{ kid: i > 0 || pinnedRoot }"
        :style="{ '--d': i + (pinnedRoot ? 1 : 0) }"
        @click="pick(p.id)"
      >
        <PageIcon :page="p" :pages="pages" />
        <span class="nm">{{ p.name }}</span>
      </button>
    </NavPopover>
  </nav>
</template>

<style scoped>
.crumbs {
  min-width: 0;
}
.crumbs ol {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
.crumbs li {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}
.sl {
  color: rgb(var(--ink-3));
  padding: 0 2px;
  font: 500 14px 'Space Grotesk', system-ui, sans-serif;
}
.seg {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 280px;
  padding: 4px 6px 4px 7px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: rgb(var(--ink-2));
  font: 500 14px 'Space Grotesk', system-ui, sans-serif;
  white-space: nowrap;
}
.seg[aria-current='page'] {
  color: rgb(var(--ink));
  font-weight: 600;
}
button.seg:hover {
  background: rgb(var(--sunken));
  color: rgb(var(--ink));
}
.seg:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: 1px;
}
.seg.open {
  background: rgb(var(--amber-tint));
  color: rgb(var(--ink));
  box-shadow: inset 0 0 0 1px rgb(var(--amber));
}
.seg.more {
  flex: none;
  padding: 4px 8px;
  font-weight: 700;
  letter-spacing: 0.05em;
}
.seg.editing {
  min-width: 160px;
  max-width: 320px;
  padding: 2px 4px;
}
.seg-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cv {
  flex: none;
  color: rgb(var(--ink-3));
}
/* Nested drill pages in the lists: one indent step per level under their page. */
.np-panel .nav-row.kid {
  padding-left: calc(14px + var(--d, 1) * 16px);
}
.np-panel .nav-row.kid::before {
  left: calc(3px + var(--d, 1) * 16px);
}
.more-kids {
  color: rgb(var(--ink-2));
}
.compact .seg {
  max-width: none;
  padding: 3px 4px;
  font-size: 13.5px;
  gap: 5px;
}
.compact .seg.editing {
  min-width: 120px;
}
/* Phone: when space runs out, the group name gives way before the page name. */
.compact li:first-child {
  flex-shrink: 4;
}
.compact li + li {
  flex-shrink: 1;
}
.compact li:first-child .cv {
  display: none;
}
/* Phone: the ☰ button next to it already carries the group's badge. */
.compact li:first-child .group-badge {
  display: none;
}
.sheet-title {
  font-size: 15px;
  font-family: 'Space Grotesk', system-ui, sans-serif;
  letter-spacing: 0;
  text-transform: none;
  color: rgb(var(--ink));
  padding: 2px 8px 8px;
}
.switch-group {
  margin-left: auto;
  padding: 4px 9px;
  font-size: 12px;
  text-transform: none;
  letter-spacing: 0;
}
</style>
