<script setup lang="ts">
// PLACEHOLDER — dataset 'ads-readings' widget body. Owned by the feat/ads-read-routines
// worker (their "Readings log" panel), who will replace this file. Kept here only so this
// branch builds/typechecks on its own; props contract per the agreed interface: { widget }.
// view is their choice (e.g. 'log'); widget.campaignIds narrows which campaign(s), same
// convention as the 'campaigns' dataset (see lib/campaignsData.ts).
import type { Widget } from '../../types'
defineProps<{ widget: Widget }>()
</script>

<template>
  <div class="stub mono">Ads readings log — pending (feat/ads-read-routines)</div>
</template>

<style scoped>
.stub {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: rgb(var(--ink-3));
  text-align: center;
  padding: 0 8px;
}
</style>
