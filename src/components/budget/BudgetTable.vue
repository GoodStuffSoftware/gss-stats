<script setup lang="ts">
// The spreadsheet under the Budget pie: the transactions behind the current slice, with the category editable.
// Contract with BudgetSection (src/lib/budget/types.ts): it passes BudgetTableProps and listens for `edited`
// to refetch the pie once. This component fetches the pages itself (cursor paging, "Load more").
//
// - A new `query` starts over at the first page. So does a `refreshKey` change, except the one the parent makes in
//   answer to our own `edited` (that would wipe the "moved to X" notes and the rule offer).
// - An edit shows at once and is saved with PATCH (expectedUpdatedAt); a 409 or a failure puts the row back and says so.
// - The category list is searchable and offers `Add category "<text>"` (POST /categories, then the same edit); the new
//   category is reported up (`category-added`) so every list and the pie know it without a reload.
// - After a category change the row offers "Use for all <merchant>" (POST /rules).
// - Tapping (or clicking, or focusing by keyboard) the merchant opens a small tip with the full merchant text and the raw
//   statement description (what desktop hover shows through `title`). One tip at a time; a tap outside, a second tap on the
//   merchant, Escape, a scroll or a resize closes it. A tap on the merchant does nothing else (the row has no click gesture).
// - The Note column shows each row's note (clamped; the full text is in the merchant tip) and edits it in place (PATCH `note`).
// - `highlightId` scrolls to that row and marks it; when it is not on the loaded pages, more pages are loaded
//   (up to MAX_HIGHLIGHT_PAGES) to find it.
import { computed, nextTick, onMounted, watch } from 'vue'
import { useToggletip } from '../../composables/useToggletip'
import EditableTable from '../table/EditableTable.vue'
import CategorySelect from './CategorySelect.vue'
import { createCategory, createRule, fetchTxnPage, patchTxn } from '../../lib/budget/clientEdit'
import { budgetColumns, categoryOptions, createTxnTable, reviewReasonText, rowDotColor, selectValueFor, type TableDeps } from '../../lib/budget/tableModel'
import { SPENDING_KINDS, type BudgetEditedEvent, type BudgetTableProps, type Category, type Txn } from '../../lib/budget/types'

const props = defineProps<BudgetTableProps>()
const emit = defineEmits<{ edited: [e: BudgetEditedEvent]; 'category-added': [c: Category] }>()

const MAX_HIGHLIGHT_PAGES = 5
const deps: TableDeps = { fetchPage: fetchTxnPage, patch: patchTxn, createRule, createCategory }

let ownEdit = false
function onEdited(e: BudgetEditedEvent) {
  // The parent bumps refreshKey while it handles this event; the flag is cleared once that update has been rendered.
  ownEdit = true
  emit('edited', e)
  void nextTick(() => {
    ownEdit = false
  })
}

const model = createTxnTable(deps, () => props.categories, onEdited, (c) => emit('category-added', c))
const { rows, rowState, status, loading, loadingMore, loadError, nextCursor } = model

const columns = computed(() => budgetColumns(props.categories, props.accounts))

function reload() {
  void model.load(props.query)
}
// The query as a value, so a new object with the same contents does not restart paging.
watch(() => JSON.stringify(props.query), reload)
watch(
  () => props.refreshKey,
  () => {
    if (!ownEdit) reload()
  },
)
onMounted(reload)

// Find the highlighted purchase: it may be past the first page.
watch(
  [() => props.highlightId, rows, loading],
  async () => {
    const id = props.highlightId
    if (!id || loading.value) return
    let pages = 0
    while (!rows.value.some((r) => r.id === id) && nextCursor.value && !loadError.value && pages++ < MAX_HIGHLIGHT_PAGES) {
      await model.loadMore()
    }
  },
  { flush: 'post' },
)

function onEdit(rowKey: string, field: string, value: string) {
  if (field === 'category') void model.setSelection(rowKey, value)
  else if (field === 'note') void model.setNote(rowKey, value)
}
function onAction(rowKey: string, id: string) {
  if (id === 'rule') void model.useForAll(rowKey)
}

// The merchant tip and the note tip (toggletips: they open on tap or click, so touch has what hover gives a mouse). One
// implementation (useToggletip); each trigger names its own key.
type TipData = { kind: 'merchant'; name: string; description: string; note: string } | { kind: 'note'; note: string }
const { tip, close: closeTip, toggle, openOnKeyboardFocus } = useToggletip<TipData>('.bt-merchant, .et-hold, .bt-tip')
const merchantTip = (row: Txn): TipData => ({ kind: 'merchant', name: row.merchantName || row.description, description: row.description, note: row.note ?? '' })
const merchantKey = (row: Txn) => `merchant:${row.id}`
function toggleTip(row: Txn, e: Event) {
  toggle(merchantKey(row), merchantTip(row), e.currentTarget as HTMLElement)
}
function focusTip(row: Txn, e: FocusEvent) {
  openOnKeyboardFocus(merchantKey(row), merchantTip(row), e.currentTarget as HTMLElement)
}
// The note: a click or tap shows it in full (a row without one has nothing to show, so the table opens the editor), a hold
// edits it (EditableTable, `editGesture: 'hold'`). Editing starting closes the tip.
function onPeek(rowKey: string, field: string, el: HTMLElement, source: 'click' | 'focus') {
  if (field !== 'note') return
  const row = rows.value.find((r) => r.id === rowKey)
  if (!row?.note) return
  const key = `note:${rowKey}`
  const data: TipData = { kind: 'note', note: row.note }
  if (source === 'focus') openOnKeyboardFocus(key, data, el)
  else toggle(key, data, el)
}

