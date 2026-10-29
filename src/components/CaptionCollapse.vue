<script setup lang="ts">
// The region that holds the notes under a widget (ChartCard's `.card-captions`, MetricCard's
// `.mc-captions`), with the widget's `captionDisplay` applied (lib/captionDisplay.ts):
//   always (or none)  the slot as is, no button
//   collapsible       the slot folded to about two lines when it runs past them
//   auto              the same, but only when the text is over CAPTION_AUTO_CHARS characters
// Folded text carries a "Show more" button (aria-expanded, aria-controls the text) that opens it in
// place; "Show less" folds it back. The button appears only when something is actually hidden, which
// is measured (the text's scrollHeight against the folded height), so a caption that fits in two
// lines never shows one. Printing always shows the full text. The open state is not saved.
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, useId } from 'vue'
import { captionFolds } from '../lib/captionDisplay'
import type { CaptionDisplay } from '../types'

const props = defineProps<{ mode?: CaptionDisplay }>()

const bodyEl = ref<HTMLElement | null>(null)
const bodyId = useId()
const chars = ref(0)
const overflows = ref(false)
const expanded = ref(false)

const folds = computed(() => captionFolds(props.mode, chars.value))
const clamped = computed(() => folds.value && !expanded.value)
const showToggle = computed(() => folds.value && overflows.value)

function measure() {
  const el = bodyEl.value
  if (!el) return
  chars.value = (el.textContent ?? '').trim().length
  // Overflow is only readable while the text is folded; an open one keeps what it last measured.
  if (clamped.value) overflows.value = el.scrollHeight > el.clientHeight + 1
}
function toggle() {
  expanded.value = !expanded.value
  if (!expanded.value) void nextTick(measure)
}

let observer: ResizeObserver | null = null
onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && bodyEl.value) {
    observer = new ResizeObserver(() => measure())
    observer.observe(bodyEl.value)
  }
})
onUpdated(measure)
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div class="caption-collapse">
    <div :id="bodyId" ref="bodyEl" class="cc-body" :class="{ 'cc-folding': folds, 'cc-folded': clamped, 'cc-faded': clamped && overflows }" data-testid="caption-body">
      <slot />
    </div>
    <button v-if="showToggle" type="button" class="cc-toggle" :aria-expanded="expanded" :aria-controls="bodyId" data-testid="caption-toggle" @click="toggle">
      {{ expanded ? 'Show less' : 'Show more' }}
    </button>
  </div>
</template>

<style scoped>
/* Two 11.5px lines (the notes' own size) at a fixed line height, folded or open, so opening one
   never reflows the text. */
.cc-folding {
  font-size: 11.5px;
  line-height: 1.4;
}
.cc-folded {
  max-height: calc(2 * 1.4 * 11.5px);
  overflow: hidden;
}
/* The fade only where text is really cut off, so a caption that fits is never dimmed without a button. */
.cc-faded {
  -webkit-mask-image: linear-gradient(to bottom, #000 55%, transparent);
  mask-image: linear-gradient(to bottom, #000 55%, transparent);
}
.cc-toggle {
  margin-top: 2px;
  padding: 2px 0;
  border: 0;
  background: none;
  font: inherit;
  font-size: 11.5px;
  color: rgb(var(--amber-hover));
  text-decoration: underline;
  cursor: pointer;
}
.cc-toggle:focus-visible {
  outline: 2px solid rgb(var(--amber-hover));
  outline-offset: 2px;
}
@media print {
  .cc-folded {
    max-height: none;
    overflow: visible;
  }
  .cc-faded {
    -webkit-mask-image: none;
    mask-image: none;
  }
  .cc-toggle {
    display: none;
  }
}
</style>
