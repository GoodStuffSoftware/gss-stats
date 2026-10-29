// The new-version prompt's pure logic (the polling lives in composables/useBuildCheck.ts).
// The build id is a string that changes on every production build; 'dev' means "not a release build".

export const BUILD_ID_URL = '/build-id.json'
/** How often an open, visible tab asks whether a newer build is live. */
export const BUILD_CHECK_INTERVAL_MS = 5 * 60 * 1000

/** The id in a fetched build-id.json body, or null for anything else (a sign-in page, an error). */
export function parseBuildId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const id = (body as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : null
}

/** True iff the live build differs from the one this tab runs. Unknown on either side is "no". */
export function isNewerBuild(current: string, live: string | null): boolean {
  if (live === null || current === 'dev') return false
  return live !== current
}

export const RELOAD_BANNER_TEXT = 'A new version of the site is available'
export const RELOAD_DISCARD_TEXT = 'Reloading discards your unsaved changes.'

/** The banner's second line: only when reloading would lose something. */
export function reloadBannerWarning(hasUnsaved: boolean): string {
  return hasUnsaved ? RELOAD_DISCARD_TEXT : ''
}

/** True when a reload would lose edits: a card/chart editor is open, or the layout save failed,
 *  is blocked, or was refused as stale. A save that is merely pending ('saving') is not counted:
 *  leaving the page flushes it (pagehide keepalive). */
export function hasUnsavedWork(editorOpen: boolean, saveState: string): boolean {
  return editorOpen || saveState === 'error' || saveState === 'blocked' || saveState === 'stale'
}
