// Account and card numbers never reach the database or the browser: every run of 5 or more digits in
// free text is cut to a bullet plus its last four, and so is a number printed in groups (digit groups
// joined by single spaces, dashes or slashes). Pure; used by the load tool (scripts/budget) through import.ts.

const LONG_RUN = /\d{5,}/g

// A run of digit groups joined by single spaces, dashes or slashes: `1234 5678 9012 3456`, `1234-5678-90`,
// `STORE 0412 2026-11-20`. Each run is split into groups; dates inside it are set aside first, what is
// left between them is a number of its own and is masked when it holds 9+ digits in all. Amounts, times,
// short reference numbers (under 9 digits) and a lone phone number are never touched.
const GROUP_RUN = /(?<!\d)\d+(?:[ /-]\d+)+(?!\d)/g

const isMonthDay = (a: string, b: string): boolean => {
  const m = Number(a)
  const d = Number(b)
  return m >= 1 && m <= 12 && d >= 1 && d <= 31
}
const monthDay = (a: string, b: string): boolean => isMonthDay(a, b) || isMonthDay(b, a)
const isYear = (g: string): boolean => g.length === 2 || (g.length === 4 && /^(19|20)/.test(g))
const dateSep = (s: string): boolean => s === '-' || s === '/'

/** How many groups, starting at group `i`, read as a date; 0 when none do.
 *  `YYYY-MM-DD`, `MM-DD-YY(YY)` and `MM/DD/YY(YY)` (day and month either way round) and `MM-DD`. */
function dateLength(g: string[], s: string[], i: number): number {
  if (i + 2 < g.length) {
    const iso = s[i] === '-' && s[i + 1] === '-' && /^(19|20)\d\d$/.test(g[i]) && g[i + 1].length === 2 && g[i + 2].length === 2
    const us = dateSep(s[i]) && s[i] === s[i + 1] && g[i].length <= 2 && g[i + 1].length <= 2 && isYear(g[i + 2])
    if ((iso && monthDay(g[i + 1], g[i + 2])) || (us && monthDay(g[i], g[i + 1]))) return 3
  }
  if (i + 1 < g.length && dateSep(s[i]) && g[i].length <= 2 && g[i + 1].length <= 2 && monthDay(g[i], g[i + 1])) return 2
  return 0
}

/** The groups that belong to a date standing alone: a space or nothing on each side, or one dash or
 *  slash to another date (a period `2026-10-21-2026-11-20`, `10/21/26-11/20/26`). A date that a dash or
 *  slash joins to anything else is part of a longer number and is not kept. */
function dateGroups(g: string[], s: string[]): boolean[] {
  const found: Array<{ start: number; end: number }> = [] // [start, end) in groups
  for (let i = 0; i < g.length; ) {
    const len = dateLength(g, s, i)
    if (len) found.push({ start: i, end: i + len })
    i += len || 1
  }
  const keep = g.map(() => false)
  found.forEach((d, k) => {
    const before = d.start === 0 || s[d.start - 1] === ' ' || (found[k - 1]?.end === d.start)
    const after = d.end >= g.length || s[d.end - 1] === ' ' || (found[k + 1]?.start === d.end)
    if (before && after) for (let j = d.start; j < d.end; j++) keep[j] = true
  })
  return keep
}

/** A lone phone number: groups of 3-3-4, or 1-3-3-4, joined by spaces or dashes. */
function isPhone(groups: string[], seps: string[]): boolean {
  if (seps.some((x) => x === '/')) return false
  const shape = groups.map((x) => x.length).join('-')
  return shape === '3-3-4' || shape === '1-3-3-4'
}

function maskRun(run: string): string {
  const groups = run.split(/[ /-]/)
  const seps = run.match(/[ /-]/g) ?? []
  const keep = dateGroups(groups, seps) // part of a date: left as written
  let out = ''
  for (let i = 0; i < groups.length; ) {
    if (keep[i]) {
      out += groups[i]
      if (i < seps.length) out += seps[i]
      i++
      continue
    }
    let j = i // the stretch of groups [i, j] that are not part of a date
    while (j + 1 < groups.length && !keep[j + 1]) j++
    const part = groups.slice(i, j + 1)
    const inner = seps.slice(i, j)
    const digits = part.join('')
    if (digits.length >= 9 && !isPhone(part, inner)) out += '•' + digits.slice(-4)
    else part.forEach((x, k) => (out += x + (k < inner.length ? inner[k] : '')))
    if (j < seps.length) out += seps[j]
    i = j + 1
  }
  return out
}

/** Grouped numbers and runs of 5+ digits become `•` + their last 4 digits, so the result has no 5-digit run. */
export function maskDigits(s: string): string {
  return s.replace(GROUP_RUN, maskRun).replace(LONG_RUN, (run) => '•' + run.slice(-4))
}

/** The last four digits of `s` (digits only), or null when it holds fewer than four digits. */
export function last4(s: string): string | null {
  const digits = s.replace(/\D/g, '')
  return digits.length >= 4 ? digits.slice(-4) : null
}

/** True when `s` still carries a run of 5+ digits (validation for fields that must be masked). */
export function hasLongDigitRun(s: string): boolean {
  return /\d{5,}/.test(s)
}
