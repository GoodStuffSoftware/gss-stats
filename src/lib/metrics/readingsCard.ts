// The render-time mapping of a legacy Ads readings widget onto the metric-card engine (ADR 0005,
// decision 2). A saved widget with `dataset: 'ads-readings'` and no `card` is NOT rewritten on load:
// its stored fields (dataset, view, campaignIds, limit, type) stay as they are, so a rollback to a
// build that still has the bespoke widget loses nothing. ChartCard asks this module what card to
// draw for it, every time it renders: the `ads-readings-log` preset, with the widget's own `limit`
// as the readings table's row limit. Any `view` (the old 'log', or one a later build wrote) draws
// the log: it was the only view.
import type { CardRef, CardSpec } from './types'
import type { Widget } from '../../types'
import { ADS_READINGS_LOG, presetById } from './presets'
import { DEFAULT_READINGS_LIMIT, MAX_READINGS_LIMIT } from './types'

export const ADS_READINGS_LOG_PRESET = 'ads-readings-log'

/** The row limit a legacy widget asks for: its `limit` as a whole number from 1 to
 * MAX_READINGS_LIMIT; DEFAULT_READINGS_LIMIT when it has none that is usable. */
export function legacyReadingsLimit(widget: Pick<Widget, 'limit'>): number {
  const n = Number(widget.limit)
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_READINGS_LIMIT) : DEFAULT_READINGS_LIMIT
}

/** The card a widget draws: its own `card`, or for an ads-readings widget without one the preset
 * (a clone, with the widget's limit set on the readings table); null for every other widget.
 * Never writes to the widget or to the preset. */
export function cardRefFor(widget: Widget): CardRef | null {
  if (widget.card) return widget.card
  if (widget.dataset !== 'ads-readings') return null
  const limit = legacyReadingsLimit(widget)
  if (limit === DEFAULT_READINGS_LIMIT) return { preset: ADS_READINGS_LOG_PRESET }
  const spec: CardSpec = structuredClone(ADS_READINGS_LOG)
  for (const s of spec.sections) if (s.repeat?.over === 'readings') s.repeat = { ...s.repeat, limit }
  return { spec, from: ADS_READINGS_LOG_PRESET }
}

/** Whether the card shows its own "Updated … ↻" (CardSpec.showUpdated): the header's ↻ is hidden then. */
export function cardShowsOwnReload(ref: CardRef | null): boolean {
  if (!ref) return false
  const spec = 'preset' in ref ? presetById(ref.preset) : ref.spec
  return !!spec?.showUpdated
}
