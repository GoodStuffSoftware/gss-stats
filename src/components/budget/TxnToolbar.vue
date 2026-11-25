<script setup lang="ts">
// The search, filter and sort bar directly above the Budget Transactions table. It only edits a `TxnViewPrefs`
// (lib/budget/txnView.ts) and shows "N of M transactions"; BudgetTable applies it to the rows it has loaded, and the
// owner remembers it per login (lib/budget/txnPrefsStore.ts). It never changes the pies or totals.
// Props: modelValue (the prefs), rows (what the table has loaded: the choices come from them), categories, accounts,
// people, shown (rows after the toolbar), bounds (the page's period: the date inputs stay inside it).
// Emits: update:modelValue (a whole new prefs object).
// The row is ONE line at every width: [lead] [search] [Filters]. It measures its own width (ResizeObserver) and folds, in
// order (lib/budget/toolbarFold.ts): the lead (slot `lead`, the Cards | Table switch; it gets `collapsed` so it can fold into
// one dropdown), then the search into an icon button that pops its field out under the row. The Filters button (a count shows
// how many are on) always stays; its panel (the filter lists, dates, sort, "N of M" and Clear) is a pop-out, never in the row.
// Escape or a tap outside closes a pop-out and Escape returns focus to the button that opened it.
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, useSlots, watch } from 'vue'
import type { Account, Category, Person, Txn } from '../../lib/budget/types'
import {
  TXN_SORT_KEYS, SEARCH_MAX, accountChoices, anythingActive, categoryChoices, defaultTxnViewPrefs, merchantChoices, personChoices, sortChanged,
  type Choice, type TxnSortKey, type TxnViewPrefs,
} from '../../lib/budget/txnView'
import { foldLevel, type FoldLevel } from '../../lib/budget/toolbarFold'
import { useFlyout } from '../ui/useFlyout'

const props = defineProps<{
  modelValue: TxnViewPrefs
  rows: Txn[]
  categories: Category[]
  accounts: Account[]
  people: Person[]
  shown: number
  /** More pages of the period are still to come (loading, or stopped on an error). */
  partial?: boolean
  bounds?: { from: string; to: string }
}>()
const emit = defineEmits<{ 'update:modelValue': [p: TxnViewPrefs] }>()
const slots = useSlots()

const SORT_LABELS: Record<TxnSortKey, string> = { date: 'Date', merchant: 'Merchant', category: 'Category', account: 'Account', amount: 'Amount' }

type ListKey = 'merchants' | 'categories' | 'accounts' | 'people'
const ctx = computed(() => ({ categories: props.categories, accounts: props.accounts }))
const lists = computed<{ key: ListKey; label: string; choices: Choice[] }[]>(() => [
  { key: 'merchants', label: 'Merchant', choices: merchantChoices(props.rows) },
  { key: 'categories', label: 'Category', choices: categoryChoices(props.rows, ctx.value) },
  { key: 'accounts', label: 'Account', choices: accountChoices(props.rows, ctx.value) },
  { key: 'people', label: 'Person', choices: personChoices(props.rows, ctx.value, props.people) },
])

function set(patch: Partial<TxnViewPrefs>) {
  emit('update:modelValue', { ...props.modelValue, ...patch })
}
function toggle(key: ListKey, value: string) {
  const cur = props.modelValue[key]
  set({ [key]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] } as Partial<TxnViewPrefs>)
}
function clearAll() {
  open.value = null
  emit('update:modelValue', { ...defaultTxnViewPrefs(), sameAmount: props.modelValue.sameAmount })
}

// Typing is reflected at once (the table narrows as you type).
const search = computed({
  get: () => props.modelValue.search,
  set: (v: string) => set({ search: v.slice(0, SEARCH_MAX) }),
})

const activeCount = computed(() => {
  const p = props.modelValue
  return [p.merchants.length > 0, p.categories.length > 0, p.accounts.length > 0, p.people.length > 0, !!(p.from || p.to), sortChanged(p)].filter(Boolean).length
})
const total = computed(() => props.rows.length)
const active = computed(() => anythingActive(props.modelValue))
const countText = computed(() => `${props.shown} of ${total.value} transaction${total.value === 1 ? '' : 's'}`)

function buttonText(l: { key: ListKey; label: string }): string {
  const n = props.modelValue[l.key].length
  return n ? `${l.label} · ${n}` : l.label
}

