// Smart date-range helpers. The filter `since`/`until` are ISO datetime strings
// (with back-compat for legacy "YYYY-MM-DD" day values).
import { CAMPAIGNS, etMidnightUtcMs, etFlightRangeMs } from './campaigns'

/** A since/until value every API accepts: a YYYY-MM-DD day or an ISO datetime. One copy for
 * every endpoint (functions/api/*) and the metrics request validator (lib/metrics/validate.ts). */
export const WHEN_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?$/
/** A site tag in a request's site filter (beacon `site` values and RUM hosts). */
export const SITE_TAG_RE = /^[a-z0-9.\-]{1,40}$/i

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  mo: 2_592_000_000, // 30d
}

// Parse a duration token like "24h", "3h", "7d", "2w", "1mo", "90m" → ms (or null).
// Tolerates the way the field renders the value back ("Last 7d") and casual phrasing
// ("past 24h", "3 days ago") by stripping a leading last/past and a trailing ago.
export function parseDurationMs(input: string): number | null {
  const cleaned = (input || '')
    .trim()
    .toLowerCase()
    .replace(/^(last|past)\s+/, '')
    .replace(/\s+ago$/, '')
  const m = cleaned.match(/^(\d+(?:\.\d+)?)\s*(mo|min|m|hr|h|hours?|d|days?|w|weeks?)$/)
  if (!m) return null
  let u = m[2]
  if (u.startsWith('hour')) u = 'h'
  else if (u.startsWith('day')) u = 'd'
  else if (u.startsWith('week')) u = 'w'
  else if (u === 'hr') u = 'h'
  else if (u === 'min') u = 'm'
  const unit = UNIT_MS[u]
  return unit ? parseFloat(m[1]) * unit : null
}

/** The relative range from the earliest configured campaign flight's start (ET midnight of its
 * first day) to now: a window that grows with time instead of rolling, so a chart over every
 * campaign never drops a flight's first days. Typed as "since first campaign" in any range field;
 * stored as this token in `rangeRel`, recomputed on every load like "7d". */
export const SINCE_FIRST_CAMPAIGN = 'since first campaign'
export function isSinceFirstCampaign(input: string | undefined | null): boolean {
  return /^(since\s+)?(the\s+)?first\s+campaign$/.test((input || '').trim().toLowerCase())
}
/** ET midnight of the earliest configured flight start, or null while no flight has a start. */
export function firstCampaignStartMs(): number | null {
  const starts = CAMPAIGNS.map((c) => c.flightStart).filter((d): d is string => !!d).sort()
  return starts.length ? etMidnightUtcMs(starts[0]) : null
}

/** The end-side range token, paired with SINCE_FIRST_CAMPAIGN's start: closes the range once
 * every configured flight is over, instead of always ending "now" — so a chart over every
 * campaign (the flight-day chart) stops rescanning a growing window and its cache key stops
 * changing on every load, once there's nothing left to grow. The hour-of-day chart doesn't use
 * this — it stays open-ended (SINCE_FIRST_CAMPAIGN alone). Typed as "since first campaign until
 * last campaign ends" in a range field; stored as SINCE_FIRST_UNTIL_LAST_CAMPAIGN in `rangeRel`. */
export const UNTIL_LAST_CAMPAIGN_ENDS = 'until last campaign ends'
export const SINCE_FIRST_UNTIL_LAST_CAMPAIGN = `${SINCE_FIRST_CAMPAIGN} ${UNTIL_LAST_CAMPAIGN_ENDS}`
export function isSinceFirstUntilLastCampaign(input: string | undefined | null): boolean {
  return (input || '').trim().toLowerCase() === SINCE_FIRST_UNTIL_LAST_CAMPAIGN
}
/** ET midnight of the day after the LATEST configured flight's end, or null while any flight is
 * open-ended (no confirmed start — can't bound it) or hasn't reached its own end yet (active or
 * upcoming as of now) — i.e. not every flight is over. Recomputed on every call from the current
 * time, so it flips from null (range stays open, ending "now") to a fixed instant (range closes)
 * the moment the last flight's window ends, with no manual step (e.g. flipping a campaign's
 * `status`) required. */
