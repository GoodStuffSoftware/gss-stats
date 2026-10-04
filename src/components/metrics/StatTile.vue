<script setup lang="ts">
// One stat tile: a label, a big number, a small line under it. Two homes (ADR 0005 slice 5):
//   'page'  - the Stat chart type's body in ChartCard: the number first, the label as a small caps
//             line under it, centred in the card.
//   'frame' - a metric card's tile frame (MetricItem): a bordered tile, label on top, with the
//             card's extras (deltas, sparkline, bar, caption) in the default slot.
// Both draw the same elements, so the figures are styled in one place. `label` may be replaced
// by the label slot (a card's label carries tokens and a tooltip).
withDefaults(defineProps<{ number: string; label?: string; sub?: string; variant?: 'page' | 'frame'; muted?: boolean; tone?: string; labelTitle?: string }>(), { variant: 'page' })
</script>

<template>
  <div class="stat-tile" :class="[variant === 'frame' ? ['mi-tile', 'is-frame'] : 'is-page', tone ? `tone-${tone}` : '']">
    <template v-if="variant === 'frame'">
      <div class="stat-tile-label mi-tile-label" :title="labelTitle"><slot name="label">{{ label }}</slot></div>
      <div class="stat-tile-num mi-tile-num" :class="{ muted }">{{ number }}</div>
      <div v-if="sub" class="stat-tile-sub mi-tile-sub mono">{{ sub }}</div>
      <slot />
    </template>
    <template v-else>
      <div class="stat-tile-num">{{ number }}</div>
      <div class="stat-tile-label overline"><slot name="label">{{ label }}</slot></div>
      <div v-if="sub" class="stat-tile-sub">{{ sub }}</div>
    </template>
  </div>
</template>

<style scoped>
.mono {
  font-family: 'JetBrains Mono', monospace;
}
.stat-tile-num {
  font-family: 'Space Grotesk', sans-serif;
  font-weight: 700;
  color: rgb(var(--ink));
}
/* page */
.is-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.is-page .stat-tile-num {
  font-size: clamp(28px, 7vw, 46px);
  line-height: 1;
  letter-spacing: -0.03em;
}
.is-page .stat-tile-label {
  margin-top: 6px;
}
.is-page .stat-tile-sub {
  margin-top: 4px;
  font-size: 12px;
  color: rgb(var(--ink-2));
}
/* frame */
.is-frame {
  border: 1px solid rgb(var(--line));
  border-radius: 12px;
  padding: 10px 12px;
  background: rgb(var(--surface));
  min-width: 0;
}
.is-frame.tone-live {
  border-color: rgb(var(--amber-hover));
}
.is-frame.tone-warn {
  border-color: #bc4749;
}
.is-frame .stat-tile-label {
  font-size: 11px;
  color: rgb(var(--ink-3));
  margin-bottom: 4px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.is-frame .stat-tile-num {
  font-size: 22px;
}
.is-frame .stat-tile-num.muted {
  font-size: 12px;
  font-weight: 500;
  color: rgb(var(--ink-3));
  font-family: Inter, sans-serif;
}
.is-frame .stat-tile-sub {
  font-size: 10.5px;
  color: rgb(var(--ink-3));
  margin-top: 1px;
}
</style>
