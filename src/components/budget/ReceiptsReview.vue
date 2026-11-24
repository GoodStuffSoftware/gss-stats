<script setup lang="ts">
// The Receipts review list (plan section 8, item 3): each receipt the matcher found with its best bank match. A person
// applies a match (links the receipt and may set the category), rejects it, or dismisses the receipt. Nothing here
// writes a note. Built from the shared EditableTable (selectable rows, phone cards) and CategorySelect (ADR 0005/0007).
//
// One row per receipt. Its best match is the highest score; matches of the same split (same groupKey) are applied and
// rejected together; the other candidates show as "Also matches". The Gmail message id never appears as text.
// Batches: at most MAX_BATCH match ids per apply call (whole splits stay together, so a big selection goes in several calls).
import { computed, onMounted, ref } from 'vue'
import EditableTable, { type EditableColumn, type RowStatus } from '../table/EditableTable.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'
import CategorySelect from './CategorySelect.vue'
import { fetchMeta } from '../../lib/budget/clientRead'
import { formatCents } from '../../lib/budget/money'
import {
  applyReceipts,
  dismissReceipt,
  fetchReceipts,
  receiptsMessage,
  ReceiptsApiError,
  type ApplyItem,
  type ReceiptMatch,
  type ReceiptRow,
  type ReceiptsListStatus,
} from '../../lib/budget/receiptsClient'
import type { Category } from '../../lib/budget/types'

const MAX_BATCH = 50
const KEEP = '__keep__'

const TABS = [
  { value: 'suggested', label: 'Suggested', testid: 'rr-tab-suggested' },
  { value: 'unmatched', label: 'Unmatched', testid: 'rr-tab-unmatched' },
  { value: 'applied', label: 'Applied', testid: 'rr-tab-applied' },
]

/** Plain words for each reason the server skipped a match. */
const SKIP_TEXT: Record<string, string> = {
  stale: 'Changed since loaded, refresh and try again.',
  txn_linked: 'That bank row already has a receipt.',
  incomplete_group: 'Part of a split purchase is missing, so none of it was linked.',
  group_blocked: 'Another part of this split purchase cannot be linked, so none of it was.',
  conflict: 'A receipt was linked to this row meanwhile. Refresh and try again.',
  not_found: 'This match is no longer there.',
  not_suggested: 'This match is no longer a suggestion.',
}
const skipText = (reason: string) => SKIP_TEXT[reason] ?? 'Not applied.'

const tab = ref<ReceiptsListStatus>('suggested')
const receipts = ref<ReceiptRow[]>([])
const nextCursor = ref<string | null>(null)
const categories = ref<Category[]>([])
const loading = ref(true)
const loadingMore = ref(false)
const failed = ref('')
const busy = ref(false)
const selected = ref<ReadonlySet<string>>(new Set())
/** The category chosen per receipt id (KEEP: leave the row's category alone). */
const chosen = ref<Record<string, string>>({})
const rowState = ref<Record<string, RowStatus>>({})
/** Plain-words outcome lines of the last action. */
const results = ref<{ text: string; tone: 'ok' | 'bad' }[]>([])

const errText = (e: unknown) => (e instanceof ReceiptsApiError ? e.message : 'Something went wrong. Please try again.')

/** The matches of a receipt, best first. */
const sorted = (r: ReceiptRow): ReceiptMatch[] => [...r.matches].sort((a, b) => b.score - a.score)
const bestOf = (r: ReceiptRow): ReceiptMatch | null => sorted(r)[0] ?? null
/** The best match plus the other parts of its split (all share a groupKey); applied and rejected together. */
function groupOf(r: ReceiptRow): ReceiptMatch[] {
  const best = bestOf(r)
  if (!best) return []
  if (best.groupKey === null) return [best]
  return sorted(r).filter((m) => m.groupKey === best.groupKey)
}
const othersOf = (r: ReceiptRow): ReceiptMatch[] => {
  const g = new Set(groupOf(r).map((m) => m.matchId))
  return sorted(r).filter((m) => !g.has(m.matchId))
}
const strength = (m: ReceiptMatch) => (m.score >= 90 ? 'Strong' : 'Likely')

