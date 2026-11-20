// Account and card numbers never reach the database or the browser: every run of 5 or more digits in
// free text is cut to a bullet plus its last four. Pure; used by the import path (Functions, tool).

const LONG_RUN = /\d{5,}/g

/** Runs of 5+ digits become `•` + their last 4 digits, so the result has no 5-digit run. */
export function maskDigits(s: string): string {
  return s.replace(LONG_RUN, (run) => '•' + run.slice(-4))
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
