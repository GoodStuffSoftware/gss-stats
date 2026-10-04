import type { GlobalFilters } from '../types'
import { rangeLabel } from './range'

/** One line saying what a per-chart filter override covers: the sites, the range, and "−me" when it
 * hides the owner's own visits. Shown on the chart's filter button and in the chart editor's
 * Filters row. */
export function filterOverrideSummary(f: GlobalFilters): string {
  // An override built from the current filter model carries `siteSel` and no legacy `site`
  // (e.g. the campaign device mix's rolling-year override) — summarize that instead of
  // assuming the legacy single-site field is set.
  const site =
    f.site === 'all' || (!f.site && !f.host && !f.siteSel?.length)
      ? 'all sites'
      : f.host
        ? f.host.replace('.goodstuff.software', '')
        : f.site
          ? f.site.replace('goodstuff.software', 'gs').replace('.com', '')
          : f.siteSel.join(', ')
  const flags: string[] = []
  if (f.excludeOwnVisits) flags.push('−me')
  return [site, rangeLabel(f.since, f.until, f.rangeRel), ...flags].join(' · ')
}
