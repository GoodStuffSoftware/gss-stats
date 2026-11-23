<script setup lang="ts">
// "Change similar purchases?": opened after a category change when the same merchant has other purchases. A list of
// them (EditableTable, `selectable`) with the likely ones ticked, a "Same amount only" switch (kept per merchant in
// the view prefs), and, only on an ordinary merchant, "Use for this merchant from now on" (a rule; the rows it will
// move anyway are ticked and locked). Apply sends the ticked rows; the owner merges the result and shows it in the
// table's status line. There is no undo: each purchase can be changed back in its row.
import { computed, ref, watch } from 'vue'
import EditableTable, { type EditableColumn } from '../table/EditableTable.vue'
import ModalPanel from '../ui/ModalPanel.vue'
import { categoryColor } from '../../lib/budget/colors'
import { defaultSameAmount, lockedByRule, preTick, ticked, visibleRows } from '../../lib/budget/similar'
import { formatAmount, formatDate } from '../../lib/budget/tableModel'
import type { SimilarOffer } from '../../lib/budget/tableModel'
import type { TxnViewPrefs } from '../../lib/budget/txnView'
import type { Category, SimilarRow } from '../../lib/budget/types'

const props = defineProps<{
  offer: SimilarOffer | null
  categories: Category[]
  prefs: Pick<TxnViewPrefs, 'sameAmount'>
  busy?: boolean
  returnTo?: HTMLElement | null
}>()
const emit = defineEmits<{
  close: []
  apply: [items: Array<{ id: string; expectedUpdatedAt: string }>, makeRule: boolean]
  flip: [merchantKey: string, on: boolean]
}>()

const sameAmount = ref(false)
const chosen = ref<Set<string>>(new Set())
const ruleOn = ref(false)

watch(
  () => props.offer,
  (o) => {
    if (!o) return
    sameAmount.value = defaultSameAmount(o.response, props.prefs)
    chosen.value = new Set(o.response.rows.filter(preTick).map((r) => r.id))
    ruleOn.value = false
  },
  { immediate: true },
)

const resp = computed(() => props.offer?.response ?? null)
const shown = computed(() => (resp.value ? visibleRows(resp.value.rows, sameAmount.value) : []))
const selected = computed(() => new Set(ticked(shown.value, chosen.value, ruleOn.value)))
const count = computed(() => selected.value.size)
const catName = (id: string | null) => props.categories.find((c) => c.id === id)?.label ?? 'Uncategorized'
const targetName = computed(() => catName(props.offer?.categoryId ?? null))
const merchant = computed(() => resp.value?.rows[0]?.merchantName ?? 'this merchant')
const amountText = computed(() => (resp.value ? formatAmount(resp.value.source.amountCents) : ''))

const description = computed(() => {
  const n = shown.value.length
  const what = `${n} other ${n === 1 ? 'purchase' : 'purchases'} from ${merchant.value}${sameAmount.value ? ` for ${amountText.value}` : ''}`
  return `${what} ${n === 1 ? 'is' : 'are'} not in ${targetName.value}.`
})

const columns: EditableColumn<SimilarRow>[] = [
  { key: 'postedDate', label: 'Date', editor: null, value: (r) => formatDate(r.postedDate), cardLine: 1, minWidth: 90 },
  { key: 'amountCents', label: 'Amount', editor: null, align: 'end', value: (r) => formatAmount(r.amountCents), cardLine: 1, minWidth: 90 },
  { key: 'merchantName', label: 'Merchant', editor: null, value: (r) => r.merchantName, cardLine: 2, minWidth: 140 },
  { key: 'categoryId', label: 'Now in', editor: null, value: (r) => catName(r.categoryId), cardLine: 2, minWidth: 140 },
  { key: 'note', label: 'Note', editor: null, value: (r) => r.note ?? '', cardLine: 0, minWidth: 120 },
]

