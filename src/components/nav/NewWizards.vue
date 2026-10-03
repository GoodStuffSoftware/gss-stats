<script setup lang="ts">
// The page drawer's "+ New": the wizards of lib/wizards.ts (a page, a group) run in a
// WizardCarousel, with their step content here. A new page: its name, its group (an existing one or
// a new one named inline), and what it starts from (blank, a copy of the page on screen, or a
// built-in page's default charts) with its icon (Auto, shown, or one picked in the icon picker). A
// new group: its name, which pages to move into it (optional), and a review. Nothing changes until
// Create, which is emitted with the draft; the app makes it.
import { computed, reactive, ref } from 'vue'
import type { DashboardPage, GroupMeta } from '../../types'
import { GROUP_NAME_MAX, PAGE_NAME_MAX } from '../../lib/defaults'
import { orderedGroups, rootOf } from '../../lib/nav'
import { ICONS, autoIcon, iconLabel, type IconKey } from '../../lib/icons'
import {
  WIZARDS,
  PAGE_TEMPLATES,
  buildPage,
  groupStepError,
  movablePages,
  newGroupDraft,
  newPageDraft,
  pageDraftGroup,
  pageStepError,
  type GroupDraft,
  type PageDraft,
} from '../../lib/wizards'
import WizardCarousel from './WizardCarousel.vue'
import GroupBadge from './GroupBadge.vue'
import PageIcon from './PageIcon.vue'
import IconPicker from './IconPicker.vue'

const props = defineProps<{
  pages: DashboardPage[]
  active: DashboardPage
  groupOrder?: string[]
  groupMeta?: Record<string, GroupMeta>
}>()
const emit = defineEmits<{ 'create-page': [draft: PageDraft]; 'create-group': [draft: GroupDraft] }>()

const groups = computed(() => orderedGroups(props.pages, props.groupOrder))
const page = reactive<PageDraft>(newPageDraft(''))
const group = reactive<GroupDraft>(newGroupDraft())
// A field's message shows once it has been typed into (not on an untouched, empty field).
const touched = reactive<Record<string, boolean>>({})
const carousel = ref<InstanceType<typeof WizardCarousel> | null>(null)
let presetGroup: string | null = null

function defaultGroup(): string {
  const r = rootOf(props.active, props.pages)
  if (!r.isDefault && groups.value.includes(r.group)) return r.group
  return groups.value[0] ?? ''
}
function onStart(id: string) {
  for (const k of Object.keys(touched)) delete touched[k]
  if (id === 'page') {
    Object.assign(page, newPageDraft(presetGroup ?? defaultGroup()))
    if (!groups.value.length) page.groupMode = 'new'
  } else if (id === 'group') Object.assign(group, newGroupDraft())
  presetGroup = null
}
/** Open a wizard directly: "page" with `preset.group` picked ("New page in this group"). */
function start(id: 'page' | 'group', preset?: { group?: string }) {
  presetGroup = preset?.group ?? null
  carousel.value?.start(id)
}
defineExpose({ start })

function pickGroup(g: string) {
  page.groupMode = 'existing'
  page.group = g
}
function stepError(wizardId: string, stepId: string): string | null {
  if (wizardId === 'page') return pageStepError(stepId, page, groups.value)
  if (wizardId === 'group') return groupStepError(stepId, group, groups.value)
  return null
}
function onCreate(id: string) {
  if (id === 'page') emit('create-page', { ...page })
  else if (id === 'group') emit('create-group', { ...group, pageIds: [...group.pageIds] })
}

// Page: what it would look like, for the Auto icon and the icon picker.
const draftPage = computed(() => buildPage({ ...page, name: page.name || 'New page' }, props.active))
const auto = computed(() => autoIcon(draftPage.value, props.pages))
const pickingIcon = ref(false)
const iconBtn = ref<HTMLElement | null>(null)
function pickIcon(key: IconKey | null) {
  page.icon = key
  pickingIcon.value = false
}

// Group: the pages it can take, and what Create will do.
const candidates = computed(() => movablePages(props.pages, props.groupOrder))
const picked = computed(() => candidates.value.filter((p) => group.pageIds.includes(p.id)))
function togglePage(id: string, on: boolean) {
  group.pageIds = on ? [...group.pageIds, id] : group.pageIds.filter((x) => x !== id)
}
const newGroupName = computed(() => group.name.replace(/\s+/g, ' ').trim())
</script>

