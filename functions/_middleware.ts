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

export function hostGuard(request: Request): Response | null {
  const host = new URL(request.url).hostname
  if (ALLOWED_HOSTS.has(host)) return null
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain' },
  })
}

export const onRequest: PagesFunction<AuthEnv> = async (ctx) => {
  return hostGuard(ctx.request) ?? authGate(ctx.request, ctx.env, () => ctx.next())
}