// ---- Fit: how much of the row is folded, from the measured width of the toolbar and of its controls. -----------------
const GAP = 8
const SEARCH_MIN = 120 // the least width the inline search field is worth showing at
const LEAD_GUESS = 124 // until the real widths are measured (the Cards | Table switch inline, and folded)
const LEAD_FOLDED_GUESS = 76
const root = ref<HTMLElement | null>(null)
const rowEl = ref<HTMLElement | null>(null)
const leadEl = ref<HTMLElement | null>(null)
const toggleEl = ref<HTMLElement | null>(null)
const level = ref<FoldLevel>(0)
const rootWidth = ref(0)
const seen = { lead: 0, leadFolded: 0 } // the lead's width in each form, remembered once it has been drawn that way
function measure() {
  const el = root.value
  if (!el) return
  const avail = el.clientWidth
  rootWidth.value = avail
  if (avail <= 0) return // not laid out (hidden, or no layout engine): leave the row as it is
  const lead = leadEl.value
  if (lead && lead.offsetWidth > 0) {
    if (level.value === 0) seen.lead = lead.offsetWidth
    else seen.leadFolded = lead.offsetWidth
  }
  const next = foldLevel(avail, {
    lead: lead ? seen.lead || LEAD_GUESS : 0,
    leadFolded: lead ? seen.leadFolded || LEAD_FOLDED_GUESS : 0,
    searchMin: SEARCH_MIN,
    filters: toggleEl.value?.offsetWidth || 90,
    gap: GAP,
  })
  if (next !== level.value) level.value = next
}
let ro: ResizeObserver | null = null
onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && root.value) {
    ro = new ResizeObserver(() => measure())
    ro.observe(root.value)
  }
})
onUpdated(measure) // the Filters label (a count) or the lead slot changed
watch(level, () => nextTick(measure)) // measure the lead in its new form
watch(() => !!slots.lead, () => {
  seen.lead = 0
  seen.leadFolded = 0
})
const placeholder = computed(() => (level.value >= 1 || (rootWidth.value > 0 && rootWidth.value < 480) ? 'Search' : 'Search transactions'))

// ---- Pop-outs: the Filters panel, the folded search field, one filter list inside the panel. One open at a time. --------
const open = ref<ListKey | null>(null)
const panelOpen = ref(false)
const searchOpen = ref(false)
const searchBtn = ref<HTMLElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const { style: panelStyle } = useFlyout(rowEl, panelOpen, { maxWidth: 544, align: 'end' })
const { style: searchStyle } = useFlyout(rowEl, searchOpen)
const searchFolded = computed(() => level.value >= 2)
watch(searchFolded, (f) => {
  if (!f) searchOpen.value = false
})

function togglePanel() {
  panelOpen.value = !panelOpen.value
  if (panelOpen.value) searchOpen.value = false
  else open.value = null
}
async function toggleSearch() {
  searchOpen.value = !searchOpen.value
  if (!searchOpen.value) return
  panelOpen.value = false
  open.value = null
  await nextTick()
  searchInput.value?.focus()
}
function closeSearch(refocus: boolean) {
  searchOpen.value = false
  if (refocus) searchBtn.value?.focus()
}

const anyOpen = computed(() => !!open.value || panelOpen.value || searchOpen.value)
function onDocPointer(e: Event) {
  const t = e.target as Element | null
  if (open.value && !t?.closest?.('.tt-dd')) open.value = null
  if (!root.value?.contains(t)) {
    panelOpen.value = false
    searchOpen.value = false
  }
}
function onDocKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (open.value) {
    const key = open.value
    open.value = null
    root.value?.querySelector<HTMLElement>(`[data-testid="txn-filter-${key}"]`)?.focus()
  } else if (panelOpen.value) {
    panelOpen.value = false
    toggleEl.value?.focus()
  } else if (searchOpen.value) {
    closeSearch(true)
  }
}
watch(anyOpen, (o) => {
  if (o) {
    document.addEventListener('pointerdown', onDocPointer, true)
    document.addEventListener('keydown', onDocKey)
  } else {
    document.removeEventListener('pointerdown', onDocPointer, true)
    document.removeEventListener('keydown', onDocKey)
  }
})
onBeforeUnmount(() => {
  ro?.disconnect()
  document.removeEventListener('pointerdown', onDocPointer, true)
  document.removeEventListener('keydown', onDocKey)
})
</script>

