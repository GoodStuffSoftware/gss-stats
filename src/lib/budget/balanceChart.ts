// The balance-over-time line (orange, filled, dollars on the axis) shared by the debt detail and, if it wants
// one, the Loans list. Pure: history in, Chart.js config out.
import type { ChartConfiguration } from 'chart.js'
import { formatAmount, formatDate } from './tableModel'

export function balanceLineConfig(history: Array<{ asOf: string; balanceCents: number }>, dark: boolean): ChartConfiguration {
  const ink = dark ? '#A89F92' : '#8A8278'
  const grid = dark ? 'rgba(255,255,255,0.08)' : '#E7E2D7'
  return {
    type: 'line',
    data: {
      labels: history.map((h) => formatDate(h.asOf)),
      datasets: [
        {
          data: history.map((h) => h.balanceCents / 100),
          borderColor: '#E0722C',
          backgroundColor: 'rgba(224,114,44,0.15)',
          fill: true,
          tension: 0.2,
          pointRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => formatAmount(Math.round(Number(ctx.raw) * 100)) } },
      },
      scales: {
        x: { ticks: { color: ink, maxTicksLimit: 6 }, grid: { display: false } },
        y: { ticks: { color: ink, callback: (v) => formatAmount(Math.round(Number(v) * 100)) }, grid: { color: grid } },
      },
    },
  } as ChartConfiguration
}
