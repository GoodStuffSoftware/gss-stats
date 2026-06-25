/// <reference types="@cloudflare/workers-types" />
//
// Durable dashboard config storage backed by Cloudflare KV (binding STATS_CONFIG).
// Survives across browsers/devices — more durable than localStorage. Access is
// gated by Cloudflare Access (only the owner reaches this Function), so a single
// shared key is fine.

interface Env {
  STATS_CONFIG: KVNamespace
}

const KEY = 'dashboard:default'

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
  try {
    const parsed = JSON.parse(text)
    // Accept v2 (pages array) or legacy v1 (widgets array).
    const ok = parsed && typeof parsed === 'object' && (Array.isArray(parsed.pages) || Array.isArray(parsed.widgets))
    if (!ok) {
      return json('{"error":"config must have a pages (or widgets) array"}', 400)
    }
  } catch {
    return json('{"error":"invalid JSON"}', 400)
  }
  await ctx.env.STATS_CONFIG.put(KEY, text)
  return json('{"ok":true}')
}
