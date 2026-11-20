// Date helpers. ISO dates ('YYYY-MM-DD') are compared as text everywhere else; arithmetic goes through
// UTC day numbers so there is no time zone or DST in it.
import type { IsoDate } from './types'

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86_400_000

function dayNumber(y: number, m: number, d: number): number {
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS)
}

/** True when `s` is a real calendar date written 'YYYY-MM-DD'. */
export function isIsoDate(s: unknown): s is IsoDate {
  if (typeof s !== 'string') return false
  const m = ISO.exec(s)
  if (!m) return false
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

function parts(iso: IsoDate): [number, number, number] {
  if (!isIsoDate(iso)) throw new RangeError('not an ISO date')
  const m = ISO.exec(iso)!
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

export function toDayNumber(iso: IsoDate): number {
  const [y, m, d] = parts(iso)
  return dayNumber(y, m, d)
}

export function fromDayNumber(n: number): IsoDate {
  return new Date(n * DAY_MS).toISOString().slice(0, 10)
}

export function addDays(iso: IsoDate, n: number): IsoDate {
  return fromDayNumber(toDayNumber(iso) + n)
}

/** Whole days from `a` to `b` (negative when b is earlier). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return toDayNumber(b) - toDayNumber(a)
}

function validMd(y: number, mm: number, dd: number): boolean {
  if (!Number.isInteger(mm) || !Number.isInteger(dd) || mm < 1 || mm > 12 || dd < 1 || dd > 31) return false
  const t = new Date(Date.UTC(y, mm - 1, dd))
  return t.getUTCMonth() === mm - 1 && t.getUTCDate() === dd
}

/**
 * Card lines carry month and day only. Pick the year that puts the date on or before `anchor` + 7 days
 * (a purchase cannot be posted much before it happened) and nearest to the anchor, looking at the
 * anchor's year and its neighbours, so Dec lines on a January statement land in the year before. A date
 * more than `maxBackDays` before the anchor does not qualify; if nothing qualifies the nearest date
 * either way is returned. Throws RangeError for a month/day that exists in no candidate year.
 */
export function inferYear(mm: number, dd: number, anchor: IsoDate, maxBackDays = 330): IsoDate {
  const anchorDay = toDayNumber(anchor)
  const ay = Number(anchor.slice(0, 4))
  let best: { diff: number; day: number } | null = null
  let nearest: { diff: number; day: number } | null = null
  for (const y of [ay - 1, ay, ay + 1]) {
    if (!validMd(y, mm, dd)) continue
    const day = dayNumber(y, mm, dd)
    const diff = day - anchorDay
    if (!nearest || Math.abs(diff) < Math.abs(nearest.diff)) nearest = { diff, day }
    if (diff <= 7 && diff >= -maxBackDays && (!best || diff > best.diff)) best = { diff, day }
  }
  const pick = best ?? nearest
  if (!pick) throw new RangeError('inferYear: no such month/day')
  return fromDayNumber(pick.day)
}

/** `MM/DD/YY`, `MM-DD-YY`, `MM.DD.YY` or `MMDDYY` -> ISO. Years 00-69 are 20xx, 70-99 are 19xx. */
export function twoDigitYear(mmddyy: string): IsoDate {
  const m = /^(\d{2})[/.-]?(\d{2})[/.-]?(\d{2})$/.exec(mmddyy.trim())
  if (!m) throw new RangeError('twoDigitYear: bad date')
  const yy = Number(m[3])
  const y = yy <= 69 ? 2000 + yy : 1900 + yy
  const mm = Number(m[1]), dd = Number(m[2])
  if (!validMd(y, mm, dd)) throw new RangeError('twoDigitYear: bad date')
  return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
}