const rowLabel = (t: Txn) => t.merchantName || t.description
const canExclude = (t: Txn) => SPENDING_KINDS.includes(t.kind) || t.included === false
</script>

<template>
  <section class="budget-table" aria-label="Transactions">
    <div v-if="loadError && !rows.length" class="bt-error" role="alert">
      <span>Couldn’t load transactions.</span>
      <button type="button" class="bt-btn" @click="reload">Retry</button>
    </div>
    <div v-else-if="loading && !rows.length" class="bt-skeleton" aria-hidden="true">
      <div v-for="n in 6" :key="n" class="bt-skel-row" />
    </div>
    <EditableTable
      v-else
      :columns="columns"
      :rows="rows"
      row-key="id"
      :editable="canEdit"
      layout="auto"
      :row-status="rowState"
      :highlight-key="highlightId ?? null"
      :status="status"
      :row-label="rowLabel"
      :loading="loading"
      label="Transactions"
      resizable
      storage-key="gss-stats-budget-txn-cols"
      @edit="onEdit"
      @action="onAction"
      @peek="onPeek"
      @edit-start="closeTip"
    >
      <template #cell-merchant="{ row }">
        <button
          type="button"
          class="bt-merchant"
          :title="row.description"
          :aria-expanded="tip?.key === merchantKey(row)"
          :aria-describedby="tip?.key === merchantKey(row) ? 'bt-tip' : undefined"
          data-testid="merchant-tip-toggle"
          @click="toggleTip(row, $event)"
          @focus="focusTip(row, $event)"
        >{{ row.merchantName || row.description }}</button>
        <span v-if="row.needsReview" class="bt-flags">
          <span class="bt-badge" :title="reviewReasonText(row.reviewReason) ?? 'Needs a look'">Review</span>
          <button
            v-if="canEdit"
            type="button"
            class="bt-confirm"
            title="Looks right"
            :aria-label="'Looks right: ' + rowLabel(row)"
            :disabled="!!rowState[row.id]?.pending"
            data-testid="review-confirm"
            @click="model.confirmReview(row.id)"
          >✓</button>
        </span>
        <span
          v-if="row.needsReview && reviewReasonText(row.reviewReason)"
          class="bt-reason"
          :title="reviewReasonText(row.reviewReason) ?? ''"
          data-testid="review-reason"
        >{{ reviewReasonText(row.reviewReason) }}</span>
      </template>
      <template #cell-note="{ row, cardLayout }">
        <!-- Clamped to a few lines; a click or tap shows the full text in a tip, a hold edits. A row without a note shows a
             faint "Add note" (desktop: on hover or focus; touch and phone cards: always, one small muted line); a click on it
             opens the editor. -->
        <span v-if="row.note" class="bt-note" :class="{ 'bt-note-card': cardLayout }" data-testid="row-note">{{ row.note }}</span>
        <span v-else class="bt-note-empty">Add note</span>
      </template>
      <template #cell-category="{ row }">
        <span class="bt-cat">
          <span class="bt-dot" :style="{ background: rowDotColor(categories, row) }" aria-hidden="true" />
          {{ categoryOptions(categories, row).find((o) => o.value === selectValueFor(row))?.label }}
        </span>
      </template>
      <template #editor-category="{ row, disabled, label, commit }">
        <CategorySelect
          :value="selectValueFor(row)"
          :options="categoryOptions(categories, row)"
          :color="rowDotColor(categories, row)"
          :label="label"
          :disabled="disabled"
          allow-add
          @change="commit"
          @add="(name: string) => model.addCategoryTo(row.id, name)"
        />
      </template>
      <template #cell-included="{ row }">
        <!-- Only spend, refund and fee rows are in the spending totals, so only they get the switch (a row already
             excluded keeps it, so a person can always turn it back on). -->
        <label
          v-if="canExclude(row)"
          class="bt-included"
          :class="{ 'bt-excluded': row.included === false }"
          title="Count in totals"
          @click.stop
          @pointerdown.stop
          @touchstart.stop
          @contextmenu.stop
        >
          <input
            type="checkbox"
            :checked="row.included !== false"
            :disabled="!canEdit || !!rowState[row.id]?.pending"
            :aria-label="'Count in totals: ' + rowLabel(row)"
            data-testid="included-toggle"
            @change="model.setIncluded(row.id, ($event.target as HTMLInputElement).checked)"
          />
        </label>
      </template>
      <template #empty>No transactions in this view.</template>
      <template #footer>
        <div v-if="loadError && rows.length" class="bt-error" role="alert">
          <span>Couldn’t load more.</span>
          <button type="button" class="bt-btn" @click="model.loadMore()">Retry</button>
        </div>
        <div v-else-if="nextCursor" class="bt-more">
          <button type="button" class="bt-btn" :disabled="loadingMore" @click="model.loadMore()">
            {{ loadingMore ? 'Loading…' : 'Load more' }}
          </button>
        </div>
      </template>
    </EditableTable>
    <div v-if="tip" id="bt-tip" class="bt-tip" role="tooltip" :style="tip.style" data-testid="merchant-tip">
      <template v-if="tip.data.kind === 'merchant'">
        <span class="bt-tip-name">{{ tip.data.name }}</span>
        <span v-if="tip.data.description && tip.data.description !== tip.data.name" class="bt-tip-desc" data-testid="merchant-tip-desc">{{ tip.data.description }}</span>
        <span v-if="tip.data.note" class="bt-tip-note" data-testid="merchant-tip-note">{{ tip.data.note }}</span>
      </template>
      <span v-else class="bt-tip-fullnote" data-testid="note-tip">{{ tip.data.note }}</span>
    </div>
  </section>
