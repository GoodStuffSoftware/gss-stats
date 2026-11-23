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
