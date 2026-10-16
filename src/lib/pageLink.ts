// Page deep links: `https://stats.goodstuff.software/?page=<page id>` opens that page.
//
// The page param only ever PICKS among the pages in the loaded config (initialPageId checks the id
// against them), so a made-up or hostile value changes nothing: it falls back to the remembered or
// landing page. It is never used as a URL, a redirect target or HTML. The sign-in redirect carries
// the link through the existing same-origin-only `next` handling (functions/_lib/auth.ts safeNext).
// Pure, so the tests need no browser.

export const PAGE_PARAM = 'page'
const ID_MAX = 200

/** The page id a URL query string asks for, or undefined (no param, empty, or longer than any id). */
export function linkedPageId(search: string): string | undefined {
  let v: string | null
  try {
    v = new URLSearchParams(search).get(PAGE_PARAM)
  } catch {
    return undefined
  }
  return v && v.length <= ID_MAX ? v : undefined
}

/** The query string that names `pageId`, every other param kept (`?utm_…` and the like). An empty
 * id leaves the query as it was. Returns '' or a string starting with '?'. */
export function searchWithPage(search: string, pageId: string): string {
  const params = new URLSearchParams(search)
  if (pageId) params.set(PAGE_PARAM, pageId)
  const s = params.toString()
  return s ? `?${s}` : ''
}
