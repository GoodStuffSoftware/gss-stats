/// <reference types="@cloudflare/workers-types" />
//
// Durable dashboard config storage backed by Cloudflare KV (binding STATS_CONFIG).
// Survives across browsers/devices — more durable than localStorage. Access is
// gated by Cloudflare Access (only the owner reaches this Function), so a single
// shared key is fine.
//
// BACKUP ON A LAYOUT-VERSION BUMP: the client migrates a saved layout forward on load
// (src/lib/defaults.ts normalizeConfig, CONFIG_VERSION) and saves the result back here. Before
// the first save of a NEWER version overwrites an older stored config, the older value is copied
// once to `dashboard:default:backup:v<old version>` (never overwritten after that), so a bad
// migration is recoverable by copying that key back (README "Restoring a layout backup"). One
// KV write per version bump — well inside the Free plan's 1,000 writes a day. A save from an
// OLDER layout version than the stored one is refused with 409 (see onRequestPut).
//
// ROLLING BACKUP ON EVERY CHANGE (the server-side backstop to the client's load guard): a tab
// that never loaded the real layout (a failed or partial load, an old tab, a lost update between
// two tabs) can still PUT a same-version layout, which the version guard cannot tell from a real
// edit. So before a save replaces `dashboard:default` with DIFFERENT content, the stored value is
// copied to `dashboard:default:prev`; the first changing save of each ET calendar day also copies
// it to `dashboard:default:day:<YYYY-MM-DD>` (kept 30 days), so a good copy survives even after
// several bad saves have rotated `:prev`. A save identical to what is stored writes nothing.
// FAIL-CLOSED like the version backup: these copies are written BEFORE the layout (and after the
// version backup), and if one cannot be written the save is refused with 503 and the stored
// layout is left as it was. KV writes per changing save: 2 (3 on the first of an ET day); per
// identical save: 0. Restore steps: README "Restoring the layout".

import { CONFIG_VERSION } from '../../src/lib/defaults'
import { etDateFast } from '../../src/lib/etTime'

interface Env {
  STATS_CONFIG: KVNamespace
}

const KEY = 'dashboard:default'

/** The rolling copy of the layout as it was before the most recent changing save. */
export const PREV_KEY = `${KEY}:prev`

/** The copy of the layout as it stood before the first changing save of ET calendar day `dateEt`. */
export function dayKeyFor(dateEt: string): string {
  return `${KEY}:day:${dateEt}`
}

/** How long a daily snapshot is kept (KV expirationTtl, in seconds): 30 days. */
export const DAY_SNAPSHOT_TTL_SECONDS = 30 * 24 * 60 * 60

/** The KV key a stored config of `version` is backed up under before a newer one replaces it. */
export function backupKeyFor(version: number): string {
  return `${KEY}:backup:v${version}`
}

function versionOf(text: string | null): number {
  if (!text) return 0
  try {
    return Number(JSON.parse(text)?.version) || 0
  } catch {
    return 0
  }
}

const json = (data: string, status = 200): Response =>
  new Response(data, {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const stored = await ctx.env.STATS_CONFIG.get(KEY)
  // `null` (literal) tells the client to fall back to its built-in defaults.
  return json(stored ?? 'null')
}

export const onRequestPut: PagesFunction<Env> = async (ctx) => {
  const text = await ctx.request.text()
  let incomingVersion = 0
  try {
    const parsed = JSON.parse(text)
    // Accept v2 (pages array) or legacy v1 (widgets array).
    const ok = parsed && typeof parsed === 'object' && (Array.isArray(parsed.pages) || Array.isArray(parsed.widgets))
    if (!ok) {
      return json('{"error":"config must have a pages (or widgets) array"}', 400)
    }
    incomingVersion = Number(parsed.version) || 0
  } catch {
    return json('{"error":"invalid JSON"}', 400)
  }
  // A version above anything this code writes can't be a real layout (a crafted or corrupted
  // body): refuse it, or the 409 below would lock every real tab out afterwards.
  if (incomingVersion > CONFIG_VERSION) {
    return json(JSON.stringify({ error: `layout version ${incomingVersion} is newer than this site supports (${CONFIG_VERSION})` }), 400)
  }
  const kv = ctx.env.STATS_CONFIG
  const stored = await kv.get(KEY)
  const storedVersion = versionOf(stored)
  // A tab still running OLDER code (a lower layout version) must never overwrite a newer layout:
  // it would silently undo a migration. It gets 409, which the client shows as "This tab is out
  // of date, reload".
  if (stored && incomingVersion < storedVersion) {
    return json(JSON.stringify({ error: 'stale', message: 'This tab is out of date, reload to get the latest layout.', storedVersion, incomingVersion }), 409)
  }
  if (stored && incomingVersion > storedVersion) {
    // FAIL-CLOSED on purpose: the backup is written BEFORE the new layout, and nothing here
    // catches a failure of either write — if the backup read or put throws, the request fails
    // and the stored layout stays exactly as it was (the tab shows "Save failed" and retries on
    // its next change). A layout upgrade is never saved without its backup in place.
    const backupKey = backupKeyFor(storedVersion)
    if ((await kv.get(backupKey)) === null) await kv.put(backupKey, stored)
  }
  if (stored !== null) {
    // Byte-identical to what is stored: nothing would change, so neither the backup nor the
    // layout is written (a copy would only rotate a useful `:prev` out for a duplicate).
    if (stored === text) return json('{"ok":true}')
    try {
      await kv.put(PREV_KEY, stored)
      const dayKey = dayKeyFor(etDateFast(Date.now()))
      if ((await kv.get(dayKey)) === null) await kv.put(dayKey, stored, { expirationTtl: DAY_SNAPSHOT_TTL_SECONDS })
    } catch {
      // No backup, no overwrite: the stored layout stays exactly as it was. The client shows
      // "Save failed" (any non-2xx other than 409) and sends the layout again on its next change.
      return json('{"error":"backup-failed","message":"The layout backup could not be written, so the layout was not saved."}', 503)
    }
  }
  await kv.put(KEY, text)
  return json('{"ok":true}')
}
