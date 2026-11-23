<script setup lang="ts">
// The search, filter and sort bar directly above the Budget Transactions table. It only edits a `TxnViewPrefs`
// (lib/budget/txnView.ts) and shows "N of M transactions"; BudgetTable applies it to the rows it has loaded, and the
// owner remembers it per login (lib/budget/txnPrefsStore.ts). It never changes the pies or totals.
// Props: modelValue (the prefs), rows (what the table has loaded: the choices come from them), categories, accounts,
// people, shown (rows after the toolbar), bounds (the page's period: the date inputs stay inside it).
// Emits: update:modelValue (a whole new prefs object).
// Wide screens: search, five filters and the sort sit on one wrapping row. Phone (<= 700 px): the search field stays, and
// the filters and sort sit behind one "Filters" button (a count shows how many are on).
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Account, Category, Person, Txn } from '../../lib/budget/types'
import {
  TXN_SORT_KEYS, SEARCH_MAX, accountChoices, anythingActive, categoryChoices, defaultTxnViewPrefs, filtersActive, merchantChoices, personChoices, sortChanged,
  type Choice, type TxnSortKey, type TxnViewPrefs,
} from '../../lib/budget/txnView'

const props = defineProps<{
  modelValue: TxnViewPrefs
  rows: Txn[]
  categories: Category[]
  accounts: Account[]
  people: Person[]
  shown: number
  bounds?: { from: string; to: string }
}>()
const emit = defineEmits<{ 'update:modelValue': [p: TxnViewPrefs] }>()

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
  emit('update:modelValue', defaultTxnViewPrefs())
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

function buttonText(l: { key: ListKey; label: string }): string {
  const n = props.modelValue[l.key].length
  return n ? `${l.label} · ${n}` : l.label
}

// One dropdown open at a time; a tap outside or Escape closes it.
const open = ref<ListKey | null>(null)
const panelOpen = ref(false)
const root = ref<HTMLElement | null>(null)
function onDocPointer(e: Event) {
  if (open.value && !(e.target as Element | null)?.closest?.('.tt-dd')) open.value = null
}
function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = null
}
watch(
  open,
  (o) => {
    if (o) {
      document.addEventListener('pointerdown', onDocPointer, true)
      document.addEventListener('keydown', onDocKey)
    } else {
      document.removeEventListener('pointerdown', onDocPointer, true)
      document.removeEventListener('keydown', onDocKey)
    }
  },
)
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer, true)
  document.removeEventListener('keydown', onDocKey)
})
</script>

<template>
  <div ref="root" class="txn-toolbar" role="search" aria-label="Search and filter transactions" data-testid="txn-toolbar">
    <div class="tt-top">
      <input
        v-model="search"
        type="search"
        class="tt-search"
        placeholder="Search merchant, description or note"
        aria-label="Search transactions"
        :maxlength="SEARCH_MAX"
        autocomplete="off"
        data-testid="txn-search"
      />
      <button
        type="button"
        class="tt-toggle"
        :aria-expanded="panelOpen"
        aria-controls="txn-tt-panel"
        data-testid="txn-filters-toggle"
        @click="panelOpen = !panelOpen"
      >Filters{{ activeCount ? ` · ${activeCount}` : '' }}</button>
    </div>
    <div id="txn-tt-panel" class="tt-panel" :class="{ shown: panelOpen }">
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
    <p class="tt-count" aria-live="polite" data-testid="txn-count">
      <span>{{ shown }} of {{ total }} transaction{{ total === 1 ? '' : 's' }}</span>
      <button v-if="active" type="button" class="tt-clear" data-testid="txn-clear" @click="clearAll">Clear</button>
      <span v-if="filtersActive(modelValue)" class="tt-note">(of those loaded)</span>
    </p>
  </div>
</template>

<style scoped>
.txn-toolbar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0 0 8px;
  width: 100%;
}
.tt-top {
  display: flex;
  gap: 8px;
}
.tt-search,
.tt-select,
.tt-date,
.tt-btn,
.tt-toggle {
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
  flex: 1 1 auto;
  min-width: 0;
}
.tt-toggle {
  display: none;
}
.tt-panel {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.tt-dd {
  position: relative;
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
.tt-pop {
  position: absolute;
  z-index: 20;
  top: calc(100% + 4px);
  left: 0;
  min-width: 220px;
  max-width: 320px;
  max-height: 260px;
  overflow-y: auto;
  padding: 6px;
  border: 1px solid rgb(var(--line-2));
  border-radius: 9px;
  background: rgb(var(--surface));
  box-shadow: 0 6px 20px rgb(0 0 0 / 0.18);
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
  align-items: center;
  gap: 6px;
}
.tt-label {
  font-size: 12px;
  color: rgb(var(--ink-3));
}
.tt-count {
  display: flex;
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
.tt-clear:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: 1px;
}
@media (max-width: 700px) {
  .tt-search,
  .tt-select,
  .tt-date,
  .tt-btn,
  .tt-toggle {
    min-height: 44px;
    font-size: 16px;
  }
  .tt-toggle {
    display: inline-block;
    flex: 0 0 auto;
  }
  .tt-panel {
    display: none;
  }
  .tt-panel.shown {
    display: flex;
  }
  .tt-dd {
    flex: 1 1 45%;
  }
  .tt-dd .tt-btn {
    width: 100%;
    text-align: left;
  }
  .tt-pop {
    position: static;
    max-width: none;
    margin-top: 4px;
    box-shadow: none;
  }
  .tt-dates,
  .tt-sort {
    flex: 1 1 100%;
  }
  .tt-date,
  .tt-select {
    flex: 1 1 auto;
    min-width: 0;
  }
}
</style>
