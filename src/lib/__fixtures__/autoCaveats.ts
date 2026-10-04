// The v16 step (seedHiddenAutoCaveatsV16, decision D2-B) on a pre-v16 layout: every chart hides
// the hideable automatic scope caveats it did not show before. The older migration tests compare a
// loaded layout with the stored one, so they apply this step to the stored side. What the step
// itself adds to the production layout is pinned in defaults.captions.test.ts.
import type { DashboardConfig, DashboardPage, Widget } from '../../types'
import { seedHiddenAutoCaveatsV16 } from '../defaults'

/** `cfg` as a pre-v16 layout loads it: each page through seedHiddenAutoCaveatsV16. */
export function withV16Caveats<T extends DashboardConfig>(cfg: T): T {
  return { ...cfg, pages: cfg.pages.map(seedHiddenAutoCaveatsV16) }
}

/** The same step on a bare widget list. */
export function widgetsWithV16Caveats(widgets: Widget[]): Widget[] {
  return seedHiddenAutoCaveatsV16({ widgets } as DashboardPage).widgets
}
