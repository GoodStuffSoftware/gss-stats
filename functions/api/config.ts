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
// migration is recoverable by copying that key back. One KV write per version bump — well
// inside the Free plan's 1,000 writes a day.

interface Env {
  STATS_CONFIG: KVNamespace
}

const KEY = 'dashboard:default'

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
  const kv = ctx.env.STATS_CONFIG
  const stored = await kv.get(KEY)
  const storedVersion = versionOf(stored)
  if (stored && incomingVersion > storedVersion) {
    const backupKey = backupKeyFor(storedVersion)
    if ((await kv.get(backupKey)) === null) await kv.put(backupKey, stored)
  }
  await kv.put(KEY, text)
  return json('{"ok":true}')
}
