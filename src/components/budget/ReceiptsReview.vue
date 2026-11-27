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
import { formatCents } from '../../lib/budget/money'
import { receiptText } from '../../lib/budget/tableModel'
import {
  applyReceipts,
  deleteUpload,
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

/** The Budget categories, passed in from BudgetSection (so one created this session shows here too). */
const props = withDefaults(defineProps<{ categories?: Category[] }>(), { categories: () => [] })

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
  conflict: 'This receipt was already linked to another bank row, or a row changed meanwhile. Refresh and try again.',
  too_many: 'This purchase is split over too many charges to apply here.',
  not_found: 'This match is no longer there.',
  not_suggested: 'This match is no longer a suggestion.',
}
const skipText = (reason: string) => SKIP_TEXT[reason] ?? 'Not applied.'

const tab = ref<ReceiptsListStatus>('suggested')
const receipts = ref<ReceiptRow[]>([])
const nextCursor = ref<string | null>(null)
/** Counts loads; an answer from an older load (a quick tab switch) is dropped. */
let loadToken = 0
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

const categoryLabel = (id: string | null) => props.categories.find((c) => c.id === id)?.label ?? 'No category'
const options = computed(() => [
  { value: KEEP, label: 'Keep current category' },
  ...[...props.categories].sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label)).map((c) => ({ value: c.id, label: c.label })),
])
const chosenFor = (r: ReceiptRow): string => chosen.value[r.id] ?? bestOf(r)?.proposedCategoryId ?? KEEP

const money = (c: number | null) => (c === null ? '' : formatCents(c))
const day = (iso: string | null) => iso ?? ''
/** Every string that came from an email goes through receiptText (control and bidi characters out, length capped), as in ReceiptBlock. */
const storeName = (r: ReceiptRow) => receiptText(r.merchant, 60) || 'Unknown store'
const bankText = (m: ReceiptMatch) => `${m.txn.postedDate} ${formatCents(m.txn.amountCents)} ${receiptText(m.txn.merchantName, 60)}`.trim()
const itemNames = (r: ReceiptRow) => {
  const names = r.items.slice(0, 3).map((i) => receiptText(i.description, 60))
  return names.join(', ') + (r.items.length > 3 ? ` and ${r.items.length - 3} more` : '')
}

const editable = computed(() => tab.value === 'suggested')
// Match strength only exists for a suggestion, and a category only where a bank row was found; a column with nothing in it is left out.
const columns = computed<EditableColumn<ReceiptRow>[]>(() => {
  const cols: EditableColumn<ReceiptRow>[] = [
    { key: 'date', label: 'Date', editor: null, value: (r) => day(r.receiptDate ?? r.emailDate), minWidth: 90 },
    { key: 'store', label: 'Store', editor: null, value: (r) => storeName(r), minWidth: 120 },
    { key: 'total', label: 'Total', editor: null, align: 'end', value: (r) => money(r.totalCents), minWidth: 80 },
    { key: 'bank', label: 'Bank row', editor: null, cardLine: 1, minWidth: 190 },
  ]
  if (tab.value !== 'unmatched') cols.push({ key: 'category', label: 'Category', editor: 'select', value: (r) => chosenFor(r), options: options.value, cardLine: 2, minWidth: 170 })
  cols.push({ key: 'items', label: 'Items', editor: null, value: (r) => itemNames(r), cardLine: 2, minWidth: 140 })
  if (tab.value === 'suggested') cols.push({ key: 'strength', label: 'Match', editor: null, value: (r) => (bestOf(r) ? strength(bestOf(r)!) : ''), cardLine: 1, minWidth: 70 })
  cols.push({ key: 'actions', label: '', editor: null, cardLine: 2, minWidth: 190 })
  return cols
})

function selectDisabled(r: ReceiptRow): string | null {
  return !editable.value || !bestOf(r) ? 'No match to apply' : null
}

async function load(more = false) {
  // A fresh load (or a tab switch) supersedes everything still in flight: its answer is dropped when it arrives.
  const mine = more ? loadToken : ++loadToken
  if (more) loadingMore.value = true
  else loading.value = true
  failed.value = ''
  try {
    const page = await fetchReceipts({ status: tab.value, cursor: more ? nextCursor.value : null })
    if (mine !== loadToken) return
    receipts.value = more ? [...receipts.value, ...page.receipts] : page.receipts
    nextCursor.value = page.nextCursor
    if (!more) {
      selected.value = new Set()
      rowState.value = {}
    }
  } catch (e) {
    if (mine === loadToken) failed.value = errText(e)
  } finally {
    if (mine === loadToken) {
      loading.value = false
      loadingMore.value = false
    }
  }
}

onMounted(() => {
  void load()
})

