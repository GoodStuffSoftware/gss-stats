// Smart date text: turns what someone types ("last 30 days", "March", "Oct 1 to Nov 15", "11/3") into a calendar
// date or an inclusive date range. Shared (nothing in it is Budget-specific); the field that uses it is
// components/ui/SmartDateRange.vue.
//
// Dates are local calendar dates written 'YYYY-MM-DD'. "Today" is read from the clock's local getters, and all
// arithmetic after that works on the calendar date itself (UTC day numbers), so there is no time zone or DST drift and
// no day-shift near midnight. Our own rules cover the period words (this/last week, month, year, last N days, quarters,
// "since", month names, years); anything else goes to chrono-node (English only) for single dates and ranges.
//
// Conventions (the field shows what it understood before it applies, so these are visible):
//  - weeks run Sunday to Saturday (the calendar's first column);
//  - "this week / month / year" run to today, like the Budget presets; "last ..." and named periods are whole periods;
//  - "last N days" counts today as the last day; "last N months" is N calendar months, this one so far;
//  - a month or a month-and-day with no year means the most recent one that has begun ("Dec 5" in November 2026 is
//    Dec 5, 2025): these ranges look back at money already spent.
import { en as chrono, type ParsedComponents } from 'chrono-node' // the English parser only; unused locales are tree-shaken from the build

export type IsoDate = string
export type SmartDateResult =
  | { ok: true; from: IsoDate; to: IsoDate; label: string }
  | { ok: false; hint: string }

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MONTH_WORDS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
}
const MONTH_RE = Object.keys(MONTH_WORDS).sort((a, b) => b.length - a.length).join('|')
const MIN_YEAR = 1900
const MAX_YEAR = 2100

export const SMART_DATE_EXAMPLES = '"last 30 days", "March", "Oct 1 to Nov 15" or "11/3"'

// ── Calendar-date arithmetic (strings in, strings out) ───────────────────────────────────────────────────────
const pad = (n: number, w = 2) => String(n).padStart(w, '0')
/** The date for year, month (1-12) and day; overflow rolls over (month 13 is January next year, day 0 the month before). */
export function ymd(y: number, m: number, d: number): IsoDate {
  const t = new Date(Date.UTC(y, m - 1, d))
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}
/** Like ymd, but a day past the end of the month stops at the last day (Mar 31 minus a month is Feb 28, not Mar 3). */
function clampedYmd(y: number, m: number, d: number): IsoDate {
  const last = Number(ymd(y, m + 1, 0).slice(8, 10))
  return ymd(y, m, Math.min(d, last))
}
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/
/** True for a real calendar date written 'YYYY-MM-DD'. */
export function isIsoDate(s: unknown): s is IsoDate {
  if (typeof s !== 'string') return false
  const m = ISO_RE.exec(s)
  if (!m) return false
  return ymd(Number(m[1]), Number(m[2]), Number(m[3])) === s
}
function split(s: IsoDate): [number, number, number] {
  const m = ISO_RE.exec(s)
  if (!m) throw new RangeError('not an ISO date')
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}
export function addDays(s: IsoDate, n: number): IsoDate {
  const [y, m, d] = split(s)
  return ymd(y, m, d + n)
}
/** 0 = Sunday ... 6 = Saturday. */
export function weekday(s: IsoDate): number {
  const [y, m, d] = split(s)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}
/** Whole days from a to b (negative when b is earlier). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  const [y1, m1, d1] = split(a)
  const [y2, m2, d2] = split(b)
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000)
}
/** Today's calendar date from the clock's local getters. */
export function localToday(now: Date = new Date()): IsoDate {
  return ymd(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

// ── Labels ───────────────────────────────────────────────────────────────────────────────────────────────────
/** 'Nov 3, 2026'. */
export function formatDate(s: IsoDate): string {
  const [y, m, d] = split(s)
  return `${MONTH_SHORT[m - 1]} ${d}, ${y}`
}
/** 'Nov 3, 2026' for one day; 'Oct 1 – Nov 15, 2026' for a range inside one year; 'Dec 1, 2025 – Jan 15, 2026' across years. */
export function formatRange(from: IsoDate, to: IsoDate): string {
  if (from === to) return formatDate(from)
  const [y1, m1, d1] = split(from)
  const [y2] = split(to)
  if (y1 === y2) return `${MONTH_SHORT[m1 - 1]} ${d1} – ${formatDate(to)}`
  return `${formatDate(from)} – ${formatDate(to)}`
}
/** 'March 2026'. */
export function monthName(y: number, m: number): string {
  return `${MONTH_LONG[m - 1]} ${y}`
}

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────────────────────
function ok(from: IsoDate, to: IsoDate): SmartDateResult {
  return { ok: true, from, to, label: formatRange(from, to) }
}
function unreadable(text: string): SmartDateResult {
  const shown = text.length > 40 ? `${text.slice(0, 37)}...` : text
  return { ok: false, hint: `Couldn't read "${shown}". Try ${SMART_DATE_EXAMPLES}.` }
}
const yearOk = (y: number) => y >= MIN_YEAR && y <= MAX_YEAR

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[–—]/g, ' - ')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;!?]+$/, '')
    .replace(/(?<=[\da-z])\s*-\s*(?=[a-z])/g, ' - ') // 'Oct 1-Nov 15'; an ISO date's hyphens stay
    .trim()
}