<template>
  <div ref="root" class="txn-toolbar" role="search" aria-label="Search and filter transactions" data-testid="txn-toolbar">
    <div ref="rowEl" class="tt-top">
      <div v-if="$slots.lead" ref="leadEl" class="tt-lead"><slot name="lead" :collapsed="level >= 1" /></div>
      <input
        v-if="!searchFolded"
        v-model="search"
        type="search"
        class="tt-search"
        :placeholder="placeholder"
        aria-label="Search transactions"
        :maxlength="SEARCH_MAX"
        autocomplete="off"
        data-testid="txn-search"
      />
      <button
        v-else
        ref="searchBtn"
        type="button"
        class="tt-icon"
        :class="{ 'tt-icon-on': !!search }"
        :aria-expanded="searchOpen"
        aria-controls="txn-tt-search"
        :aria-label="search ? 'Search transactions (a search is on)' : 'Search transactions'"
        :title="search ? `Searching for “${search}”` : 'Search transactions'"
        data-testid="txn-search-toggle"
        @click="toggleSearch"
      >
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
          <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="2" />
          <path d="M13 13l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
        <span v-if="search" class="tt-dot" aria-hidden="true" />
      </button>
      <button
        ref="toggleEl"
        type="button"
        class="tt-toggle"
        :class="{ 'tt-toggle-on': activeCount > 0 }"
        :aria-expanded="panelOpen"
        aria-controls="txn-tt-panel"
        :title="countText"
        data-testid="txn-filters-toggle"
        @click="togglePanel"
      >Filters{{ activeCount ? ` · ${activeCount}` : '' }}</button>
    </div>
    <!-- The count is announced whether or not the panel is open; the visible copy lives inside the panel. -->
    <p class="tt-live" aria-live="polite" data-testid="txn-count">{{ countText }}<template v-if="partial && active"> (loading the rest of the period…)</template></p>
    <div v-if="searchFolded && searchOpen" id="txn-tt-search" class="tt-flyout tt-flyout-search" :style="searchStyle" role="group" aria-label="Search transactions" data-testid="txn-search-pop">
      <input
        ref="searchInput"
        v-model="search"
        type="search"
        class="tt-search"
        placeholder="Search transactions"
        aria-label="Search transactions"
        :maxlength="SEARCH_MAX"
        autocomplete="off"
        data-testid="txn-search"
        @keydown.enter.prevent="closeSearch(true)"
      />
    </div>
    <div v-show="panelOpen" id="txn-tt-panel" class="tt-flyout tt-panel" :style="panelStyle" role="group" aria-label="Filters and sort">
      <p class="tt-count" data-testid="txn-count-panel">
        <span aria-hidden="true">{{ countText }}</span>
        <button v-if="active" type="button" class="tt-clear" data-testid="txn-clear" @click="clearAll">Clear</button>
        <span v-if="partial && active" class="tt-note" aria-hidden="true">(loading the rest of the period…)</span>
      </p>
      <div v-for="l in lists" :key="l.key" class="tt-dd" :class="{ on: modelValue[l.key].length > 0 }">
        <button
          type="button"
          class="tt-btn"
          :aria-expanded="open === l.key"
          aria-haspopup="true"
          :data-testid="`txn-filter-${l.key}`"
          @click="open = open === l.key ? null : l.key"
        >{{ buttonText(l) }}<span aria-hidden="true" class="tt-caret">▾</span></button>
        <div v-if="open === l.key" class="tt-pop" role="group" :aria-label="`${l.label} filter`">
          <p v-if="!l.choices.length" class="tt-none">Nothing to choose from here.</p>
          <label v-for="c in l.choices" :key="c.value" class="tt-opt">
            <input type="checkbox" :checked="modelValue[l.key].includes(c.value)" :data-testid="`txn-opt-${l.key}`" @change="toggle(l.key, c.value)" />
            <span>{{ c.label }}</span>
          </label>
        </div>
      </div>
      <span class="tt-dates">
        <input
          type="date"
          class="tt-date"
          :value="modelValue.from"
          :min="bounds?.from"
          :max="modelValue.to || bounds?.to"
          aria-label="From date"
          data-testid="txn-from"
          @change="set({ from: ($event.target as HTMLInputElement).value })"
        />
        <span aria-hidden="true">–</span>
        <input
          type="date"
          class="tt-date"
          :value="modelValue.to"
          :min="modelValue.from || bounds?.from"
          :max="bounds?.to"
          aria-label="To date"
          data-testid="txn-to"
          @change="set({ to: ($event.target as HTMLInputElement).value })"
        />
      </span>
      <span class="tt-sort">
        <label class="tt-label" for="txn-sort">Sort</label>
        <select id="txn-sort" class="tt-select" :value="modelValue.sortKey" data-testid="txn-sort" @change="set({ sortKey: ($event.target as HTMLSelectElement).value as TxnSortKey })">
          <option v-for="k in TXN_SORT_KEYS" :key="k" :value="k">{{ SORT_LABELS[k] }}</option>
        </select>
        <button
          type="button"
          class="tt-btn tt-dir"
          :aria-label="modelValue.sortDir === 'asc' ? 'Ascending, switch to descending' : 'Descending, switch to ascending'"
          data-testid="txn-sort-dir"
          @click="set({ sortDir: modelValue.sortDir === 'asc' ? 'desc' : 'asc' })"
        >{{ modelValue.sortDir === 'asc' ? '↑ Asc' : '↓ Desc' }}</button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.txn-toolbar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0 0 8px;
  width: 100%;
  min-width: 0;
}
/* The row: never wraps, never wider than the toolbar; the controls give way (see the script) before they would overflow. */
.tt-top {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.tt-lead {
  display: flex;
  flex: 0 1 auto;
  min-width: 0;
}
.tt-search,
.tt-select,
.tt-date,
.tt-btn,
.tt-toggle,
.tt-icon {
  min-height: 36px;
  padding: 4px 10px;
  border: 1px solid rgb(var(--line-2));
  border-radius: 9px;
  background: rgb(var(--surface));
  color: rgb(var(--ink));
  font: inherit;
  font-size: 13px;
}
.tt-search {
  flex: 1 1 0;
  min-width: 0;
}
.tt-toggle {
  flex: 0 0 auto;
  cursor: pointer;
  white-space: nowrap;
}
.tt-toggle-on,
.tt-icon-on {
  border-color: rgb(var(--amber));
}
.tt-icon {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 40px;
  padding: 0;
  cursor: pointer;
}
.tt-icon-on {
  color: rgb(var(--amber));
}
.tt-dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgb(var(--amber));
}
/* Read by a screen reader whether or not the panel is open; never display:none. */
.tt-live {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
/* A pop-out under (or, with no room below, over) the row: placed by useFlyout (fixed, so no card clips it) and scrolling inside itself. */
.tt-flyout {
  z-index: 30;
  box-sizing: border-box;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px;
  border: 1px solid rgb(var(--line-2));
  border-radius: 9px;
  background: rgb(var(--surface));
  box-shadow: 0 6px 20px rgb(0 0 0 / 0.18);
}
.tt-flyout-search {
  display: flex;
}
.tt-panel {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start; /* an open filter list grows its own cell; the buttons beside it stay at the top */
  gap: 8px;
}
.tt-dd {
  flex: 1 1 45%;
  min-width: 0;
}
.tt-dd .tt-btn {
  width: 100%;
  text-align: left;
}
.tt-btn {
  cursor: pointer;
  white-space: nowrap;
}
.tt-dd.on .tt-btn {
  border-color: rgb(var(--amber));
  color: rgb(var(--amber));
}
.tt-caret {
  margin-left: 6px;
  font-size: 11px;
}
/* A filter list opens in place inside the panel (the panel scrolls, so nothing here is clipped). */
.tt-pop {
  max-height: 200px;
  margin-top: 4px;
  overflow-y: auto;
  padding: 6px;
  border: 1px solid rgb(var(--line-2));
  border-radius: 9px;
  background: rgb(var(--surface));
}
.tt-opt {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px;
  font-size: 13px;
  cursor: pointer;
}
.tt-none {
  margin: 4px;
  font-size: 12px;
  color: rgb(var(--ink-3));
}
.tt-dates,
.tt-sort {
  display: inline-flex;
  flex: 1 1 100%;
  align-items: center;
  gap: 6px;
}
.tt-dates {
  flex-wrap: wrap; /* on a very narrow panel the To date drops under the From date instead of running off the edge */
}
.tt-date {
  flex: 1 1 140px;
  min-width: 0;
}
.tt-select {
  flex: 1 1 auto;
  min-width: 0;
}
.tt-label {
  font-size: 12px;
  color: rgb(var(--ink-3));
}
.tt-count {
  display: flex;
  flex: 1 1 100%;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 12px;
  color: rgb(var(--ink-3));
}
.tt-clear {
  border: 0;
  background: none;
  padding: 4px 6px;
  color: rgb(var(--amber));
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
}
.tt-note {
  opacity: 0.8;
}
.tt-search:focus-visible,
.tt-select:focus-visible,
.tt-date:focus-visible,
.tt-btn:focus-visible,
.tt-toggle:focus-visible,
.tt-icon:focus-visible,
.tt-clear:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: 1px;
}
@media (max-width: 700px) {
  /* The row itself stays 36px; the controls inside the opened panel keep 44px targets. */
  .tt-search {
    font-size: 16px; /* 16px stops the iOS focus zoom */
  }
  .tt-toggle {
    font-size: 14px;
  }
  .tt-flyout .tt-select,
  .tt-flyout .tt-date,
  .tt-flyout .tt-btn {
    min-height: 44px;
    font-size: 16px;
  }
  .tt-clear {
    padding: 10px 8px;
  }
}
</style>
