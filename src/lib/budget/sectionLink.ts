// Budget section deep link: `?section=budget` opens the Budget section instead of a dashboard page
// (docs/adr/0007-budget-section.md). Kept beside `?page=` (lib/pageLink.ts): every other query param
// survives opening and closing. The section's own view state lives in `b_*` params (viewState.ts);
// closing the section drops them with `section`. Pure, so tests need no browser.

export const SECTION_PARAM = 'section'
export const BUDGET_SECTION = 'budget'
/** Every param the section's own view state uses starts with this (viewState.ts). */
export const BUDGET_PARAM_PREFIX = 'b_'

/** True when the query string asks for the Budget section. */
export function budgetSectionOpen(search: string): boolean {
  try {
    return new URLSearchParams(search).get(SECTION_PARAM) === BUDGET_SECTION
  } catch {
    return false
  }
}

/** The query string with the Budget section opened (`section=budget`) or closed (`section` and the
 * section's `b_*` params removed), every other param kept. Returns '' or a string starting with '?'. */
export function searchWithSection(search: string, open: boolean): string {
  const params = new URLSearchParams(search)
  if (open) {
    params.set(SECTION_PARAM, BUDGET_SECTION)
  } else {
    params.delete(SECTION_PARAM)
    for (const k of Array.from(params.keys())) if (k.startsWith(BUDGET_PARAM_PREFIX)) params.delete(k)
  }
  const s = params.toString()
  return s ? `?${s}` : ''
}
