import { ref, onMounted, onBeforeUnmount } from 'vue'
import { BUILD_ID_URL, BUILD_CHECK_INTERVAL_MS, isNewerBuild, parseBuildId } from '../lib/buildCheck'

/** Fetches the live build id. Only this static file is requested: no cookie-bearing API, no D1,
 *  nothing sent about the visitor. Any failure (offline, signed out, bad body) is "unknown". */
export async function fetchLiveBuildId(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(BUILD_ID_URL, { cache: 'no-store', redirect: 'manual', credentials: 'same-origin' })
    if (!res.ok) return null
    return parseBuildId(await res.json())
  } catch {
    return null
  }
}

/** Watches for a newer deploy: every 5 minutes while the tab is visible, and once when a hidden
 *  tab becomes visible. Never reloads; it only sets `updateAvailable`. Off unless `enabled`. */
export function useBuildCheck(currentId: string, enabled: boolean, fetchImpl: typeof fetch = fetch) {
  const updateAvailable = ref(false)
  let timer: ReturnType<typeof setInterval> | undefined
  let checking = false

  async function check() {
    if (updateAvailable.value || checking) return
    checking = true
    try {
      if (isNewerBuild(currentId, await fetchLiveBuildId(fetchImpl))) updateAvailable.value = true
    } finally {
      checking = false
    }
  }
  function onVisibility() {
    if (document.visibilityState === 'visible') void check()
  }
  function onTick() {
    if (document.visibilityState === 'visible') void check()
  }

  onMounted(() => {
    if (!enabled) return
    timer = setInterval(onTick, BUILD_CHECK_INTERVAL_MS)
    document.addEventListener('visibilitychange', onVisibility)
  })
  onBeforeUnmount(() => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisibility)
  })
  return { updateAvailable, check }
}
