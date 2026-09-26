import { ref } from 'vue'

// Sign-in is enforced server-side by functions/_middleware.ts (Google sign-in; see
// README "Auth"). When the session lapses while the SPA is open, every /api/* call
// starts failing. Rather than show that on every chart, we detect it once and prompt
// a re-sign-in. Two shapes are recognised:
//   - 401 JSON from our own auth gate (the normal case), and
//   - an opaque cross-origin redirect, which is what an expired Cloudflare Access
//     session looked like (kept while Access is still in front during the rollout).
export const sessionExpired = ref(false)

// The signed-in account, from GET /auth/me (null until known, or under `npm run dev`
// where no Functions run).
export const signedInEmail = ref<string | null>(null)

// True only for genuine network-level failures (TypeError), not HTTP errors like
// "stats 500: …", which come back as readable responses.
export function isNetworkError(e: any): boolean {
  return e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(e?.message ?? '')
}

// True for an HTTP 401 surfaced by the API helpers as "<name> 401: …".
export function isAuthError(e: any): boolean {
  return /^\w+ 401:/.test(e?.message ?? '')
}

let probing = false
// Confirm with a manual-redirect probe so a transient blip doesn't false-trigger the
// banner: 401 = our gate says signed out; an opaque redirect (status 0) = Access.
export async function checkSessionExpired(): Promise<void> {
  if (sessionExpired.value || probing) return
  probing = true
  try {
    const res = await fetch('/api/config', { redirect: 'manual', cache: 'no-store' })
    if (res.status === 401 || res.type === 'opaqueredirect' || res.status === 0) sessionExpired.value = true
  } catch {
    // probe itself failed — can't be sure it's auth; leave the banner off
  } finally {
    probing = false
  }
}

export function reauth(): void {
  // A full document load hits the auth gate, which redirects to Google sign-in and
  // then back here with a fresh session cookie.
  location.reload()
}

export async function loadIdentity(): Promise<void> {
  try {
    const res = await fetch('/auth/me', { cache: 'no-store' })
    if (res.status === 401) {
      sessionExpired.value = true
      return
    }
    if (!res.ok) return
    const data = (await res.json()) as { email?: unknown }
    signedInEmail.value = typeof data?.email === 'string' ? data.email : null
  } catch {
    // no Functions (vite-only dev) or offline — just don't show the account
  }
}
