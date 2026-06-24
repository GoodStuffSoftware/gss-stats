/// <reference types="@cloudflare/workers-types" />
//
// Host guard. Cloudflare Access protects the canonical custom domain
// (stats.goodstuff.software) at the edge, but a self-hosted Access app does NOT
// enforce on the project's *.pages.dev URL — leaving the page + API world-readable
// there. This middleware runs on EVERY request to the project (static assets and
// Functions alike) and 404s anything not on the canonical host (or localhost for
// dev), so the only reachable surface is the Access-gated domain.

const ALLOWED_HOSTS = new Set([
  'stats.goodstuff.software', // canonical, Access-protected
  'localhost',
  '127.0.0.1',
])

export const onRequest: PagesFunction = async (ctx) => {
  const host = new URL(ctx.request.url).hostname
  if (!ALLOWED_HOSTS.has(host)) {
    return new Response('Not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    })
  }
  return ctx.next()
}
