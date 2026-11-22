// The Budget page (Overview or Loans) this viewer last used, remembered per signed-in login in this browser's
// localStorage (lib/loginStorage.ts): picking "Budget" in the ☰ menu reopens it. Nothing is kept for an
// unknown login. A stored value that is not a known page reads as Overview.
import { readLoginItem, writeLoginItem } from '../loginStorage'
import { parseBudgetPage, type BudgetPage } from './sectionLink'

export const LAST_PAGE_PREFIX = 'gss-stats-budget-page'

export function readLastPage(email: string | null | undefined): BudgetPage {
  return parseBudgetPage(readLoginItem(LAST_PAGE_PREFIX, email))
}
export function writeLastPage(email: string | null | undefined, page: BudgetPage): void {
  writeLoginItem(LAST_PAGE_PREFIX, email, page)
}
