// The render-time mapping of a legacy pop-up rate tile (`type: 'rate'`, `dataset: 'popup'`,
// `dimension` = a lib/popupEvents.ts POPUP_RATE_SPECS key) onto the metric-card engine (ADR 0005,
// slice 4, decision 2). Like the readings-log mapping next to it, a saved widget is NOT rewritten
// on load: its stored fields stay as they are, so a rollback to a build that still has the bespoke
// tile loses nothing. ChartCard asks `cardRefFor` (readingsCard.ts) which asks this module, every
// time it renders: a one-item 'tiles' card — the rate as a percentage, big, with its (n/d) under
// it, "too few to report" under MIN_COHORT — for the ratio the key names.
import type { CardRef, CardSpec } from './types'
import type { Widget } from '../../types'
import { POPUP_RATE_SPECS, type PopupRateSpec } from '../popupEvents'

/** The id the retired tile's install-fix note was hidden by (`hiddenCaveats`, chartNotes.ts: the
 * runtime note `popup-note`) and the registry note that text is now, in the tile's caption. A stored
 * hide of the first hides the second on this tile, so a user who hid the note keeps it hidden. */
export const RATE_TILE_NOTE_HIDE_ID = 'popup-note'
const INSTALL_FIX_NOTE_ID = 'install-fix-note'

/** The ratio (registry id) each kind of rate reads: a tap is accepts over shown; an outcome is
 * that outcome's cohort over shown; eligibility is earned over all signed-out finishes. */
const OUTCOME_RATIO: Record<string, string> = {
  'signed-in': 'popup.signedInRate',
  installed: 'popup.installedRate',
  returned: 'popup.returnedRate',
  'still-playing': 'popup.stillPlayingRate',
}

/** The registered rate a POPUP_RATE_SPECS entry reads, or null when the spec has no ratio. */
function ratioFor(spec: PopupRateSpec): { ratio: string; popup?: string } | null {
  if (spec.kind === 'eligibility') return { ratio: 'popup.eligibility' }
  if (!spec.popup) return null
  if (spec.kind === 'tap') return { ratio: 'popup.tapRate', popup: spec.popup }
  const ratio = spec.outcome ? OUTCOME_RATIO[spec.outcome] : undefined
  return ratio ? { ratio, popup: spec.popup } : null
}

/** The POPUP_RATE_SPECS entry a legacy rate tile names, or undefined for a key this build does
 * not know (a tile saved by a newer build, or edited by hand). */
export function rateSpecFor(widget: Pick<Widget, 'dimension'>): PopupRateSpec | undefined {
  return POPUP_RATE_SPECS.find((s) => s.key === widget.dimension)
}

/** Whether this tile's card can show the install-fix note (the engine adds it for the installed
 * outcome of the install pop-up only), so the editor offers a Show/Hide row only there. */
export function rateTileHasHideableNote(widget: Pick<Widget, 'dimension'>): boolean {
  const spec = rateSpecFor(widget)
  return spec?.popup === 'install' && spec.outcome === 'installed'
}

/** Whether the widget is a legacy rate tile (any key, known or not). */
export function isLegacyRateTile(widget: Pick<Widget, 'type' | 'dataset' | 'card'>): boolean {
  return widget.type === 'rate' && widget.dataset === 'popup' && !widget.card
}

/** The one-item card a legacy rate tile draws; null when its key is not one this build knows
 * (ChartCard then says so instead of drawing a "—"). Never writes to the widget. */
export function rateTileCardRef(widget: Pick<Widget, 'type' | 'dataset' | 'card' | 'dimension' | 'hiddenCaveats'>): CardRef | null {
  if (!isLegacyRateTile(widget)) return null
  const spec = rateSpecFor(widget)
  const r = spec && ratioFor(spec)
  if (!spec || !r) return null
  const card: CardSpec = {
    v: 1,
    sections: [
      {
        layout: 'tiles',
        items: [
          {
            id: 'rate',
            label: spec.label,
            data: { ratio: r.ratio, ...(r.popup ? { params: { popup: r.popup } } : {}), window: 'page' },
            display: { as: 'percent', decimals: 1 },
            frame: 'tile',
            ...(widget.hiddenCaveats?.includes(RATE_TILE_NOTE_HIDE_ID) ? { hideNotes: [INSTALL_FIX_NOTE_ID] } : {}),
          },
        ],
      },
    ],
  }
  return { spec: card }
}
