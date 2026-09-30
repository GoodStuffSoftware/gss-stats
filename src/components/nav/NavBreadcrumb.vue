<script setup lang="ts">
// The header breadcrumb, the everyday way to move around: Group / Page / Drill. Each segment opens a
// list of its siblings — the group segment ★ Overview and every group, the page segment the pages in
// that group (and "New page in <group>"), the drill segment the other drill pages of the same page
// and the way back to it. On ★ Overview the group segment is ★ Overview itself. On a phone
// (`compact`) it collapses to Group / Page, where Page is the page on screen (drill pages listed
// under their page), and the lists open as a bottom sheet.
import { computed, nextTick, ref } from 'vue'
import type { DashboardPage, GroupMeta } from '../../types'
import { drillChildren, navTree, rootOf } from '../../lib/nav'
import { CheckIcon, ChevronDownIcon, CloseIcon, PlusIcon, StarIcon } from '../../lib/icons'
import NavPopover from './NavPopover.vue'
import PageIcon from './PageIcon.vue'
import GroupBadge from './GroupBadge.vue'

const props = defineProps<{ pages: DashboardPage[]; active: DashboardPage; groupMeta?: Record<string, GroupMeta>; compact?: boolean }>()
const emit = defineEmits<{ switch: [id: string]; 'switch-group': [group: string]; 'new-page': [group: string] }>()

const tree = computed(() => navTree(props.pages))
const root = computed(() => rootOf(props.active, props.pages))
const pinnedRoot = computed(() => root.value.isDefault)
const onDrill = computed(() => root.value.id !== props.active.id)
const group = computed(() => root.value.group)
const groupNodes = computed(() => tree.value.groups.find((g) => g.name === group.value)?.nodes ?? [])
const siblings = computed(() => drillChildren(root.value.id, props.pages))
const meta = (g: string) => props.groupMeta?.[g]

// Which segments show. Desktop: group, then the page (not on ★ Overview), then the drill page.
// Phone: group, then ONE more — the page on screen (for ★ Overview, only when on a drill page).
const showPage = computed(() => !pinnedRoot.value)
const showDrill = computed(() => onDrill.value && (!props.compact || pinnedRoot.value))

type Menu = 'group' | 'page' | 'drill'
const open = ref<Menu | null>(null)
const groupBtn = ref<HTMLElement | null>(null)
const pageBtn = ref<HTMLElement | null>(null)
const drillBtn = ref<HTMLElement | null>(null)
const anchorOf = (m: Menu | null) => (m === 'group' ? groupBtn.value : m === 'page' ? pageBtn.value : m === 'drill' ? drillBtn.value : null)

