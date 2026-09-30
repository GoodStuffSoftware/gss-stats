/// <reference types="@cloudflare/workers-types" />
//
// Runs on EVERY request to the project (static assets, /api/* Functions and /auth/*
// alike), in two steps:
//
// 1. Host guard. Only the canonical custom domain (and loopback for local dev) is
//    served; anything else, including the project's *.pages.dev and preview-branch
//    URLs, gets a 404. That keeps a single origin for the session cookie and the OAuth
//    redirect URI, and it was the backstop that stopped the *.pages.dev URL bypassing
//    Cloudflare Access (a self-hosted Access app doesn't cover it).
//    The one exception is the hosted preview: a deployment whose env sets PREVIEW_HOST
//    (only wrangler.toml's [env.preview] does) also serves that exact hostname,
//    dev.gss-stats.pages.dev. Production never sets it. See the 2026-09-30 amendment
//    in docs/adr/0002-google-auth.md.
//
// 2. Google sign-in gate (functions/_lib/auth.ts). Every page and every /api/* route
//    needs a signed-in Google account on ALLOWED_EMAILS. Fails closed when unconfigured.
//    See docs/adr/0002-google-auth.md and README "Auth".

import { authGate, type AuthEnv } from './_lib/auth'

// The loopback entries must match isLoopbackHost in functions/_lib/auth.ts.
export const ALLOWED_HOSTS = new Set([
  'stats.goodstuff.software', // canonical
  'localhost',
  '127.0.0.1',
])

export interface HostGuardEnv {
  /** Preview deployments only: the single extra hostname they serve, compared exactly. */
  PREVIEW_HOST?: string
}

export type MiddlewareEnv = AuthEnv & HostGuardEnv

/** True iff the deployment names a preview host and this is exactly it. Unset or empty
 *  (production, local dev) never matches, and there is no suffix or wildcard matching. */
export function isPreviewHost(host: string, env: HostGuardEnv): boolean {
  const preview = env.PREVIEW_HOST
  return typeof preview === 'string' && preview !== '' && host === preview
}

export function hostGuard(request: Request, env: MiddlewareEnv = {}): Response | null {
  const host = new URL(request.url).hostname
  if (ALLOWED_HOSTS.has(host) || isPreviewHost(host, env)) return null
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain' },
  })
}

export const onRequest: PagesFunction<MiddlewareEnv> = async (ctx) => {
  return hostGuard(ctx.request, ctx.env) ?? authGate(ctx.request, ctx.env, () => ctx.next())
}