</template>

<style scoped>
.budget-table {
  min-width: 0;
}
.bt-merchant {
  max-width: 100%;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: inherit;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bt-merchant:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: 2px;
}
.bt-tip {
  position: fixed;
  z-index: 50;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgb(var(--line-2));
  background: rgb(var(--surface));
  color: rgb(var(--ink));
  box-shadow: 0 4px 16px rgb(0 0 0 / 0.18);
  font-size: 13px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.bt-tip-desc {
  font-size: 12px;
  color: rgb(var(--ink-2));
}
.bt-tip-note {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid rgb(var(--line-2));
  white-space: pre-wrap;
}
/* Long notes wrap and stop at three lines (two on the wide table); the merchant tip has the whole text. */
.bt-note {
  display: -webkit-box;
  max-width: 60ch;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.35;
  color: rgb(var(--ink-2));
}
.bt-note-card {
  -webkit-line-clamp: 3;
  line-clamp: 3;
  font-size: 13px;
}
.bt-note-empty {
  font-size: 12px;
  color: rgb(var(--ink-2));
  opacity: 0;
}
tr:hover .bt-note-empty,
.et-text-btn:focus-visible .bt-note-empty {
  opacity: 1;
}
/* No hover on touch: the prompt stays visible, and on the phone cards it is one compact line, not a 44px field. */
@media (hover: none) {
  .bt-note-empty {
    opacity: 1;
  }
}
.budget-table :deep(.et-cards .et-text-btn:has(.bt-note-empty)) {
  width: auto;
  min-height: 32px;
  padding: 0 4px;
}
.budget-table :deep(.et-cards .bt-note-empty) {
  opacity: 1;
  font-size: 13px;
}
.bt-tip-fullnote {
  white-space: pre-wrap;
}
.bt-reason {
  display: block;
  max-width: 48ch;
  margin-top: 1px;
  font-size: 11px;
  line-height: 1.3;
  font-style: italic;
  color: rgb(var(--ink-2));
}
.bt-flags {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
}
.bt-confirm {
  margin-left: 6px;
  min-width: 28px;
  height: 28px;
  padding: 0;
  vertical-align: middle;
  font: inherit;
  font-size: 13px;
  line-height: 1;
  border-radius: 999px;
  border: 1px solid rgb(var(--line-2));
  background: rgb(var(--surface));
  color: rgb(var(--ink));
  cursor: pointer;
}
.bt-confirm:hover:not(:disabled) {
  border-color: rgb(var(--amber));
  background: rgb(var(--amber-tint));
}
.bt-confirm:disabled {
  opacity: 0.6;
  cursor: default;
}
.bt-badge {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  color: rgb(var(--ink));
  background: rgb(var(--amber-tint));
  border: 1px solid rgb(var(--amber));
  white-space: nowrap;
}
.bt-cat {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
/* The Included switch: a 44px touch target (a 24px box) that fits beside the amount at 320px; off reads as an empty box. */
.bt-included {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  cursor: pointer;
}
.bt-included input {
  width: 22px;
  height: 22px;
  margin: 0;
  cursor: inherit;
  accent-color: rgb(var(--ink));
}
.bt-included input:disabled {
  cursor: default;
}
.bt-excluded input {
  opacity: 0.7;
}
.bt-dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.bt-more,
.bt-error {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 8px;
  font-size: 13px;
}
.bt-error {
  color: rgb(var(--g4));
}
.bt-btn {
  font: inherit;
  min-height: 44px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid rgb(var(--line-2));
  background: rgb(var(--surface));
  color: rgb(var(--ink));
  cursor: pointer;
}
.bt-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.bt-skel-row {
  height: 36px;
  margin-bottom: 6px;
  border-radius: 6px;
  background: rgb(var(--sunken));
}
</style>