function onSelected(next: Set<string>) {
  chosen.value = next
}
function disabledReason(r: SimilarRow): string | null {
  return lockedByRule(r, ruleOn.value) ? 'The rule covers this purchase' : null
}
function rowLabel(r: SimilarRow): string {
  return `${r.merchantName} ${formatDate(r.postedDate)} ${formatAmount(r.amountCents)}`
}
function flip(on: boolean) {
  sameAmount.value = on
  if (resp.value) emit('flip', resp.value.source.merchantKey, on)
}
function apply() {
  if (!count.value) return
  const items = shown.value.filter((r) => selected.value.has(r.id)).map((r) => ({ id: r.id, expectedUpdatedAt: r.updatedAt }))
  emit('apply', items, ruleOn.value)
}
const mixedLine = 'Sold many kinds of things, so only same-amount purchases are suggested.'
</script>

<template>
  <ModalPanel
    :open="!!offer"
    title="Change similar purchases?"
    title-id="sd-title"
    described-by="sd-desc"
    wide
    sheet
    initial-focus=".sd-switch"
    :return-to="returnTo"
    @close="emit('close')"
  >
    <template v-if="resp">
      <p id="sd-desc" class="sd-desc" data-testid="sd-desc">{{ description }}</p>
      <div class="sd-controls">
        <label class="sd-row">
          <input
            type="checkbox"
            role="switch"
            class="sd-switch"
            data-testid="sd-same-amount"
            :checked="sameAmount"
            @change="flip(($event.target as HTMLInputElement).checked)"
          />
          <span>Same amount only</span>
        </label>
        <label v-if="resp.ruleOffer.allowed" class="sd-row">
          <input v-model="ruleOn" type="checkbox" data-testid="sd-rule" />
          <span>Use for this merchant from now on</span>
        </label>
      </div>
      <p v-if="resp.ruleOffer.allowed && ruleOn" class="sd-muted">New purchases from {{ merchant }} get {{ targetName }} after the next rules re-apply.</p>
      <p v-if="resp.mixed" class="sd-muted" data-testid="sd-mixed">{{ mixedLine }}</p>
      <EditableTable
        class="sd-table"
        :columns="columns"
        :rows="shown"
        row-key="id"
        :editable="false"
        selectable
        :selected="selected"
        :select-disabled="disabledReason"
        :select-label="rowLabel"
        :row-label="rowLabel"
        label="Similar purchases"
        @update:selected="onSelected"
      >
        <template #cell-categoryId="{ row }">
          <span class="sd-cat">
            <span class="sd-dot" :style="{ background: categoryColor(categories, row.categoryId) }" aria-hidden="true"></span>
            {{ catName(row.categoryId) }}
            <span v-if="row.personSet" class="sd-badge" title="You chose this category yourself">Set by hand</span>
            <span v-else-if="row.scriptSet" class="sd-badge" title="A data fix chose this category">Set by a data fix</span>
          </span>
        </template>
        <template #empty>No purchases at this amount.</template>
      </EditableTable>
      <p v-if="resp.truncated" class="sd-muted" data-testid="sd-truncated">Showing the newest 300.</p>
      <p class="sd-sr" aria-live="polite" data-testid="sd-count">{{ count }} selected</p>
    </template>
    <template #actions>
      <button type="button" class="btn" data-testid="sd-cancel" @click="emit('close')">Not now</button>
      <button type="button" class="btn sd-go" data-testid="sd-apply" :disabled="count === 0 || busy" @click="apply">Change {{ count }}</button>
    </template>
  </ModalPanel>
</template>

<style scoped>
.sd-desc {
  margin: 0 0 8px;
  color: rgb(var(--ink-2));
}
.sd-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
  margin-bottom: 6px;
}
.sd-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  cursor: pointer;
}
.sd-muted {
  margin: 0 0 8px;
  font-size: 0.85rem;
  color: rgb(var(--ink-2));
}
.sd-table {
  max-height: 46vh;
  overflow-y: auto;
}
.sd-cat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.sd-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: none;
}
.sd-badge {
  font-size: 0.75rem;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgb(var(--sunken));
  color: rgb(var(--ink-2));
}
.sd-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.sd-go:disabled {
  opacity: 0.5;
}
@media (max-width: 599px) {
  .sd-table {
    max-height: none;
  }
  .sd-controls {
    flex-direction: column;
  }
}
</style>