const categoryLabel = (id: string | null) => categories.value.find((c) => c.id === id)?.label ?? 'No category'
const options = computed(() => [
  { value: KEEP, label: 'Keep current category' },
  ...[...categories.value].sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label)).map((c) => ({ value: c.id, label: c.label })),
])
const chosenFor = (r: ReceiptRow): string => chosen.value[r.id] ?? bestOf(r)?.proposedCategoryId ?? KEEP

const money = (c: number | null) => (c === null ? '' : formatCents(c))
const day = (iso: string | null) => iso ?? ''
const itemNames = (r: ReceiptRow) => {
  const names = r.items.slice(0, 3).map((i) => i.description)
  return names.join(', ') + (r.items.length > 3 ? ` and ${r.items.length - 3} more` : '')
}

const editable = computed(() => tab.value === 'suggested')
const columns = computed<EditableColumn<ReceiptRow>[]>(() => [
  { key: 'date', label: 'Date', editor: null, value: (r) => day(r.receiptDate ?? r.emailDate), minWidth: 90 },
  { key: 'store', label: 'Store', editor: null, value: (r) => r.merchant ?? 'Unknown store', minWidth: 120 },
  { key: 'total', label: 'Total', editor: null, align: 'end', value: (r) => money(r.totalCents), minWidth: 80 },
  { key: 'bank', label: 'Bank row', editor: null, cardLine: 1, minWidth: 190 },
  { key: 'category', label: 'Category', editor: 'select', value: (r) => chosenFor(r), options: options.value, cardLine: 2, minWidth: 170 },
  { key: 'items', label: 'Items', editor: null, value: (r) => itemNames(r), cardLine: 2, minWidth: 140 },
  { key: 'strength', label: 'Match', editor: null, value: (r) => (bestOf(r) ? strength(bestOf(r)!) : ''), cardLine: 1, minWidth: 70 },
  { key: 'actions', label: '', editor: null, cardLine: 2, minWidth: 190 },
])

function selectDisabled(r: ReceiptRow): string | null {
  return !editable.value || !bestOf(r) ? 'No match to apply' : null
}

