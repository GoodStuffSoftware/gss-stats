import { ref } from 'vue'

// When the Cloudflare Access session lapses, the SPA is still loaded but every
// /api/* call is 302-redirected to the cross-origin Access login, which the
// browser surfaces to fetch() as a "Failed to fetch" TypeError. Rather than show
// that on every chart, we detect it once and prompt a re-sign-in.
export const sessionExpired = ref(false)

// True only for genuine network-level failures (TypeError), not HTTP errors like
// "stats 500: …", which come back as readable responses.
export function isNetworkError(e: any): boolean {
  return e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(e?.message ?? '')
}

let probing = false
// Confirm an Access redirect with a manual-redirect probe so a transient blip
// doesn't false-trigger the banner. An expired session returns an opaque redirect
// (type "opaqueredirect", status 0); a live session returns 200.
export async function checkSessionExpired(): Promise<void> {
  if (sessionExpired.value || probing) return
  probing = true
  try {
    const res = await fetch('/api/config', { redirect: 'manual', cache: 'no-store' })
    if (res.type === 'opaqueredirect' || res.status === 0) sessionExpired.value = true
  } catch {
    // probe itself failed — can't be sure it's auth; leave the banner off
  } finally {
    probing = false
  }
}

export function reauth(): void {
  // A full document load hits Access → login → restores the session cookie.
  location.reload()
}
