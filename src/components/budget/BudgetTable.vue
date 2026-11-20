<script setup lang="ts">
// The spreadsheet under the Budget pie: the transactions behind the current slice, with the category editable.
// Contract with BudgetSection (src/lib/budget/types.ts): it passes BudgetTableProps and listens for `edited`
// to refetch the pie once. This component fetches the pages itself (cursor paging, "Load more").
//
// - A new `query` starts over at the first page. So does a `refreshKey` change, except the one the parent makes in
//   answer to our own `edited` (that would wipe the "moved to X" notes and the rule offer).
// - An edit shows at once and is saved with PATCH (expectedUpdatedAt); a 409 or a failure puts the row back and says so.
// - After a category change the row offers "Use for all <merchant>" (POST /rules).
// - `highlightId` scrolls to that row and marks it; when it is not on the loaded pages, more pages are loaded
//   (up to MAX_HIGHLIGHT_PAGES) to find it.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import EditableTable from '../table/EditableTable.vue'
import CategorySelect from './CategorySelect.vue'
import { createRule, fetchTxnPage, patchTxn } from '../../lib/budget/clientEdit'
import { budgetColumns, categoryOptions, createTxnTable, rowDotColor, selectValueFor, type TableDeps } from '../../lib/budget/tableModel'
import type { BudgetEditedEvent, BudgetTableProps, Txn } from '../../lib/budget/types'

const props = defineProps<BudgetTableProps>()
const emit = defineEmits<{ edited: [e: BudgetEditedEvent] }>()

const MAX_HIGHLIGHT_PAGES = 5
const deps: TableDeps = { fetchPage: fetchTxnPage, patch: patchTxn, createRule }

let ownEdit = false
function onEdited(e: BudgetEditedEvent) {
  // The parent bumps refreshKey while it handles this event; the flag is cleared once that update has been rendered.
  ownEdit = true
  emit('edited', e)
  void nextTick(() => {
    ownEdit = false
  })
}

const model = createTxnTable(deps, () => props.categories, onEdited)
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
}
function onAction(rowKey: string, id: string) {
  if (id === 'rule') void model.useForAll(rowKey)
}
const rowLabel = (t: Txn) => t.merchantName || t.description
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
      @edit="onEdit"
      @action="onAction"
    >
      <template #cell-merchant="{ row }">
        <span class="bt-merchant" :title="row.description">{{ row.merchantName || row.description }}</span>
        <span v-if="row.needsReview" class="bt-badge" title="Needs a look">Review</span>
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
          @change="commit"
        />
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
  </section>
</template>

<style scoped>
.budget-table {
  min-width: 0;
}
.bt-merchant {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
