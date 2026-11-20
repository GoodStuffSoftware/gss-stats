// Budget data -> slices for the generic DrillPie (components/charts/DrillPie.vue): the spending pie (category,
// then merchant or account, then purchase) and the debt pie. Colours come from colors.ts, the same function the
// table's category dots use. More than MAX_SLICES slices fold into one bucket ("6 smaller categories": never
// the word "Other", which is a real category's name); picking the bucket lists what it holds.
import type { PieSlice } from '../../components/charts/DrillPie.vue'
import { CATEGORY_PALETTE, categoryColor, OTHER_COLOR, shadeOf } from './colors'
import type { Category, DebtSlice, SummaryResponse } from './types'
import type { DrillStep } from './viewState'

export const MAX_SLICES = 12
/** The bucket's slice key. */
export const OTHER_KEY = '__other__'

/** Keep the biggest `max - 1` slices and fold the rest into one bucket slice, "N smaller <noun>", that holds
 * them as `members` (only when there are more than `max`). Input order is kept for the slices that stay; the
 * bucket is appended last. */
export function foldSlices(slices: PieSlice[], max = MAX_SLICES, noun = 'slices'): PieSlice[] {
  if (slices.length <= max) return slices
  const keepKeys = new Set(
    [...slices]
      .sort((a, b) => b.value - a.value)
      .slice(0, max - 1)
      .map((s) => s.key),
  )
  const kept = slices.filter((s) => keepKeys.has(s.key))
  const rest = slices.filter((s) => !keepKeys.has(s.key))
  const value = rest.reduce((n, s) => n + s.value, 0)
  const members = [...rest].sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))
  return [...kept, { key: OTHER_KEY, label: `${rest.length} smaller ${noun}`, value, color: OTHER_COLOR, members }]
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * The slices of one /summary answer. Only a positive net is drawn (refunds that exceed the spend are left to
 * the table). At the category level each slice has its category's colour; deeper down every slice is a shade
 * of the colour of the category being looked into, so the pie says where you are. `categories` is the list
 * from /meta; `path` the current drill steps.
 */
export function spendingSlices(
  summary: SummaryResponse,
  categories: Category[],
  path: DrillStep[],
  max = MAX_SLICES,
  groupBy: 'merchant' | 'account' = 'merchant',
): PieSlice[] {
  const positive = summary.slices.filter((s) => s.netCents > 0).sort((a, b) => b.netCents - a.netCents || a.key.localeCompare(b.key))
  const parent = categoryColor(categories, path[0]?.key)
  const slices: PieSlice[] = positive.map((s, i) => ({
    key: s.key,
    label: s.label,
    value: s.netCents,
    color: summary.level === 'category' ? categoryColor(categories, s.key) : shadeOf(parent, i),
    detail: summary.level === 'purchase' ? undefined : plural(s.count, 'purchase', 'purchases'),
  }))
  const noun = summary.level === 'category' ? 'categories' : summary.level === 'purchase' ? 'purchases' : groupBy === 'account' ? 'accounts' : 'stores'
  return foldSlices(slices, max, noun)
}

/** "19.99%" for an APR in basis points. */
export function formatApr(aprBp: number): string {
  return `${(aprBp / 100).toFixed(2)}%`
}

/**
 * The debt pie: one slice per debt that has a balance above zero, in the colour of its place in `debts` (so a
 * debt keeps its colour when another is paid off). `noBalance` are the debts with no balance known yet
 * (listed under the pie with "Add balance"); `settled` are those at zero.
 */
export function debtSlices(debts: DebtSlice[], max = MAX_SLICES): { slices: PieSlice[]; noBalance: DebtSlice[]; settled: DebtSlice[] } {
  const slices: PieSlice[] = []
  const noBalance: DebtSlice[] = []
  const settled: DebtSlice[] = []
  debts.forEach((d, i) => {
    if (d.balanceCents === null) noBalance.push(d)
    else if (d.balanceCents <= 0) settled.push(d)
    else {
      const detail = [d.last4 ? `••${d.last4}` : null, d.aprBp !== null ? `${formatApr(d.aprBp)} APR` : null].filter(Boolean).join(' · ')
      slices.push({
        key: d.accountId,
        label: d.label,
        value: d.balanceCents,
        color: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length],
        detail: detail || undefined,
      })
    }
  })
  slices.sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))
  return { slices: foldSlices(slices, max, 'debts'), noBalance, settled }
}
