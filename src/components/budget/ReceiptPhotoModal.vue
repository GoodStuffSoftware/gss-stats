<script setup lang="ts">
// The receipt photo viewer: the shared ModalPanel (ADR 0005) around one image. It is hosted by BudgetTable and
// ReceiptsReview (never inside a toggletip, which closes on any touch outside it). The path is trusted only when it is a
// same-origin uploads path (photoUrlOf).
import { computed } from 'vue'
import ModalPanel from '../ui/ModalPanel.vue'
import { photoUrlOf } from '../../lib/budget/receiptsClient'

const props = defineProps<{ url: string | null; returnTo?: HTMLElement | null }>()
defineEmits<{ close: [] }>()
const src = computed(() => photoUrlOf(props.url))
</script>

<template>
  <ModalPanel :open="!!src" title="Receipt photo" title-id="rb-photo-title" wide :return-to="returnTo ?? null" @close="$emit('close')">
    <img :src="src" alt="Photo of the receipt" class="rb-img" data-testid="receipt-photo-img" />
  </ModalPanel>
</template>

<style scoped>
.rb-img {
  display: block;
  max-width: 100%;
  max-height: 80vh;
  margin: 0 auto;
  object-fit: contain;
}
</style>