<template>
  <WizardCarousel ref="carousel" :wizards="WIZARDS" :step-error="stepError" id-prefix="drawer-new" @start="onStart" @create="onCreate">
    <template #step="{ wizard, step }">
      <!-- ── New page ─────────────────────────────────────────────── -->
      <template v-if="wizard.id === 'page'">
        <div v-if="step.id === 'name'" class="wf">
          <label class="wf-label" for="wz-page-name">Page name</label>
          <input
            id="wz-page-name"
            v-model="page.name"
            data-autofocus
            type="text"
            class="wf-input"
            :maxlength="PAGE_NAME_MAX"
            placeholder="e.g. Retention"
            autocomplete="off"
            :aria-invalid="touched.pageName && !!stepError('page', 'name')"
            aria-describedby="wz-page-name-err"
            @input="touched.pageName = true"
          />
          <p id="wz-page-name-err" class="wf-err" role="status">{{ touched.pageName ? stepError('page', 'name') : '' }}</p>
        </div>

        <fieldset v-else-if="step.id === 'group'" class="wf">
          <legend class="wf-label">Put it in</legend>
          <div class="wf-list" role="radiogroup" aria-label="Group">
            <label v-for="g in groups" :key="g" class="nav-row wf-opt">
              <input
                type="radio"
                name="wz-page-group"
                :value="g"
                class="visually-hidden"
                :checked="page.groupMode === 'existing' && page.group === g"
                :data-autofocus="page.groupMode === 'existing' && page.group === g ? '' : undefined"
                @change="pickGroup(g)"
              />
              <GroupBadge :name="g" :meta="groupMeta?.[g]" />
              <span class="nm">{{ g }}</span>
              <span class="wf-radio" :class="{ on: page.groupMode === 'existing' && page.group === g }" aria-hidden="true"></span>
            </label>
            <label class="nav-row wf-opt new">
              <input
                type="radio"
                name="wz-page-group"
                value="__new__"
                class="visually-hidden"
                :checked="page.groupMode === 'new'"
                :data-autofocus="page.groupMode === 'new' ? '' : undefined"
                @change="page.groupMode = 'new'"
              />
              <span class="wf-plus" aria-hidden="true">+</span>
              <span class="nm">New group…</span>
              <span class="wf-radio" :class="{ on: page.groupMode === 'new' }" aria-hidden="true"></span>
            </label>
          </div>
          <template v-if="page.groupMode === 'new'">
            <label class="wf-label" for="wz-page-newgroup">New group's name</label>
            <input
              id="wz-page-newgroup"
              v-model="page.newGroup"
              type="text"
              class="wf-input"
              :maxlength="GROUP_NAME_MAX"
              placeholder="e.g. Star Rupture"
              autocomplete="off"
              :aria-invalid="touched.newGroup && !!stepError('page', 'group')"
              aria-describedby="wz-page-newgroup-err"
              @input="touched.newGroup = true"
            />
            <p id="wz-page-newgroup-err" class="wf-err" role="status">{{ touched.newGroup ? stepError('page', 'group') : '' }}</p>
          </template>
        </fieldset>

        <div v-else-if="step.id === 'start'" class="wf">
          <fieldset class="wf-set">
            <legend class="wf-label">Start from</legend>
            <div class="wf-list" role="radiogroup" aria-label="Start from">
              <label class="nav-row wf-opt">
                <input v-model="page.start" type="radio" name="wz-page-start" value="blank" class="visually-hidden" :data-autofocus="page.start === 'blank' ? '' : undefined" />
                <span class="nm">Blank page</span>
                <span class="wf-radio" :class="{ on: page.start === 'blank' }" aria-hidden="true"></span>
              </label>
              <label class="nav-row wf-opt">
                <input v-model="page.start" type="radio" name="wz-page-start" value="duplicate" class="visually-hidden" :data-autofocus="page.start === 'duplicate' ? '' : undefined" />
                <span class="nm">Copy of “{{ active.name }}”</span>
                <span class="wf-radio" :class="{ on: page.start === 'duplicate' }" aria-hidden="true"></span>
              </label>
              <div class="wf-sub">Default charts of</div>
              <label v-for="t in PAGE_TEMPLATES" :key="t.id" class="nav-row wf-opt">
                <input v-model="page.start" type="radio" name="wz-page-start" :value="t.id" class="visually-hidden" :data-autofocus="page.start === t.id ? '' : undefined" />
                <span class="nm">{{ t.label }}</span>
                <span class="wf-radio" :class="{ on: page.start === t.id }" aria-hidden="true"></span>
              </label>
            </div>
          </fieldset>
          <div class="wf-label">Icon</div>
          <div class="wf-icon">
            <span class="wf-icon-now">
              <component :is="ICONS[page.icon ?? auto.key]" :size="18" aria-hidden="true" />
              <span v-if="page.icon">{{ iconLabel(page.icon) }}</span>
              <span v-else>Auto: {{ iconLabel(auto.key).toLowerCase() }}</span>
            </span>
            <button v-if="page.icon" type="button" class="btn wf-mini" @click="page.icon = null">Use Auto</button>
            <button ref="iconBtn" type="button" class="btn wf-mini" @click="pickingIcon = true">Pick…</button>
          </div>
          <IconPicker :open="pickingIcon" :page="{ ...draftPage, icon: page.icon ?? undefined }" :pages="pages" :return-to="iconBtn" @close="pickingIcon = false" @pick="pickIcon" />
        </div>
      </template>

      <!-- ── New group ────────────────────────────────────────────── -->
      <template v-else-if="wizard.id === 'group'">
        <div v-if="step.id === 'name'" class="wf">
          <label class="wf-label" for="wz-group-name">Group name</label>
          <input
            id="wz-group-name"
            v-model="group.name"
            data-autofocus
            type="text"
            class="wf-input"
            :maxlength="GROUP_NAME_MAX"
            placeholder="e.g. Star Rupture"
            autocomplete="off"
            :aria-invalid="touched.groupName && !!stepError('group', 'name')"
            aria-describedby="wz-group-name-err"
            @input="touched.groupName = true"
          />
          <p id="wz-group-name-err" class="wf-err" role="status">{{ touched.groupName ? stepError('group', 'name') : '' }}</p>
        </div>

        <fieldset v-else-if="step.id === 'pages'" class="wf">
          <legend class="wf-label">Move pages into it <span class="wf-opt-note">(optional)</span></legend>
          <div class="wf-list">
            <label v-for="p in candidates" :key="p.id" class="nav-row wf-opt">
              <input type="checkbox" class="wf-check" :checked="group.pageIds.includes(p.id)" @change="togglePage(p.id, ($event.target as HTMLInputElement).checked)" />
              <PageIcon :page="p" :pages="pages" />
              <span class="nm">{{ p.name }}</span>
              <span class="meta">{{ p.group }}</span>
            </label>
          </div>
          <p class="wf-hint">A page's drill pages move with it. ★ Overview stays pinned.</p>
        </fieldset>

        <div v-else-if="step.id === 'review'" class="wf">
          <div class="wf-review">
            <GroupBadge :name="newGroupName || '?'" :meta="undefined" />
            <b>{{ newGroupName }}</b>
          </div>
          <p v-if="!picked.length" class="wf-hint">An empty group. Add pages to it later with a page's ⋯ → Move to group, or “+ New” → Page.</p>
          <template v-else>
            <p class="wf-hint">{{ picked.length }} page{{ picked.length === 1 ? '' : 's' }} move here:</p>
            <ul class="wf-moves">
              <li v-for="p in picked" :key="p.id">
                <PageIcon :page="p" :pages="pages" />
                <span>{{ p.name }}</span>
                <span class="meta">from {{ p.group }}</span>
              </li>
            </ul>
          </template>
        </div>
      </template>
    </template>
  </WizardCarousel>