export function lastCampaignEndMs(): number | null {
  const now = Date.now()
  let latest: number | null = null
  for (const c of CAMPAIGNS) {
    if (c.flightStart == null) return null // open-ended: no window to close on
    const endBoundMs = etFlightRangeMs(c.flightStart, c.flightEnd)[1] // ET midnight, day after flightEnd
    if (now < endBoundMs) return null // still active/upcoming: keep the range growing
    if (latest == null || endBoundMs > latest) latest = endBoundMs
  }
  return latest
}

/** Relative token → {since, until} ISO datetimes: a duration ("7d", "12mo"), SINCE_FIRST_CAMPAIGN
 * (until = now), or SINCE_FIRST_UNTIL_LAST_CAMPAIGN (until = now while any flight is open-ended
 * or still running, else the fixed instant every flight has ended by). */
export function relativeRange(input: string): { since: string; until: string } | null {
  if (isSinceFirstUntilLastCampaign(input)) {
    const start = firstCampaignStartMs()
    if (start == null) return null
    const end = lastCampaignEndMs()
    return { since: new Date(start).toISOString(), until: new Date(end ?? Date.now()).toISOString() }
  }
  if (isSinceFirstCampaign(input)) {
    const start = firstCampaignStartMs()
    return start == null ? null : { since: new Date(start).toISOString(), until: new Date().toISOString() }
  }
  const ms = parseDurationMs(input)
  if (ms == null || ms <= 0) return null
  const until = new Date()
  const since = new Date(until.getTime() - ms)
  return { since: since.toISOString(), until: until.toISOString() }
}

/** Rolling "last N days" (the preset chips). */
export function lastDays(n: number): { since: string; until: string } {
  const until = new Date()
  const since = new Date(until.getTime() - n * 86_400_000)
  return { since: since.toISOString(), until: until.toISOString() }
}

/** ISO datetime (or date) → "YYYY-MM-DD" for a <input type="date">. */
export function isoToYmd(iso: string): string {
  return (iso || '').slice(0, 10)
}

/** Date-picker values → ISO bounds: start of the from-day, end of the to-day. */
export function ymdRangeToISO(fromYmd: string, toYmd: string): { since: string; until: string } {
  return { since: `${fromYmd}T00:00:00.000Z`, until: `${toYmd}T23:59:59.999Z` }
}

/** Human label for a range: "Last 24h" / "Last 7d" when it ends ~now, else "Jun 1 – Jun 26";
 * "Since first campaign" when the stored relative token (`rel`) is that range. */
export function rangeLabel(since: string, until: string, rel?: string): string {
  if (isSinceFirstCampaign(rel) || isSinceFirstUntilLastCampaign(rel)) return 'Since first campaign'
  const s = new Date(since).getTime()
  const u = new Date(until).getTime()
  if (!isFinite(s) || !isFinite(u)) return ''
  const span = u - s
  const endsNow = Math.abs(Date.now() - u) < 180_000 // within 3 min of now
  if (endsNow) {
    const h = span / 3_600_000
    if (h < 1) return `Last ${Math.max(1, Math.round(span / 60_000))}m`
    if (h < 48) return `Last ${Math.round(h)}h`
    const d = Math.round(h / 24)
    if (d < 100) return `Last ${d}d`
    return `Last ${Math.round(d / 30)}mo`
  }
  const fmt = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return `${fmt(s)} – ${fmt(u)}`
}

/** Is this range "last n days" ending ~now? (for highlighting preset chips) */
export function isLastDays(since: string, until: string, n: number): boolean {
  const u = new Date(until).getTime()
  const s = new Date(since).getTime()
  if (!isFinite(u) || !isFinite(s)) return false
  if (Math.abs(Date.now() - u) > 180_000) return false
  const days = (u - s) / 86_400_000
  return Math.abs(days - n) < 0.2
}
