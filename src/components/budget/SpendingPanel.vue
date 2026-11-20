<script setup lang="ts">
// The spending pie: DrillPie of the current /summary answer, the crumbs back up, the total, the "Needs review
// (n)" toggle and, once inside a category, a switch for what the next level groups by. BudgetSection owns the
// state and the fetching (and the loading / error / empty-range screens); this panel only draws and reports
// clicks.
//
// Props
//   summary:    SummaryResponse   the answer for the CURRENT state; never null, never empty at the top level.
//                                 `summary.level` says what the slices are: 'category' (path empty), 'merchant'
//                                 (one step, or accounts when groupBy is 'account') or 'purchase' (two steps;
//                                 not drillable).
//   categories: Category[]        from /meta: the colours (the same ones the table's dots use).
//   path:       DrillStep[]       the crumbs (0-2 steps; step i has level 'category' | 'merchant').
//   groupBy:    'merchant' | 'account'   how the second level groups.
//   reviewOnly: boolean           the "Needs review" toggle state.
//   dark:       boolean           site theme.
//   refreshing: boolean           a newer answer is loading; keep the old pie on screen, dimmed.
// Emits
//   drill(step)            a slice was picked: push it (the next level; never emitted at 'purchase').
//   crumb(depth)           a crumb was picked: pop back to `depth` steps (0 = the top).
//   group-by(g)            the second-level grouping switch.
//   review-only(on)        the "Needs review (n)" toggle.
//   select-purchase(id)    a purchase slice was picked: the table scrolls to and highlights that row.
import { computed } from 'vue'
import { spendingSlices } from '../../lib/budget/pieModel'
import { formatAmount } from '../../lib/budget/tableModel'
import type { Category, SummaryResponse } from '../../lib/budget/types'
import type { DrillStep, GroupBy } from '../../lib/budget/viewState'
import DrillPie from '../charts/DrillPie.vue'
import Crumbs from '../nav/Crumbs.vue'

const props = defineProps<{
  summary: SummaryResponse
  categories: Category[]
  path: DrillStep[]
  groupBy: GroupBy
  reviewOnly: boolean
  dark: boolean
  refreshing: boolean
}>()
const emit = defineEmits<{
  drill: [step: DrillStep]
  crumb: [depth: number]
  'group-by': [g: GroupBy]
  'review-only': [on: boolean]
  'select-purchase': [txnId: string]
}>()

const TOP_LABEL = 'All spending'
const crumbItems = computed(() => [{ key: '', label: TOP_LABEL }, ...props.path.map((s) => ({ key: s.key, label: s.label }))])
const slices = computed(() => spendingSlices(props.summary, props.categories, props.path, undefined, props.groupBy))
const where = computed(() => (props.path.length ? props.path[props.path.length - 1].label : TOP_LABEL))
const NEXT_LEVEL: Record<string, DrillStep['level'] | undefined> = { category: 'category', merchant: 'merchant' }

function onSelect(key: string) {
  const level = props.summary.level
  if (level === 'purchase') {
    emit('select-purchase', key)
    return
  }
  const stepLevel = NEXT_LEVEL[level]
  if (!stepLevel) return
  const label = props.summary.slices.find((s) => s.key === key)?.label ?? key
  emit('drill', { level: stepLevel, key, label })
}

const pieLabel = computed(() => `Spending in ${where.value}`)
</script>

<template>
  <div class="spending-panel" data-testid="spending-panel" :class="{ refreshing }" :aria-busy="refreshing">
    <div class="sp-head">
      <Crumbs :items="crumbItems" label="Spending path" @go="(i) => emit('crumb', i)" />
      <div class="sp-controls">
        <div v-if="path.length >= 1" class="sp-seg" role="radiogroup" aria-label="Group by">
          <button
            type="button"
            role="radio"
            class="sp-seg-btn"
            :aria-checked="groupBy === 'merchant'"
            data-testid="group-merchant"
            @click="emit('group-by', 'merchant')"
          >Stores</button>
          <button
            type="button"
            role="radio"
            class="sp-seg-btn"
            :aria-checked="groupBy === 'account'"
            data-testid="group-account"
            @click="emit('group-by', 'account')"
          >Accounts</button>
        </div>
        <button
          v-if="summary.reviewCount > 0 || reviewOnly"
          type="button"
          class="sp-review"
          :class="{ on: reviewOnly }"
          :aria-pressed="reviewOnly"
          data-testid="review-toggle"
          @click="emit('review-only', !reviewOnly)"
        >Needs review ({{ summary.reviewCount }})</button>
      </div>
    </div>

    <p class="sp-total" data-testid="spending-total">
      <span class="sp-total-label">Total</span>
      <strong class="sp-total-value">{{ formatAmount(summary.totalCents) }}</strong>
    </p>

    <div :key="`${path.map((s) => s.key).join('/')}|${groupBy}`" class="sp-body">
      <DrillPie :slices="slices" :dark="dark" :format="formatAmount" :label="pieLabel" @select="onSelect" />
      <p v-if="slices.length === 0" class="sp-none" data-testid="spending-none">Nothing above zero here: refunds cover the spending.</p>
    </div>
  </div>
</template>

<style scoped>
.spending-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  transition: opacity 150ms ease-out;
}
.spending-panel.refreshing {
  opacity: 0.6;
}
.sp-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.sp-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.sp-seg {
  display: inline-flex;
  border: 1px solid rgb(var(--line));
  border-radius: 8px;
  overflow: hidden;
}
.sp-seg-btn,
.sp-review {
  min-height: 44px;
  padding: 0 14px;
  border: 0;
  background: transparent;
  color: rgb(var(--ink-2));
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}
.sp-seg-btn[aria-checked='true'] {
  background: rgb(var(--sunken));
  color: rgb(var(--ink));
  font-weight: 600;
}
.sp-review {
  border: 1px solid rgb(var(--line));
  border-radius: 8px;
}
.sp-review.on {
  border-color: rgb(var(--amber));
  color: rgb(var(--ink));
  font-weight: 600;
}
.sp-seg-btn:focus-visible,
.sp-review:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: -2px;
}
.sp-total {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
}
.sp-total-label {
  font-size: 14px;
  color: rgb(var(--ink-2));
}
.sp-total-value {
  font-size: 22px;
  font-variant-numeric: tabular-nums;
}
.sp-body {
  min-width: 0;
  animation: sp-fade 150ms ease-out;
}
.sp-none {
  margin: 8px 0 0;
  font-size: 14px;
  color: rgb(var(--ink-2));
}
@keyframes sp-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .sp-body {
    animation: none;
  }
  .spending-panel {
    transition: none;
  }
}
</style>
