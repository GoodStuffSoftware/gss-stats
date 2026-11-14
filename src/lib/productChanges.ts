// Product changes: things we changed in the product or its store listing that are neither a release
// (lib/releases.ts: a version of the game) nor a change in how we count (lib/measurementChanges.ts), but
// that a numbers-watcher wants a line for ("did the numbers move after we stopped the first-50 days?").
// Budget and ad-flight changes are not listed here (flights are the campaign bands).
//
// The one place each instant is entered by hand. `atUtc` is the instant it happened; the chart marker
// sits on its Eastern calendar day (the charts' day axis), derived here and never typed twice.
// Shown on a date-axis line chart by the chart editor's "Show product changes" option
// (Widget.changeMarkers), listed under the chart with the note, and offered as a "before and after"
// target (lib/beforeAfter.ts).
import { etDateFast } from './etTime'

export interface ProductChange {
  /** Stable id (the `compareAt` value saved in a layout): lowercase words joined by dashes. */
  id: string
  /** The instant it happened, ISO UTC (YYYY-MM-DDTHH:MM:SSZ). */
  atUtc: string
  /** Short plain on-chart label. */
  label: string
  /** One plain sentence for the hover and the list under the chart. */
  note: string
}

export const PRODUCT_CHANGES: ProductChange[] = [
  {
    id: 'first-50-ended',
    atUtc: '2026-11-09T16:42:45Z',
    label: 'First-50 days end',
    note: 'The first-50 free days stopped (11-09 16:42Z).',
  },
  {
    id: 'play-listing-fixed',
    atUtc: '2026-11-09T19:49:09Z',
    label: 'Play listing fix',
    note: 'The Google Play listing text was corrected (11-09 19:49Z).',
  },
]

export type DatedProductChange = ProductChange & { dateEt: string }

/** Every product change with its Eastern day, oldest first. */
export function datedProductChanges(): DatedProductChange[] {
  return PRODUCT_CHANGES.map((c) => ({ ...c, dateEt: etDateFast(Date.parse(c.atUtc)) })).sort((a, b) => Date.parse(a.atUtc) - Date.parse(b.atUtc))
}
