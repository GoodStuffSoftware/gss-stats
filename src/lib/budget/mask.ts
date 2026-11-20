// Account and card numbers never reach the database or the browser: every run of 5 or more digits in
// free text is cut to a bullet plus its last four, and so is a number printed in groups (digit groups
// joined by single spaces or dashes). Pure; used by the load tool (scripts/budget) through import.ts.

const LONG_RUN = /\d{5,}/g

// Digit groups (2+ digits each) joined by single spaces or dashes: `1234 5678 9012 3456`, `1234-5678-90`.
// The replacer masks one only when it holds 9+ digits in all, so amounts, times and short reference
// numbers (under 9 digits) are never touched. Alternatives are tried in order at each position: a date
// (`2026-11-20`, `11-20-2026`) and a phone number (`555-123-4567`, `(555) 123-4567`, `1-555-123-4567`)
// are matched first and left as written.
const DATE = String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})(?!\d)`
const PHONE = String.raw`(?:\(\d{3}\)\s?|(?:1[-. ])?\d{3}[-. ])\d{3}[-. ]\d{4}(?!\d)`
const GROUPED = String.raw`\d{2,}(?:[ -]\d{2,})+(?!\d)`
const GROUPED_NUMBER = new RegExp(String.raw`(?<![\d])(?:(${DATE})|(${PHONE})|(${GROUPED}))`, 'g')

/** A number printed in digit groups (9+ digits in all) becomes `•` + its last 4 digits. */
function maskGrouped(s: string): string {
  return s.replace(GROUPED_NUMBER, (match, date: string | undefined, phone: string | undefined) => {
    if (date || phone) return match
    const digits = match.replace(/\D/g, '')
    return digits.length >= 9 ? '•' + digits.slice(-4) : match
  })
}

/** Grouped numbers and runs of 5+ digits become `•` + their last 4 digits, so the result has no 5-digit run. */
export function maskDigits(s: string): string {
  return maskGrouped(s).replace(LONG_RUN, (run) => '•' + run.slice(-4))
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
