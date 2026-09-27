// Fast America/New_York (ET) calendar arithmetic for the hot paths of the Ads sync, which runs
// in a Worker with a 10 ms CPU budget per invocation on Workers Free. Intl.DateTimeFormat is
// exact but slow (and its first use in a fresh isolate is slower still); these functions apply
// the US Eastern DST rule directly: EDT (UTC-4) from 02:00 EST on the second Sunday of March to
// 02:00 EDT on the first Sunday of November, EST (UTC-5) otherwise (the rule in force since
// 2007). Checked against Intl hour by hour over several years in etTime.test.ts.
//
// No imports: safe in any runtime and cheap to bundle.

const HOUR = 3_600_000
const DAY = 24 * HOUR
const dstCache = new Map<number, [number, number]>()

/** [start, end) of EDT in `year`, as UTC ms. */
function dstBounds(year: number): [number, number] {
  let b = dstCache.get(year)
  if (!b) {
    const marchFirstDow = new Date(Date.UTC(year, 2, 1)).getUTCDay()
    const secondSundayMarch = 1 + ((7 - marchFirstDow) % 7) + 7
    const novFirstDow = new Date(Date.UTC(year, 10, 1)).getUTCDay()
    const firstSundayNov = 1 + ((7 - novFirstDow) % 7)
    b = [Date.UTC(year, 2, secondSundayMarch, 7), Date.UTC(year, 10, firstSundayNov, 6)]
    dstCache.set(year, b)
  }
  return b
}

/** ET offset from UTC in hours at `ms`: -4 (EDT) or -5 (EST). */
export function etOffsetHours(ms: number): -4 | -5 {
  const [start, end] = dstBounds(new Date(ms).getUTCFullYear())
  return ms >= start && ms < end ? -4 : -5
}

/** SQL expression giving a row's ET calendar date (YYYY-MM-DD) from its `ts` column (UTC ms) —
 * the SQL twin of etDateFast, with the same US DST rule: EDT (-4 h) inside each year's
 * [second Sunday of March 07:00Z, first Sunday of November 06:00Z), EST (-5 h) otherwise. The
 * EDT windows are computed here for `fromYear`..`toYear` and inlined as integers (constants
 * only, never request input); a row outside those years falls back to EST. Used by the
 * geo 'dateEt' dimension (functions/api/geo.ts). */
export function etDateSql(fromYear = 2024, toYear = 2040): string {
  return `date(${etShiftedSecondsSql(fromYear, toYear)}, 'unixepoch')`
}

/** SQL expression giving a row's ET wall-clock hour of day ('0'..'23', as text) — the SQL twin of
 * etHourFast, the same DST rule as etDateSql. Used by the geo 'hourEt' dimension. */
export function etHourSql(fromYear = 2024, toYear = 2040): string {
  return `CAST(CAST(strftime('%H', ${etShiftedSecondsSql(fromYear, toYear)}, 'unixepoch') AS INTEGER) AS TEXT)`
}

/** `ts` shifted to ET wall-clock time, in whole seconds (integer division of integer ms). */
function etShiftedSecondsSql(fromYear: number, toYear: number): string {
  const windows: string[] = []
  for (let y = fromYear; y <= toYear; y++) {
    const [start, end] = dstBounds(y)
    windows.push(`(ts >= ${start} AND ts < ${end})`)
  }
  return `(ts + CASE WHEN ${windows.join(' OR ')} THEN ${-4 * HOUR} ELSE ${-5 * HOUR} END) / 1000`
}

const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** The ET calendar date (YYYY-MM-DD) of an instant. */
export function etDateFast(ms: number): string {
  return ymd(new Date(ms + etOffsetHours(ms) * HOUR))
}

/** The ET wall-clock hour (0-23) of an instant. */
export function etHourFast(ms: number): number {
  return new Date(ms + etOffsetHours(ms) * HOUR).getUTCHours()
}

/** UTC ms of an ET wall-clock time ("HH:MM") on an ET date. For the one repeated hour in
 * November it returns the first (EDT) occurrence; the skipped March hour maps forward. */
export function etWallTimeMs(dateEt: string, hhmm = '00:00'): number {
  const [y, m, d] = dateEt.split('-').map(Number)
  const [hh, mm] = hhmm.split(':').map(Number)
  const naive = Date.UTC(y, m - 1, d, hh, mm)
  const edt = naive + 4 * HOUR
  return etOffsetHours(edt) === -4 ? edt : naive + 5 * HOUR
}

/** An ET date plus `days` (calendar arithmetic, no time zone involved). */
export function addDays(dateEt: string, days: number): string {
  const [y, m, d] = dateEt.split('-').map(Number)
  return ymd(new Date(Date.UTC(y, m - 1, d) + days * DAY))
}

/** lib/overview.ts sameTimeWindowMs without Intl: [ET midnight of `dateEt`, the same ET wall-clock
 * time (to the second) as `nowMs` on `dateEt`). DST-safe the same way: the wall-clock time is
 * re-applied to the date's own offset, and a time the date skips (spring forward) falls back to
 * the EST reading. Checked against sameTimeWindowMs in etTime.test.ts. */
export function etSameTimeWindow(dateEt: string, nowMs: number): [number, number] {
  const wall = new Date(nowMs + etOffsetHours(nowMs) * HOUR)
  const target = ((wall.getUTCHours() * 60 + wall.getUTCMinutes()) * 60 + wall.getUTCSeconds()) * 1000
  const [y, m, d] = dateEt.split('-').map(Number)
  const dayUtc = Date.UTC(y, m - 1, d)
  const start = etWallTimeMs(dateEt)
  for (const offsetHours of [5, 4]) {
    const candidate = dayUtc + offsetHours * HOUR + target
    const local = candidate + etOffsetHours(candidate) * HOUR
    if (local - dayUtc === target) return [start, candidate] // same date, same wall clock
  }
  return [start, dayUtc + 5 * HOUR + target]
}
