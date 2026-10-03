<script setup lang="ts">
// "Change icon…": pick one of the curated icons (lib/icons.ts PICKER_ICONS, by category), or Auto —
// which shows what the page would resolve to on its own (from its charts, or its page for a drill
// page). A modal dialog: focus moves in (the search box), Tab stays inside, Esc cancels, and focus
// goes back to `returnTo` (what opened it) on close.
import { computed, nextTick, ref, watch } from 'vue'
import type { DashboardPage } from '../../types'
import { ICONS, ICON_CATEGORIES, PICKER_ICONS, autoIcon, iconLabel, isIconKey, type IconKey } from '../../lib/icons'
import { CheckIcon, CloseIcon, SearchIcon, SparklesIcon } from '../../lib/icons'

const props = defineProps<{ open: boolean; page: DashboardPage | null; pages: DashboardPage[]; returnTo?: HTMLElement | null }>()
const emit = defineEmits<{ close: []; pick: [key: IconKey | null] }>()

const query = ref('')
const panel = ref<HTMLElement | null>(null)
const search = ref<HTMLInputElement | null>(null)
let returnFocus: HTMLElement | null = null

watch(
  () => props.open,
  async (open) => {
    if (open) {
      returnFocus = props.returnTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      query.value = ''
      await nextTick()
      search.value?.focus()
    } else {
      const el = returnFocus
      returnFocus = null
      await nextTick()
      if (el?.isConnected) el.focus()
    }
  },
  { immediate: true },
)

const current = computed<IconKey | null>(() => (props.page?.icon && isIconKey(props.page.icon) ? props.page.icon : null))
const auto = computed(() => (props.page ? autoIcon(props.page, props.pages) : null))
const autoText = computed(() => {
  const a = auto.value
  if (!a) return ''
  const what = iconLabel(a.key).toLowerCase()
  if (a.source === 'inherited') return `Follows ${a.from?.name ?? 'its page'}: ${what}`
  if (a.source === 'charts') return `Would resolve to ${what}, from ${a.dataset} charts`
  return `Would be the generic page icon`
})
const matches = computed(() => {
  const q = query.value.trim().toLowerCase()
  return q ? PICKER_ICONS.filter((i) => `${i.key} ${i.label} ${i.keywords} ${i.category}`.toLowerCase().includes(q)) : PICKER_ICONS
})
const byCategory = computed(() => ICON_CATEGORIES.map((c) => ({ c, icons: matches.value.filter((i) => i.category === c) })).filter((x) => x.icons.length))

function focusables(): HTMLElement[] {
  return panel.value ? Array.from(panel.value.querySelectorAll<HTMLElement>('input, button:not([disabled])')) : []
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
</script>

<template>
  <Teleport to="body">
    <template v-if="open && page">
      <div class="ip-scrim" aria-hidden="true" @click="emit('close')"></div>
      <div ref="panel" class="ip-panel" role="dialog" aria-modal="true" :aria-label="`Icon for ${page.name}`" @keydown="onKeydown">
        <div class="ip-head">
          <h2>Icon for {{ page.name }}</h2>
          <span class="ip-count" aria-live="polite">Showing {{ matches.length }} of {{ PICKER_ICONS.length }}</span>
        </div>
        <label class="ip-search">
          <SearchIcon :size="14" aria-hidden="true" />
          <input ref="search" v-model="query" type="text" placeholder="Search icons" aria-label="Search icons" autocomplete="off" spellcheck="false" />
        </label>
        <button type="button" class="ip-auto" :aria-pressed="current === null" @click="emit('pick', null)">
          <SparklesIcon :size="16" aria-hidden="true" />
          <span class="t">
            <b>Auto (from charts)</b>
            <small>
              {{ autoText }}
              <component :is="ICONS[auto!.key]" v-if="auto" :size="13" class="inline" aria-hidden="true" />
            </small>
          </span>
          <CheckIcon v-if="current === null" class="ck" :size="16" aria-hidden="true" />
        </button>
        <div class="ip-cats">
          <section v-for="cat in byCategory" :key="cat.c" class="ip-cat">
            <h3>{{ cat.c }}</h3>
            <div class="ip-grid">
              <button
                v-for="i in cat.icons"
                :key="i.key"
                type="button"
                class="ip-icon"
                :class="{ sel: i.key === current }"
                :aria-pressed="i.key === current"
                :aria-label="i.label"
                :title="i.label"
                @click="emit('pick', i.key)"
              >
                <component :is="ICONS[i.key]" :size="20" aria-hidden="true" />
              </button>
            </div>
          </section>
          <p v-if="!byCategory.length" class="ip-none">No icon matches “{{ query }}”.</p>
        </div>
        <div class="ip-foot">
          <span>Drill pages follow their page unless you pick one.</span>
          <button type="button" class="btn" @click="emit('close')"><CloseIcon :size="14" aria-hidden="true" />Cancel</button>
        </div>
      </div>
    </template>
  </Teleport>
</template>

<style scoped>
.ip-scrim {
  position: fixed;
  inset: 0;
  z-index: 1490;
  background: rgb(var(--scrim) / 0.32);
}
.ip-panel {
  position: fixed;
  z-index: 1500;
  left: 50%;
  top: 50%;
  translate: -50% -50%;
  width: min(440px, calc(100vw - 24px));
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line-2));
  border-radius: 14px;
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.16);
  overflow: hidden;
}
.ip-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px 8px;
}
.ip-head h2 {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0;
}
.ip-count {
  font-size: 12px;
  color: rgb(var(--ink-3));
}
.ip-search {
  margin: 0 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid rgb(var(--line-2));
  border-radius: 9px;
  padding: 0 10px;
  color: rgb(var(--ink-3));
  background: rgb(var(--canvas));
}
.ip-search:focus-within {
  border-color: rgb(var(--amber));
}
.ip-search input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  padding: 7px 0;
}
.ip-search input:focus {
  outline: none;
}
.ip-auto {
  margin: 10px 14px 4px;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid rgb(var(--line-2));
  background: rgb(var(--canvas));
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 13px;
  color: rgb(var(--ink));
  text-align: left;
}
.ip-auto[aria-pressed='true'] {
  border-color: rgb(var(--amber));
}
.ip-auto:focus-visible,
.ip-icon:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: 1px;
}
.ip-auto .t {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
  min-width: 0;
}
.ip-auto small {
  color: rgb(var(--ink-2));
  font-size: 11.5px;
}
.ip-auto .inline {
  vertical-align: -2px;
}
.ip-auto .ck {
  margin-left: auto;
  color: rgb(var(--amber-hover));
}
.ip-cats {
  overflow-y: auto;
  padding-bottom: 4px;
}
.ip-cat {
  padding: 8px 14px 0;
}
.ip-cat h3 {
  margin: 0 0 4px;
  font: 600 10.5px Inter, system-ui, sans-serif;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: rgb(var(--ink-3));
}
.ip-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, 40px);
  gap: 4px;
}
.ip-icon {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: rgb(var(--ink-2));
}
.ip-icon:hover {
  background: rgb(var(--sunken));
  color: rgb(var(--ink));
}
.ip-icon.sel {
  background: rgb(var(--amber-tint));
  color: rgb(var(--ink));
  box-shadow: inset 0 0 0 1.5px rgb(var(--amber));
}
.ip-none {
  padding: 12px 14px;
  margin: 0;
  color: rgb(var(--ink-3));
  font-size: 13px;
}
.ip-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  margin-top: 6px;
  border-top: 1px solid rgb(var(--line));
  font-size: 12px;
  color: rgb(var(--ink-3));
}
</style>
