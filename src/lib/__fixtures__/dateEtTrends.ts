// The three charts of the sanitised production layouts (prodLayout.v8/v9/v12.json) that the v15
// step moves from the UTC `date` axis to `dateEt` (migrateDateEtTrendsV15): the geo "Pageviews over
// time" trends, still exactly the shipped default. Every other widget loads as stored. The default
// and Beacon Overview `trend` charts (no dataset) are not geo charts, never carry the split-guard
// caption, and stay on `date`.
import type { DashboardConfig, Widget } from '../../types'

export const V15_TREND_KEYS: readonly string[] = ['bsk-launch/trend', 'b8c47309/455a6868', '7fc55dff/72e21d89']

/** `cfg` with the V15_TREND_KEYS widgets moved to `dateEt`: what a pre-v15 layout loads as. */
export function withV15Trends<T extends DashboardConfig>(cfg: T): T {
  return {
    ...cfg,
    pages: cfg.pages.map((p) => ({
      ...p,
      widgets: p.widgets.map((w: Widget) => (V15_TREND_KEYS.includes(`${p.id}/${w.id}`) ? { ...w, dimension: 'dateEt' } : w)),
    })),
  }
}