function toggle(m: Menu) {
  open.value = open.value === m ? null : m
}
function close() {
  open.value = null
}
async function refocus() {
  await nextTick()
  const el = [drillBtn.value, pageBtn.value, groupBtn.value].find((b) => b?.isConnected)
  el?.focus()
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
const drillCount = (n: number) => (n === 1 ? '1 drill' : `${n} drills`)
</script>

<template>
  <nav class="crumbs" :class="{ compact }" aria-label="Pages">
    <ol>
      <li>
        <button
          ref="groupBtn"
          type="button"
          class="seg"
          :class="{ open: open === 'group' }"
          aria-haspopup="menu"
          :aria-expanded="open === 'group'"
          :aria-label="pinnedRoot ? `${root.name} (pinned), switch group` : `Group: ${group}, switch group`"
          :aria-current="pinnedRoot && !onDrill ? 'page' : undefined"
          @click="toggle('group')"
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
      <li v-if="showPage">
        <span class="sl" aria-hidden="true">/</span>
        <button
          ref="pageBtn"
          type="button"
          class="seg"
          :class="{ open: open === 'page' }"
          aria-haspopup="menu"
          :aria-expanded="open === 'page'"
          :aria-label="`Page: ${(compact ? active : root).name}, switch page`"
          :aria-current="!onDrill || compact ? 'page' : undefined"
          @click="toggle('page')"
        >
          <PageIcon :page="compact ? active : root" :pages="pages" />
          <span class="seg-name">{{ (compact ? active : root).name }}</span>
          <ChevronDownIcon class="cv" :size="14" aria-hidden="true" />
        </button>
      </li>
      <li v-if="showDrill">
        <span class="sl" aria-hidden="true">/</span>
        <button
          ref="drillBtn"
          type="button"
          class="seg"
          :class="{ open: open === 'drill' }"
          aria-haspopup="menu"
          :aria-expanded="open === 'drill'"
          :aria-label="`Drill page: ${active.name}, switch drill page`"
          aria-current="page"
          @click="toggle('drill')"
        >
          <PageIcon :page="active" :pages="pages" />
          <span class="seg-name">{{ active.name }}</span>
          <ChevronDownIcon class="cv" :size="14" aria-hidden="true" />
        </button>
      </li>
    </ol>

    <!-- Group list: ★ Overview, then every group -->
    <NavPopover :open="open === 'group'" :anchor="anchorOf('group')" label="Groups" :sheet="compact" panel-id="crumb-groups" @close="close">
      <div v-if="compact" class="nav-head sheet-title">Groups</div>
      <button
        v-if="tree.pinned"
        type="button"
        role="menuitem"
        class="nav-row"
        :aria-current="pinnedRoot ? 'page' : undefined"
        @click="pick(tree.pinned.page.id)"
      >
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
        :aria-current="!pinnedRoot && g.name === group ? 'page' : undefined"
        @click="pickGroup(g.name)"
      >
        <GroupBadge :name="g.name" :meta="meta(g.name)" />
        <span class="nm">{{ g.name }}</span>
        <span class="meta">{{ g.nodes.length }}</span>
        <CheckIcon v-if="!pinnedRoot && g.name === group" class="ck" :size="16" aria-hidden="true" />
      </button>
    </NavPopover>

    <!-- Page list: the pages in this group -->
    <NavPopover :open="open === 'page'" :anchor="anchorOf('page')" :label="`Pages in ${group}`" :sheet="compact" panel-id="crumb-pages" @close="close">
      <div class="nav-head" :class="{ 'sheet-title': compact }">
        <GroupBadge :name="group" :meta="meta(group)" />
        <span class="nm">{{ group }}</span>
        <button v-if="compact" type="button" class="btn switch-group" @click="switchGroupList">Switch group</button>
      </div>
      <template v-for="n in groupNodes" :key="n.page.id">
        <button
          type="button"
          role="menuitem"
          class="nav-row"
          :aria-current="n.page.id === active.id || (!compact && n.page.id === root.id) ? 'page' : undefined"
          @click="pick(n.page.id)"
        >
          <PageIcon :page="n.page" :pages="pages" />
          <span class="nm">{{ n.page.name }}</span>
          <span v-if="n.children.length" class="meta">{{ drillCount(n.children.length) }}</span>
          <CheckIcon v-if="n.page.id === root.id" class="ck" :size="16" aria-hidden="true" />
        </button>
        <template v-if="compact && n.page.id === root.id">
          <button
            v-for="k in n.children"
            :key="k.id"
            type="button"
            role="menuitem"
            class="nav-row kid"
            :aria-current="k.id === active.id ? 'page' : undefined"
            @click="pick(k.id)"
          >
            <PageIcon :page="k" :pages="pages" />
            <span class="nm">{{ k.name }}</span>
            <CheckIcon v-if="k.id === active.id" class="ck" :size="16" aria-hidden="true" />
          </button>
        </template>
      </template>
      <div class="nav-sep" role="separator"></div>
      <button type="button" role="menuitem" class="nav-row new" @click="newPage">
        <PlusIcon :size="16" aria-hidden="true" />
        <span class="nm">New page in {{ group }}</span>
      </button>
    </NavPopover>

    <!-- Drill list: the other drill pages of this page, and back to it -->
    <NavPopover :open="open === 'drill'" :anchor="anchorOf('drill')" :label="`Drills from ${root.name}`" :sheet="compact" panel-id="crumb-drills" @close="close">
      <div class="nav-head">Drills from {{ root.name }}</div>
      <button
        v-for="k in siblings"
        :key="k.id"
        type="button"
        role="menuitem"
        class="nav-row"
        :aria-current="k.id === active.id ? 'page' : undefined"
        @click="pick(k.id)"
      >
        <PageIcon :page="k" :pages="pages" />
        <span class="nm">{{ k.name }}</span>
        <CheckIcon v-if="k.id === active.id" class="ck" :size="16" aria-hidden="true" />
      </button>
      <div class="nav-sep" role="separator"></div>
      <button type="button" role="menuitem" class="nav-row new" @click="pick(root.id)">
        <CloseIcon :size="16" aria-hidden="true" />
        <span class="nm">Back to {{ root.name }}</span>
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
.seg:hover {
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
.seg-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cv {
  flex: none;
  color: rgb(var(--ink-3));
}
.compact .seg {
  max-width: none;
  padding: 3px 4px;
  font-size: 13.5px;
  gap: 5px;
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