function setTab(v: string) {
  if (v === tab.value) return
  tab.value = v as ReceiptsListStatus
  results.value = []
  receipts.value = []
  nextCursor.value = null
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

const nameOf = (r: ReceiptRow) => receiptText(r.merchant, 60) || 'A receipt'
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
  const withMatch = rows.filter((r) => bestOf(r))
  if (!withMatch.length || busy.value) return
  busy.value = true
  results.value = []
  const out: { text: string; tone: 'ok' | 'bad' }[] = []
  const state: Record<string, RowStatus> = { ...rowState.value }
  // One apply call takes at most MAX_BATCH matches and a split is never cut in two, so a split bigger than that cannot go.
  const todo = withMatch.filter((r) => {
    if (groupOf(r).length <= MAX_BATCH) return true
    const text = skipText('too_many')
    out.push({ text: `${nameOf(r)}: ${text}`, tone: 'bad' })
    state[r.id] = { error: text }
    return false
  })
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

/** Deletes the viewer's own photo receipt (and its photo) for good; the server refuses anyone else. */
async function deletePhoto(r: ReceiptRow) {
  if (busy.value) return
  busy.value = true
  results.value = []
  try {
    await deleteUpload(r.id)
    results.value = [{ text: `${nameOf(r)}: Deleted.`, tone: 'ok' }]
    removeRows(new Set([r.id]))
  } catch (e) {
    results.value = [{ text: errText(e), tone: 'bad' }]
  } finally {
    busy.value = false
  }
}

const rowLabel =(r: ReceiptRow) => `${nameOf(r)} ${money(r.totalCents)}`
const emptyText = computed(() =>
  tab.value === 'suggested' ? 'No suggested matches right now.' : tab.value === 'unmatched' ? 'No unmatched receipts.' : 'No receipts applied yet.',
)
</script>

<template>
  <section class="rr" data-testid="receipts-review">
    <div class="rr-bar">
      <SegmentedControl class="rr-tabs" :options="TABS" :model-value="tab" label="Receipts shown" size="compact" @update:model-value="setTab" />
      <button type="button" class="btn rr-btn rr-refresh" :disabled="loading || busy" aria-label="Refresh" title="Refresh" data-testid="rr-refresh" @click="load()">
        <span aria-hidden="true">&#8635;</span>
      </button>
    </div>
    <!-- The bulk apply sits in its own bar, only while rows are ticked, so the tab row stays one row on a phone. -->
    <div v-if="editable && selected.size" class="rr-selbar">
      <button type="button" class="btn btn-primary rr-btn" :disabled="busy" data-testid="rr-apply-selected" @click="applySelected">Apply selected ({{ selected.size }})</button>
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
          <span data-testid="rr-store">{{ storeName(row) }}</span>
          <span v-if="receiptText(row.paymentVia, 40)" class="rr-sub"> via {{ receiptText(row.paymentVia, 40) }}</span>
          <span class="rr-sub" data-testid="rr-source"> · {{ row.source === 'upload' ? 'Photo' : 'Email' }}</span>
        </template>
        <template #cell-bank="{ row }">
          <template v-if="bestOf(row)">
            <span class="rr-bank" data-testid="rr-bank">
              <template v-for="(m, i) in groupOf(row)" :key="m.matchId">
                <span v-if="i" class="rr-sep"> + </span>
                {{ bankText(m) }}
                <span v-if="receiptText(m.txn.accountLabel, 40)" class="rr-sub">({{ receiptText(m.txn.accountLabel, 40) }})</span>
              </template>
            </span>
            <span v-if="groupOf(row).length > 1" class="rr-sub" data-testid="rr-split"> {{ groupOf(row).length }} charges</span>
            <span v-if="othersOf(row).length" class="rr-also" data-testid="rr-also">
              Also matches: {{ othersOf(row).map(bankText).join('; ') }}
            </span>
          </template>
          <span v-else class="rr-sub">No bank row found</span>
        </template>
        <template #cell-category="{ row }">
          <span v-if="bestOf(row)">{{ categoryLabel(bestOf(row)!.txn.categoryId) }}</span>
        </template>
        <template #editor-category="{ row, disabled, label, commit }">
          <CategorySelect v-if="bestOf(row)" :value="chosenFor(row)" :options="options" color="transparent" :label="label" :disabled="disabled || busy" @change="commit" />
          <!-- A person set this row's category: Apply links the receipt and leaves it (the server keeps it either way). -->
          <span v-if="bestOf(row)?.categoryProtectedBy" class="rr-sub rr-kept" data-testid="rr-kept">Category will be kept</span>
        </template>
        <template #cell-actions="{ row }">
          <span class="rr-actions">
            <template v-if="tab === 'suggested' && bestOf(row)">
              <button type="button" class="btn btn-primary rr-btn" :disabled="busy" data-testid="rr-apply" @click="applyRows([row])">Apply</button>
              <button type="button" class="btn rr-btn" :disabled="busy" data-testid="rr-reject" @click="reject(row)">Reject</button>
            </template>
            <button v-if="tab !== 'applied'" type="button" class="btn btn-ghost rr-btn" :disabled="busy" data-testid="rr-dismiss" @click="dismiss(row)">Dismiss</button>
            <button v-if="row.source === 'upload' && row.mine" type="button" class="btn btn-ghost rr-btn" :disabled="busy" data-testid="rr-delete" @click="deletePhoto(row)">Delete</button>
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
/* One row on a phone: the three tabs take the room the Refresh icon leaves; the bulk apply has its own bar below. */
.rr-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rr-tabs {
  flex: 1 1 auto;
  min-width: 0;
}
.rr-tabs :deep(.seg-btn) {
  flex: 1 1 0;
  min-width: 0;
  padding: 0 6px;
}
.rr-btn {
  min-height: 36px;
}
.rr-refresh {
  flex: 0 0 auto;
  min-width: 36px;
  padding: 0;
}
.rr-selbar {
  position: sticky;
  bottom: 8px;
  z-index: 5;
  display: flex;
  justify-content: flex-end;
}
/* Long unbroken email text (a store name) wraps inside its card or cell instead of widening the page. */
.rr :deep(.et-part),
.rr :deep(.et-field),
.rr :deep(td) {
  min-width: 0;
  overflow-wrap: anywhere;
}
/* Card values read at one size and spacing whichever tab (the bare cells would otherwise take the 16px page size). */
.rr :deep(.et-line2) {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}
.rr :deep(.et-labelled .et-lab) {
  margin-bottom: 1px;
}
/* Tick boxes at the 36px tap size (the shared table's 18px box is for desktop); this list opts in. */
.rr :deep(.et-check) {
  width: 36px;
  height: 36px;
}
.rr :deep(.et-card-check) {
  left: 4px;
  top: 4px;
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
.rr-kept {
  display: block;
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
