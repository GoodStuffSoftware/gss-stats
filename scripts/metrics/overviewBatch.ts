// A representative Overview page batch for POST /api/metrics: the `campaign-scorecard` preset
// repeated over every configured campaign plus the `bsk-kpis` tiles (src/lib/metrics/presets.ts),
// expanded by hand the way slice 4's useMetrics() will expand them. Used by capture-facts.ts
// (remote rows_read) and profile-metrics.ts (CPU), so both measure the same batch.

import { CAMPAIGNS, flightDayIndex } from '../../src/lib/campaigns'
import { etDateFromMs } from '../../src/lib/popupEvents'
import type { MetricRequest } from '../../src/lib/metrics/types'

export function overviewBatch(nowMs: number): MetricRequest[] {
  const todayEt = etDateFromMs(nowMs)
  const out: MetricRequest[] = []
  for (const c of CAMPAIGNS) {
    const p = { campaignId: c.id }
    out.push(
      { key: `sc.${c.id}.arrivals`, metric: 'campaign.taggedArrivals', params: p },
      { key: `sc.${c.id}.auth`, metric: 'campaign.authSuccess', params: p },
      { key: `sc.${c.id}.installs`, metric: 'campaign.installs', params: p },
      { key: `sc.${c.id}.return`, ratio: 'campaign.returnD2to7PerD0', params: p },
      { key: `sc.${c.id}.cpa`, ratio: 'campaign.costPerArrival', params: p },
      { key: `sc.${c.id}.played`, ratio: 'campaign.gameViewsVsArrivals', params: p },
      { key: `sc.${c.id}.completed`, metric: 'campaign.completions', params: p },
      { key: `sc.${c.id}.asks`, metric: 'campaign.asks', params: p },
      { key: `sc.${c.id}.accept`, ratio: 'campaign.acceptPerAsk', params: p },
      { key: `sc.${c.id}.signedin`, ratio: 'campaign.signedInPerAsk', params: p },
      { key: `sc.${c.id}.prompts`, metric: 'campaign.installPrompts', params: p },
      { key: `sc.${c.id}.install`, ratio: 'campaign.installPerPrompt', params: p },
    )
  }
  const today = { window: 'todaySoFar', deltas: ['yesterday', 'avg7'] as ('yesterday' | 'avg7')[] }
  out.push(
    { key: 'kpi.pv', metric: 'bsk.pageviews', ...today },
    ...CAMPAIGNS.filter((c) => flightDayIndex(c, todayEt) !== null).map((c) => ({ key: `kpi.arrivals.${c.id}`, metric: 'campaign.taggedArrivals', params: { campaignId: c.id }, ...today })),
    { key: 'kpi.gameviews', metric: 'bsk.gameViews', ...today },
    { key: 'kpi.completed', metric: 'bsk.completions', ...today },
    { key: 'kpi.shown', metric: 'bsk.popupShown', ...today },
    { key: 'kpi.accepted', metric: 'bsk.popupAccepts', ...today },
    { key: 'kpi.tap', ratio: 'bsk.popupTapRate', window: 'todaySoFar' },
    { key: 'kpi.auth', metric: 'bsk.authSuccess', ...today },
    { key: 'kpi.installs', metric: 'bsk.installs', ...today },
    { key: 'kpi.raw', metric: 'bsk.rawInstallSignals', ...today },
    { key: 'kpi.returns', metric: 'bsk.returnsD1plus', ...today },
  )
  return out
}
