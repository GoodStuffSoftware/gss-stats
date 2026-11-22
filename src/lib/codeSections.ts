// Code-defined sections the ☰ menu appends after the layout's pages (docs/adr/0007-budget-section.md).
// A section is not a page of the KV layout: it is listed here, drawn by its own components, and shown in
// the menu only when its own access check says so. Adding one = one entry; the menu and App.vue stay generic.
import { probeAccess } from './budget/clientRead'
import { BUDGET_PAGES, BUDGET_SECTION } from './budget/sectionLink'
import type { IconKey } from './icons'

export interface CodeSection {
  id: string
  label: string
  icon: IconKey
  /** True when this account may open the section. Must never throw; false hides it. */
  access: () => Promise<boolean>
  /** Optional pages of the section, listed as sub-rows under it; the first is the default. */
  pages?: { id: string; label: string }[]
}

export interface NavSection {
  id: string
  label: string
  icon: IconKey
  pages?: { id: string; label: string }[]
}

export const CODE_SECTIONS: readonly CodeSection[] = [
  // The access probe is GET /api/budget/access, once per page load (clientRead.probeAccess, memoized).
  { id: BUDGET_SECTION, label: 'Budget', icon: 'wallet', pages: BUDGET_PAGES.map((p) => ({ ...p })), access: async () => (await probeAccess()).state === 'ok' },
]

/** The sections this account may open, in list order; a failing check hides that section only. */
export async function accessibleSections(sections: readonly CodeSection[] = CODE_SECTIONS): Promise<NavSection[]> {
  const checks = await Promise.all(
    sections.map(async (s) => {
      try {
        return (await s.access()) === true
      } catch {
        return false
      }
    }),
  )
  return sections.filter((_, i) => checks[i]).map(({ id, label, icon, pages }) => (pages ? { id, label, icon, pages } : { id, label, icon }))
}
