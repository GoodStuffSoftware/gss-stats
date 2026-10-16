// The Features page's step chart: one line per step of one feature, one point per ET day of the
// selected range. Pure (a model in, a Chart.js config out) so it is unit-tested without a canvas.
// Counts only: each point is a per-ET-day row count, nothing finer.

import type { ChartConfiguration } from 'chart.js'
import type { FeatureHealth, FeatureHealthModel } from './featureHealth'
import { PALETTE, formatKey, gridColor, tickColor } from './charts'
import { isMobileViewport } from './responsive'

/** A line per step over the model's days. */
export function buildStepChartConfig(model: FeatureHealthModel, feature: FeatureHealth): ChartConfiguration {
  const narrow = isMobileViewport()
  return {
    type: 'line',
    data: {
      labels: model.days.map((d) => formatKey('date', d)),
      datasets: feature.steps.map((s, i) => {
        const color = PALETTE[i % PALETTE.length]
        return {
          label: s.label,
          data: s.perDay,
          borderColor: color,
          backgroundColor: color,
          borderWidth: 2,
          tension: 0.2,
          pointRadius: 0,
          pointHitRadius: 16,
          fill: false,
        }
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'bottom', labels: { color: tickColor(), font: { family: 'Inter', size: narrow ? 10 : 11 }, boxWidth: narrow ? 8 : 10, boxHeight: narrow ? 8 : 10, padding: narrow ? 6 : 10 } },
      },
      scales: {
        x: { grid: { color: gridColor() }, ticks: { color: tickColor(), font: { family: 'Inter', size: 11 }, maxRotation: 0, autoSkip: true } },
        y: { beginAtZero: true, grid: { color: gridColor() }, ticks: { color: tickColor(), font: { family: 'Inter', size: 11 }, precision: 0 } },
      },
    },
  } as ChartConfiguration
}
