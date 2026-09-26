<script setup lang="ts">
// "Refresh data" for the ads widgets: POST /api/ads/refresh (src/lib/adsRefresh.ts). The server
// syncs only when a campaign's data is stale, at most once per 10 minutes, through the
// gss-stats-sync Worker; this button just asks and reports. Emits `refreshed` when a sync ran,
// so the parent reloads its data and the freshness line updates.
import { ref } from 'vue'
import { refreshAdsData } from '../api'
import type { RefreshResult } from '../lib/adsRefresh'

const props = defineProps<{ campaignIds: readonly string[] }>()
const emit = defineEmits<{ refreshed: [RefreshResult] }>()

const busy = ref(false)
const message = ref<string | null>(null)

function describe(r: RefreshResult): string {
  if (r.reason === 'synced') return 'Synced'
  if (r.reason === 'up to date') return 'Already up to date'
  if (r.reason === 'rate-limited') return `Synced recently; try again in ${Math.max(1, Math.ceil((r.retryAfterSec ?? 60) / 60))} min`
  if (r.reason === 'not available') return 'Refresh is not available here'
  return 'Sync failed; the next scheduled sync retries'
}

async function refresh() {
  busy.value = true
  message.value = null
  try {
    const r = await refreshAdsData(props.campaignIds)
    message.value = describe(r)
    emit('refreshed', r)
  } catch (e: any) {
    message.value = e?.message ?? 'Refresh failed'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <span class="ads-refresh">
    <button type="button" class="btn" :disabled="busy" @click="refresh">{{ busy ? 'Refreshing…' : 'Refresh data' }}</button>
    <span v-if="message" class="msg mono">{{ message }}</span>
  </span>
</template>

<style scoped>
.ads-refresh {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.btn {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 8px;
  border: 1px solid rgb(var(--line));
  background: rgb(var(--surface));
  color: rgb(var(--ink-2));
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.msg {
  font-size: 11px;
  color: rgb(var(--ink-3));
}
</style>