/** The month (1-12) in `year` or, with no year, the most recent such month that has begun by `today`. */
function monthYear(month: number, year: number | null, today: IsoDate): [number, number] {
  if (year !== null) return [year, month]
  const [ty, tm] = split(today)
  return [month > tm ? ty - 1 : ty, month]
}
function monthRange(y: number, m: number): SmartDateResult {
  return ok(ymd(y, m, 1), ymd(y, m + 1, 0))
}
function quarterRange(y: number, q: number): SmartDateResult {
  return ok(ymd(y, (q - 1) * 3 + 1, 1), ymd(y, q * 3 + 1, 0))
}

/** Our own rules for period words. Null when none applies. */
function parseWords(t: string, today: IsoDate): SmartDateResult | null {
  const [ty, tm, td] = split(today)
  const unit = '(day|week|month|year)s?'

  if (t === 'today') return ok(today, today)
  if (t === 'yesterday') return ok(addDays(today, -1), addDays(today, -1))
  if (/^(ytd|year to date)$/.test(t)) return ok(ymd(ty, 1, 1), today)
  if (/^(mtd|month to date)$/.test(t)) return ok(ymd(ty, tm, 1), today)

  let m = new RegExp(`^(?:the )?(this|current|last|previous) (week|month|year|quarter)$`).exec(t)
  if (m) {
    const past = m[1] === 'last' || m[1] === 'previous'
    switch (m[2]) {
      case 'week': {
        const start = addDays(today, -weekday(today))
        return past ? ok(addDays(start, -7), addDays(start, -1)) : ok(start, today)
      }
      case 'month':
        return past ? monthRange(ty, tm - 1) : ok(ymd(ty, tm, 1), today)
      case 'year':
        return past ? ok(ymd(ty - 1, 1, 1), ymd(ty - 1, 12, 31)) : ok(ymd(ty, 1, 1), today)
      default: {
        const q = Math.floor((tm - 1) / 3) + 1
        if (!past) return ok(ymd(ty, (q - 1) * 3 + 1, 1), today)
        return q === 1 ? quarterRange(ty - 1, 4) : quarterRange(ty, q - 1)
      }
    }
  }

  // "last 7 days", "past 30 days", "last 3 months", "last week" handled above; "last a/one/an <unit>" is not a thing.
  m = new RegExp(`^(?:the )?(?:last|past|previous) (\\d{1,4}) ${unit}$`).exec(t)
  if (m) {
    const n = Number(m[1])
    if (n < 1 || (m[2] === 'year' && n > 200)) return unreadable(t)
    switch (m[2]) {
      case 'day': return ok(addDays(today, -(n - 1)), today)
      case 'week': return ok(addDays(today, -(n * 7 - 1)), today)
      case 'month': return ok(ymd(ty, tm - (n - 1), 1), today)
      default: return ok(addDays(clampedYmd(ty - n, tm, td), 1), today)
    }
  }
  if (/^past (week|month|year)$/.test(t)) {
    // "the past week" = the last 7 days; month and year likewise back from today.
    if (t === 'past week') return ok(addDays(today, -6), today)
    if (t === 'past month') return ok(addDays(clampedYmd(ty, tm - 1, td), 1), today)
    return ok(addDays(clampedYmd(ty - 1, tm, td), 1), today)
  }

  // Quarters: "Q3", "Q3 2025", "2025 Q3", "3Q 2025".
  m = /^(?:q([1-4])|([1-4])q)(?: (\d{4}))?$/.exec(t) ?? /^(\d{4}) q([1-4])$/.exec(t)
  if (m) {
    const qs = t.startsWith('q') || /^\dq/.test(t)
    const q = Number(qs ? (m[1] ?? m[2]) : m[2])
    const y = qs ? (m[3] ? Number(m[3]) : null) : Number(m[1])
    if (y !== null && !yearOk(y)) return null
    const cq = Math.floor((tm - 1) / 3) + 1
    return quarterRange(y ?? (q > cq ? ty - 1 : ty), q)
  }

  m = /^(?:in |during |for )?(\d{4})$/.exec(t)
  if (m) {
    const y = Number(m[1])
    return yearOk(y) ? ok(ymd(y, 1, 1), ymd(y, 12, 31)) : null
  }

  m = new RegExp(`^(?:in |during |for )?(${MONTH_RE})(?: (\\d{4}))?$`).exec(t)
  if (m) {
    const year = m[2] ? Number(m[2]) : null
    if (year !== null && !yearOk(year)) return null
    const [y, mo] = monthYear(MONTH_WORDS[m[1]], year, today)
    return monthRange(y, mo)
  }
  return null
}

