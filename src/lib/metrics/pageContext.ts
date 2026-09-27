// The page context a metric card sends with its requests (POST /api/metrics `context`), built
// from the page's main filter bar (or a widget's own filter override): the date range and the
// resolved beacon site tags. ChartCard passes it to MetricCard, and useMetrics re-plans every
// request when it changes, so a card follows the filter bar.
//
// Only what the server accepts, so a filter-bar state can never fail the whole batch:
// - since/until only as a pair of real instants, the range capped at MAX_RANGE_DAYS (the
//   server's own limit) by moving `since` forward;
// - site tags that pass the server's tag rule, at most its maximum;
// - no own-visit fields: no fact honours them yet, and the server refuses a user-agent value it
//   does not recognise.
import { SITE_TAG_RE } from '../range'
import { MAX_RANGE_DAYS } from './validate'
import type { MetricsContext } from './types'

const MAX_SITES = 50
const DAY_MS = 86_400_000
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

export interface PageRange {
  since?: string
  until?: string
}

/** A bare YYYY-MM-DD is an ET day to the server; for the length check a UTC reading is close
 * enough (the cap is applied with a day's margin). */
function instantMs(v: string): number {
  return Date.parse(DATE_ONLY_RE.test(v) ? `${v}T00:00:00Z` : v)
}

export function metricsContextFor(range: PageRange, siteTags: readonly string[]): MetricsContext {
  const out: MetricsContext = {}
  const { since, until } = range
  if (typeof since === 'string' && typeof until === 'string') {
    const a = instantMs(since)
    const b = instantMs(until)
    if (Number.isFinite(a) && Number.isFinite(b) && a < b) {
      const maxMs = (MAX_RANGE_DAYS - 1) * DAY_MS
      if (b - a > maxMs) {
        // Keep the newest MAX_RANGE_DAYS - 1 days: the end of the range is what "now" cards read.
        out.since = new Date(b - maxMs).toISOString()
        out.until = DATE_ONLY_RE.test(until) ? new Date(b + DAY_MS).toISOString() : until
      } else {
        out.since = since
        out.until = until
      }
    }
  }
  const sites = [...new Set(siteTags.filter((t) => typeof t === 'string' && SITE_TAG_RE.test(t)))].slice(0, MAX_SITES)
  if (sites.length) out.sites = sites
  return out
}
