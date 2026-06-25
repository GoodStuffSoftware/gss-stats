// Smart date-range helpers. The filter `since`/`until` are ISO datetime strings
// (with back-compat for legacy "YYYY-MM-DD" day values).

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
export function parseDurationMs(input: string): number | null {
  const m = (input || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(mo|min|m|hr|h|hours?|d|days?|w|weeks?)$/)
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

/** Relative token → {since, until} ISO datetimes (until = now). */
export function relativeRange(input: string): { since: string; until: string } | null {
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

/** Human label for a range: "Last 24h" / "Last 7d" when it ends ~now, else "Jun 1 – Jun 26". */
export function rangeLabel(since: string, until: string): string {
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
