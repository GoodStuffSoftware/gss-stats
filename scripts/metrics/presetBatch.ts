// The POST /api/metrics batch a page of preset cards sends, built by the SAME code MetricCard runs
// (lib/metrics/scope.ts resolveRepeat → sectionCells → buildRequestSpec) and deduplicated as
// useMetrics does (content-equal requests share one entry). Used by capture-facts.ts (remote
// rows_read) and profile-metrics.ts (CPU) with `--batch campaigns`, so both measure the page as it
// really asks (docs/capacity.md §8).

import { resolveRepeat, sectionCells, buildRequestSpec } from '../../src/lib/metrics/scope'
import { presetById } from '../../src/lib/metrics/presets'
import { etDateFromMs } from '../../src/lib/popupEvents'
import type { MetricRequest } from '../../src/lib/metrics/types'

/** The Campaigns page's cards (lib/defaults.ts defaultCampaignsWidgets). Its hour-of-day and
 * flight-day charts are /api/geo queries, measured on their own. */
export const CAMPAIGNS_PAGE_PRESETS = ['campaign-funnel', 'campaign-country', 'campaign-cost', 'campaign-returns']

export function presetBatch(presets: readonly string[], nowMs: number): MetricRequest[] {
  const ctx = { todayEt: etDateFromMs(nowMs) }
  const seen = new Set<string>()
  const out: MetricRequest[] = []
  for (const id of presets) {
    const spec = presetById(id)
    if (!spec) throw new Error(`unknown preset ${id}`)
    for (const scope of resolveRepeat(spec.repeat, ctx)) {
      for (const section of spec.sections) {
        for (const { item, scope: sc } of sectionCells(section, scope, ctx)) {
          const r = buildRequestSpec(item, sc)
          if (!r) continue
          const k = JSON.stringify(r)
          if (seen.has(k)) continue
          seen.add(k)
          out.push({ key: `r${out.length}`, ...r })
        }
      }
    }
  }
  return out
}