async function load(more = false) {
  if (more) loadingMore.value = true
  else loading.value = true
  failed.value = ''
  try {
    const page = await fetchReceipts({ status: tab.value, cursor: more ? nextCursor.value : null })
    receipts.value = more ? [...receipts.value, ...page.receipts] : page.receipts
    nextCursor.value = page.nextCursor
    if (!more) {
      selected.value = new Set()
      rowState.value = {}
    }
  } catch (e) {
    failed.value = errText(e)
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

onMounted(() => {
  void load()
  fetchMeta().then(
    (m) => (categories.value = m.categories),
    () => {},
  )
})

function setTab(v: string) {
  if (v === tab.value) return
  tab.value = v as ReceiptsListStatus
  results.value = []
  void load()
}

function onEdit(key: string, field: string, value: string) {
  if (field === 'category') chosen.value = { ...chosen.value, [key]: value }
}

function removeRows(ids: Set<string>) {
  receipts.value = receipts.value.filter((r) => !ids.has(r.id))
  const next = new Set(selected.value)
  for (const id of ids) next.delete(id)
  selected.value = next
}

const nameOf = (r: ReceiptRow) => r.merchant ?? 'A receipt'
function itemsFor(r: ReceiptRow): ApplyItem[] {
  const pick = chosenFor(r)
  return groupOf(r).map((m, i) => ({
    matchId: m.matchId,
    expectedUpdatedAt: m.txn.updatedAt,
    // The category rides on the first charge of a split only; the rest follow it.
    ...(pick !== KEEP && i === 0 ? { categoryId: pick } : {}),
  }))
}

/** Applies the given receipts in calls of at most MAX_BATCH match ids and shows what happened in plain words. */
async function applyRows(rows: ReceiptRow[]) {
  const todo = rows.filter((r) => bestOf(r))
  if (!todo.length || busy.value) return
  busy.value = true
  results.value = []
  const out: { text: string; tone: 'ok' | 'bad' }[] = []
  const done = new Set<string>()
  const byMatch = new Map<number, ReceiptRow>()
  for (const r of todo) for (const m of groupOf(r)) byMatch.set(m.matchId, r)
  const batches: ReceiptRow[][] = []
  let cur: ReceiptRow[] = []
  let n = 0
  for (const r of todo) {
    const k = groupOf(r).length
    if (n + k > MAX_BATCH && cur.length) {
      batches.push(cur)
      cur = []
      n = 0
    }
    cur.push(r)
    n += k
  }
  if (cur.length) batches.push(cur)
  const state: Record<string, RowStatus> = { ...rowState.value }
  try {
    for (const batch of batches) {
      const res = await applyReceipts(batch.flatMap(itemsFor))
      const seen = new Set<string>()
      for (const a of res.applied) {
        const r = byMatch.get(a.matchId)
        if (!r || seen.has(r.id)) continue
        seen.add(r.id)
        done.add(r.id)
        const kept = a.categoryKept === 'manual' || a.categoryKept === 'person_edit'
        out.push({ text: `${nameOf(r)}: ${kept ? 'Linked; your category was kept.' : a.categorySet ? 'Linked, and the category was set.' : 'Linked.'}`, tone: 'ok' })
      }
      for (const s of res.skipped) {
        const r = byMatch.get(s.matchId)
        if (!r) continue
        const text = skipText(s.reason)
        out.push({ text: `${nameOf(r)}: ${text}`, tone: 'bad' })
        state[r.id] = { error: text }
      }
    }
  } catch (e) {
    out.push({ text: errText(e), tone: 'bad' })
  } finally {
    busy.value = false
  }
  rowState.value = state
  removeRows(done)
  results.value = out
}

const applySelected = () => applyRows(receipts.value.filter((r) => selected.value.has(r.id)))

async function reject(r: ReceiptRow) {
  const ids = groupOf(r).map((m) => m.matchId)
  if (!ids.length || busy.value) return
  busy.value = true
  results.value = []
  try {
    const res = await applyReceipts([], ids)
    if (res.rejected.length) {
      results.value = [{ text: `${nameOf(r)}: Match rejected.`, tone: 'ok' }]
      removeRows(new Set([r.id]))
    } else {
      const reason = res.skipped[0]?.reason
      results.value = [{ text: `${nameOf(r)}: ${reason ? skipText(reason) : 'Could not reject that match.'}`, tone: 'bad' }]
    }
  } catch (e) {
    results.value = [{ text: errText(e), tone: 'bad' }]
  } finally {
    busy.value = false
  }
}

async function dismiss(r: ReceiptRow) {
  if (busy.value) return
  busy.value = true
  results.value = []
  try {
    await dismissReceipt(r.id)
    results.value = [{ text: `${nameOf(r)}: Dismissed.`, tone: 'ok' }]
    removeRows(new Set([r.id]))
  } catch (e) {
    results.value = [{ text: errText(e), tone: 'bad' }]
  } finally {
    busy.value = false
  }
}

const rowLabel = (r: ReceiptRow) => `${nameOf(r)} ${money(r.totalCents)}`
const emptyText = computed(() =>
  tab.value === 'suggested' ? 'No suggested matches right now.' : tab.value === 'unmatched' ? 'No unmatched receipts.' : 'No receipts applied yet.',
)
</script>

<template>
  <section class="rr" data-testid="receipts-review">
    <div class="rr-bar">
      <SegmentedControl :options="TABS" :model-value="tab" label="Receipts shown" size="compact" @update:model-value="setTab" />
      <button v-if="editable" type="button" class="btn btn-primary rr-btn" :disabled="busy || selected.size === 0" data-testid="rr-apply-selected" @click="applySelected">
        Apply selected{{ selected.size ? ` (${selected.size})` : '' }}
      </button>
      <button type="button" class="btn rr-btn" :disabled="loading || busy" data-testid="rr-refresh" @click="load()">Refresh</button>
    </div>

    <ul v-if="results.length" class="rr-results" role="status" data-testid="rr-results">
      <li v-for="(r, i) in results" :key="i" :class="`rr-${r.tone}`">{{ r.text }}</li>
    </ul>

    <div v-if="failed" class="rr-fail" data-testid="rr-failed">
      <span>{{ failed }}</span>
      <button type="button" class="btn rr-btn" @click="load()">Retry</button>
    </div>
    <p v-else-if="loading && !receipts.length" class="rr-muted" data-testid="rr-loading">Loading…</p>
    <template v-else>
      <EditableTable
        :columns="columns"
        :rows="receipts"
        row-key="id"
        :editable="editable"
        :row-status="rowState"
        :row-label="rowLabel"
        :loading="loading"
        :selectable="editable"
        :selected="selected"
        :select-disabled="selectDisabled"
        :select-label="(r: ReceiptRow) => `Select ${rowLabel(r)}`"
        card-labels
        label="Receipts"
        @update:selected="selected = $event"
        @edit="onEdit"
      >
        <template #empty>{{ emptyText }}</template>
        <template #cell-store="{ row }">
          <span data-testid="rr-store">{{ row.merchant ?? 'Unknown store' }}</span>
          <span v-if="row.paymentVia" class="rr-sub"> via {{ row.paymentVia }}</span>
        </template>
        <template #cell-bank="{ row }">
          <template v-if="bestOf(row)">
            <span class="rr-bank" data-testid="rr-bank">
              <template v-for="(m, i) in groupOf(row)" :key="m.matchId">
                <span v-if="i" class="rr-sep"> + </span>
                {{ m.txn.postedDate }} {{ formatCents(m.txn.amountCents) }} {{ m.txn.merchantName ?? '' }}
                <span v-if="m.txn.accountLabel" class="rr-sub">({{ m.txn.accountLabel }})</span>
              </template>
            </span>
            <span v-if="groupOf(row).length > 1" class="rr-sub" data-testid="rr-split"> {{ groupOf(row).length }} charges</span>
            <span v-if="othersOf(row).length" class="rr-also" data-testid="rr-also">
              Also matches: {{ othersOf(row).map((m) => `${m.txn.postedDate} ${formatCents(m.txn.amountCents)} ${m.txn.merchantName ?? ''}`.trim()).join('; ') }}
            </span>
          </template>
          <span v-else class="rr-sub">No bank row found</span>
        </template>
        <template #cell-category="{ row }">
          <span v-if="bestOf(row)">{{ categoryLabel(bestOf(row)!.txn.categoryId) }}</span>
        </template>
        <template #editor-category="{ row, disabled, label, commit }">
          <CategorySelect v-if="bestOf(row)" :value="chosenFor(row)" :options="options" color="transparent" :label="label" :disabled="disabled || busy" @change="commit" />
        </template>
        <template #cell-actions="{ row }">
          <span class="rr-actions">
            <template v-if="tab === 'suggested' && bestOf(row)">
              <button type="button" class="btn btn-primary rr-btn" :disabled="busy" data-testid="rr-apply" @click="applyRows([row])">Apply</button>
              <button type="button" class="btn rr-btn" :disabled="busy" data-testid="rr-reject" @click="reject(row)">Reject</button>
            </template>
            <button v-if="tab !== 'applied'" type="button" class="btn btn-ghost rr-btn" :disabled="busy" data-testid="rr-dismiss" @click="dismiss(row)">Dismiss</button>
          </span>
        </template>
        <template #footer>
          <div v-if="nextCursor" class="rr-more">
            <button type="button" class="btn rr-btn" :disabled="loadingMore" data-testid="rr-more" @click="load(true)">
              {{ loadingMore ? 'Loading…' : 'Load more' }}
            </button>
          </div>
        </template>
      </EditableTable>
    </template>
  </section>
</template>

<style scoped>
.rr {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.rr-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.rr-btn {
  min-height: 36px;
}
.rr-results {
  margin: 0;
  padding: 8px 10px 8px 24px;
  border: 1px solid rgb(var(--line-2));
  border-radius: 9px;
  font-size: 13px;
}
.rr-bad {
  color: rgb(var(--amber-hover));
}
.rr-fail {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
}
.rr-muted,
.rr-sub {
  color: rgb(var(--ink-2));
  font-size: 12px;
}
.rr-muted {
  margin: 0;
  font-size: 13px;
}
.rr-also {
  display: block;
  color: rgb(var(--ink-2));
  font-size: 12px;
}
.rr-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.rr-more {
  display: flex;
  justify-content: center;
  padding: 8px 0;
}
</style>