</template>

<style scoped>
.wf {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 0;
  padding: 0;
  border: none;
  min-width: 0;
}
.wf-set {
  margin: 0;
  padding: 0;
  border: none;
  min-width: 0;
}
.wf-label {
  padding: 0;
  font: 600 11.5px Inter, system-ui, sans-serif;
  color: rgb(var(--ink-2));
}
.wf-input {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 9px;
  border: 1px solid rgb(var(--line-2));
  border-radius: 8px;
  background: rgb(var(--surface));
  color: rgb(var(--ink));
  font: 14px Inter, system-ui, sans-serif;
}
.wf-input:focus {
  outline: none;
  border-color: rgb(var(--amber));
  box-shadow: 0 0 0 3px rgb(var(--amber) / 0.2);
}
.wf-input[aria-invalid='true'] {
  border-color: #bc4749;
}
.wf-err {
  min-height: 1.2em;
  margin: 0;
  font-size: 11.5px;
  color: #bc4749;
}
.wf-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.wf-opt {
  cursor: pointer;
}
.wf-opt:focus-within {
  background: rgb(var(--sunken));
  box-shadow: inset 0 0 0 2px rgb(var(--amber) / 0.55);
}
.wf-radio {
  width: 14px;
  height: 14px;
  flex: none;
  border: 1.5px solid rgb(var(--line-2));
  border-radius: 50%;
}
.wf-radio.on {
  border-color: rgb(var(--amber));
  background: radial-gradient(circle, rgb(var(--amber)) 0 3.5px, transparent 4px);
}
.wf-plus {
  width: 20px;
  text-align: center;
  color: rgb(var(--ink-3));
  font-weight: 600;
}
.wf-sub {
  padding: 6px 9px 2px;
  font: 600 10.5px Inter, system-ui, sans-serif;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: rgb(var(--ink-3));
}
.wf-check {
  margin: 0;
  accent-color: rgb(var(--amber));
}
.wf-hint {
  margin: 2px 0 0;
  font-size: 12px;
  color: rgb(var(--ink-3));
  white-space: normal;
}
.wf-opt-note {
  font-weight: 400;
  color: rgb(var(--ink-3));
}
.wf-icon {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.wf-icon-now {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: rgb(var(--ink));
}
.wf-mini {
  padding: 4px 9px;
  font-size: 12px;
}
.wf-review {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.wf-moves {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.wf-moves li {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wf-moves .meta {
  color: rgb(var(--ink-3));
  font-size: 11.5px;
}
</style>