type ChronoParsed = ParsedComponents
function components(c: ChronoParsed, today: IsoDate, keepYear = false): { date: IsoDate; yearGiven: boolean; dayGiven: boolean } | null {
  const y = c.get('year')
  const mo = c.get('month')
  const d = c.get('day')
  if (y === null || mo === null || d === null) return null
  const yearGiven = c.isCertain('year')
  const dayGiven = c.isCertain('month') && c.isCertain('day')
  let date = ymd(y, mo, d)
  // "Dec 5" / "11/3" with no year: the most recent one on or before today.
  if (!keepYear && !yearGiven && dayGiven && date > today) date = ymd(y - 1, mo, d)
  return { date, yearGiven, dayGiven }
}

/** chrono-node for single dates ("Nov 3", "11/3", "2026-11-03", "3 days ago") and ranges ("Oct 1 to Nov 15"). */
function parseWithChrono(t: string, today: IsoDate): SmartDateResult | null {
  // "between A and B" and "from A to B" are "A to B".
  let s = t
  const between = /^between (.+?) and (.+)$/.exec(s)
  if (between) s = `${between[1]} to ${between[2]}`
  else s = s.replace(/^from /, '')

  const [ty, tm, td] = split(today)
  const reference = new Date(ty, tm - 1, td, 12, 0, 0) // noon: no day shift from a DST change or the time of day
  const results = chrono.parse(s, { instant: reference }, { forwardDate: false })
  if (results.length !== 1) return null
  const r = results[0]
  if (r.index !== 0 || r.text.length !== s.length) return null

  // A year typed on the end ("Jan 1 to Mar 5 2027") is the start's year too (chrono copies it over): no look-back for the start.
  const a = components(r.start, today, !!r.end && r.end.isCertain('year'))
  if (!a || !yearOk(Number(a.date.slice(0, 4)))) return null
  let from = a.date
  let to = a.date
  if (r.end) {
    const b = components(r.end, today)
    if (!b || !yearOk(Number(b.date.slice(0, 4)))) return null
    to = b.date
    // "Dec 1 to Jan 15": with no years given the start belongs to the year before the end.
    if (to < from && !a.yearGiven && a.dayGiven) from = ymd(Number(from.slice(0, 4)) - 1, Number(from.slice(5, 7)), Number(from.slice(8, 10)))
    if (to < from) [from, to] = [to, from]
  }
  return ok(from, to)
}

/**
 * The calendar dates a phrase means, as of `now` (the clock; only its local calendar date is used).
 * Blank text is not readable (callers keep the current dates and show nothing for it).
 */
export function parseSmartDate(text: string, now: Date = new Date()): SmartDateResult {
  try {
    return parseUnguarded(text, now)
  } catch {
    return unreadable(String(text).trim()) // no typed text may throw while the field renders
  }
}
function parseUnguarded(text: string, now: Date): SmartDateResult {
  const today = localToday(now)
  const t = normalize(text)
  if (!t) return unreadable(text.trim())

  const since = /^since (.+)$/.exec(t)
  if (since) {
    const inner = parseSmartDate(since[1], now)
    if (!inner.ok) return unreadable(text.trim())
    if (inner.from > today) return { ok: false, hint: `"${text.trim()}" starts after today.` }
    return ok(inner.from, today)
  }

  const words = parseWords(t, today)
  if (words) return words
  return parseWithChrono(t, today) ?? unreadable(text.trim())
}
