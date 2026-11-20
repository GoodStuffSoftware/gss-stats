// en-US USD helpers. Money is integer cents everywhere; these are the only places that turn it into text.
import type { Cents } from './types'

/** `-123456` -> `-$1,234.56`. Throws on a non-integer (a float here is a bug upstream). */
export function formatCents(c: Cents): string {
  if (!Number.isSafeInteger(c)) throw new RangeError('formatCents: not a safe integer')
  const neg = c < 0
  const abs = Math.abs(c)
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const cents = String(abs % 100).padStart(2, '0')
  return `${neg ? '-' : ''}$${dollars}.${cents}`
}

/**
 * `$1,234.56`, `1234.5`, `-12`, `(12.00)`, `12.00-` -> cents; anything else (text, 3 decimals, bad
 * grouping, empty) -> null. Never returns -0.
 */
export function parseMoney(s: string): Cents | null {
  let t = s.trim().replace(/−/g, '-')
  let neg = false
  if (t.startsWith('(') && t.endsWith(')')) { neg = true; t = t.slice(1, -1).trim() }
  if (t.startsWith('-')) { neg = true; t = t.slice(1).trim() }
  else if (t.startsWith('+')) t = t.slice(1).trim()
  if (t.endsWith('-')) { neg = true; t = t.slice(0, -1).trim() }
  if (t.startsWith('$')) t = t.slice(1).trim()
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{1,2}))?$/.exec(t)
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  const whole = m[1] ? Number(m[1].replace(/,/g, '')) : 0
  const frac = m[2] ? Number(m[2].padEnd(2, '0')) : 0
  const cents = whole * 100 + frac
  if (!Number.isSafeInteger(cents)) return null
  return neg && cents !== 0 ? -cents : cents
}
