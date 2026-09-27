<script setup lang="ts">
// dataset 'overview' widget body — the one bespoke Overview panel left: the release before/after
// panel (widget.view 'releasePanel'; ADR 0003 slice 7 turns it into a card preset too). The
// former 'kpis' and 'scorecard' panels are metric cards since CONFIG_VERSION 10 (presets
// 'bsk-kpis' and 'campaign-scorecard', rendered by ChartCard through MetricCard; lib/defaults.ts
// migrateCardsV10) and the former 'timeline' is a standard line chart (CONFIG_VERSION 9).
import type { GlobalFilters, Widget } from '../../types'
import { useOverviewData } from '../../lib/overviewData'
import { fmtCount as fmt } from '../../lib/kpiFormat'

const props = defineProps<{ widget: Widget; filters: GlobalFilters; dark?: boolean }>()

const { data, loading, error } = useOverviewData(
  () => props.filters.since,
  () => props.filters.until,
)
</script>

<template>
  <div class="ow-body">
    <div v-if="loading && !data" class="state mono">Loading…</div>
    <div v-else-if="error" class="state error mono">{{ error }}</div>

    <template v-else-if="data">
      <!-- releasePanel -->
      <template v-if="widget.view === 'releasePanel'">
        <template v-if="data.releasePanel">
          <p class="caption">{{ data.releasePanel.release.version }} ({{ data.releasePanel.release.dateEt }}) — {{ data.releasePanel.days }} days before vs after. {{ data.releasePanel.note }}</p>
          <div class="release-grid">
            <div class="release-col">
              <div class="fc-label">Before</div>
              <div class="rel-row"><span>Page views</span><span class="mono">{{ fmt(data.releasePanel.before.pageviews) }}</span></div>
              <div class="rel-row"><span>Tagged arrivals</span><span class="mono">{{ fmt(data.releasePanel.before.taggedArrivals) }}</span></div>
              <div class="rel-row"><span>Auth successes</span><span class="mono">{{ fmt(data.releasePanel.before.authSuccess) }}</span></div>
              <div class="rel-row"><span>Installs</span><span class="mono">{{ fmt(data.releasePanel.before.install) }}</span></div>
            </div>
            <div class="release-col">
              <div class="fc-label">After</div>
              <div class="rel-row"><span>Page views</span><span class="mono">{{ fmt(data.releasePanel.after.pageviews) }}</span></div>
              <div class="rel-row"><span>Tagged arrivals</span><span class="mono">{{ fmt(data.releasePanel.after.taggedArrivals) }}</span></div>
              <div class="rel-row"><span>Auth successes</span><span class="mono">{{ fmt(data.releasePanel.after.authSuccess) }}</span></div>
              <div class="rel-row"><span>Installs</span><span class="mono">{{ fmt(data.releasePanel.after.install) }}</span></div>
            </div>
          </div>
        </template>
        <p v-else class="caption">No dated release yet. This panel fills in once a release has a date.</p>
      </template>

      <p v-else class="state mono">Unknown overview panel "{{ widget.view }}"</p>
    </template>
  </div>
</template>

<style scoped>
.ow-body {
  /* flex column, not a plain block with height:100% (fix/clean-look, 2026-09-26): a
     percentage height on .chart-box below needs its ancestor chain to resolve to a
     DEFINITE pixel size at every step, and on mobile — where the card's own height now
     comes from its content (Dashboard.vue's height:auto) rather than a fixed box — that
     chain broke, leaving Chart.js's canvas stuck at its hard-coded 150px fallback height
     instead of actually filling the card. flex:1 on .chart-box sizes it against the
     flex container's real resolved height instead, which doesn't have that failure mode. */
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: auto;
}
.state {
  padding: 20px 0;
  text-align: center;
  color: rgb(var(--ink-3));
}
.state.error {
  color: #bc4749;
}
.caption {
  font-size: 11.5px;
  color: rgb(var(--ink-3));
  margin: 0 0 10px;
}
.caption code {
  font-family: 'JetBrains Mono', monospace;
}
.release-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px;
}
.release-col {
  border: 1px solid rgb(var(--line));
  border-radius: 12px;
  padding: 12px 14px;
  background: rgb(var(--surface));
}
.fc-label {
  font-weight: 600;
  font-size: 12.5px;
  margin-bottom: 6px;
}
.rel-row {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  margin-bottom: 3px;
}
</style>
