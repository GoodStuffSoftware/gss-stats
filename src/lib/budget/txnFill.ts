// Fetch the remaining pages of the current period, so the Transactions toolbar (search, filter, sort) sees every
// transaction in it, not only the pages loaded so far. One request per page through the existing paging endpoint; no
// per-row calls, and nothing from the toolbar goes in the request.

/** The slice of the table model the loader needs. */
export interface PagedModel {
  nextCursor: { value: string | null }
  loadError: { value: string | null }
  loadMore: () => Promise<void>
}

/** Safety stop: pages fetched in one run. */
export const MAX_FILL_PAGES = 100

/** Returns the number of pages fetched. Stops at the last page, on an error, or when `stillWanted` turns false. */
export async function loadRemainingPages(model: PagedModel, stillWanted: () => boolean = () => true): Promise<number> {
  let pages = 0
  while (model.nextCursor.value && !model.loadError.value && stillWanted() && pages < MAX_FILL_PAGES) {
    const before = model.nextCursor.value
    await model.loadMore()
    pages++
    if (model.nextCursor.value === before && !model.loadError.value) break // loadMore did nothing (busy or a new query)
  }
  return pages
}

/**
 * One fill run per filter activation and period. `sync` is called whenever the filters, the query or the loading flag change:
 * it starts a run when the filters are on and none has run for this load of this query, and cancels the run in flight when the
 * filters go off, the query changes or a fresh load starts. A run's own pages never start another, so MAX_FILL_PAGES holds.
 */
export function createFillRunner(model: PagedModel, active: () => boolean) {
  let ranKey: string | null = null
  let runId = 0
  return {
    sync(queryKey: string, loading: boolean): Promise<number> | null {
      if (!active() || loading) {
        ranKey = null
        runId++
        return null
      }
      if (ranKey === queryKey) return null
      ranKey = queryKey
      const mine = ++runId
      return loadRemainingPages(model, () => mine === runId && active())
    },
    cancel() {
      ranKey = null
      runId++
    },
  }
}
