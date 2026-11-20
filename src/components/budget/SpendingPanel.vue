<script setup lang="ts">
// STUB (leg U1a). Leg U1b fills it in (DrillPie + Crumbs + totals + "Needs review (n)" toggle + group-by
// switch) WITHOUT changing this contract or editing BudgetSection.vue. BudgetSection owns the state and
// the fetching; this panel only draws and reports clicks.
//
// Props
//   summary:    SummaryResponse   the answer for the CURRENT state; never null, and never empty at the top
//                                 level (BudgetSection shows loading / error / "No spending in this range"
//                                 itself). `summary.level` says what the slices are: 'category' (path
//                                 empty), 'merchant' (one step, or accounts when groupBy is 'account') or
//                                 'purchase' (two steps; not drillable).
//   path:       DrillStep[]       the crumbs (0-2 steps; step i has level 'category' | 'merchant').
//   groupBy:    'merchant' | 'account'   how the second level groups.
//   reviewOnly: boolean           the "Needs review" toggle state.
//   dark:       boolean           site theme.
//   refreshing: boolean           a newer answer is loading; keep the old pie on screen, dimmed.
// Emits
//   drill(step: DrillStep)        a slice was picked: push it (the next level; never emitted at 'purchase').
//   crumb(depth: number)          a crumb was picked: pop back to `depth` steps (0 = the top).
//   group-by(g: 'merchant'|'account')
//   review-only(on: boolean)      the "Needs review (n)" toggle.
//   select-purchase(txnId: string)  a purchase slice was picked: the table scrolls to and highlights that row.
import type { SummaryResponse } from '../../lib/budget/types'
import type { DrillStep, GroupBy } from '../../lib/budget/viewState'

defineProps<{
  summary: SummaryResponse
  path: DrillStep[]
  groupBy: GroupBy
  reviewOnly: boolean
  dark: boolean
  refreshing: boolean
}>()
defineEmits<{
  drill: [step: DrillStep]
  crumb: [depth: number]
  'group-by': [g: GroupBy]
  'review-only': [on: boolean]
  'select-purchase': [txnId: string]
}>()
</script>

<template>
  <div class="spending-panel" data-testid="spending-panel" />
</template>
