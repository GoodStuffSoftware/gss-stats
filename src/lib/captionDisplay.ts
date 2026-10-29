// How the notes under a widget show (Widget.captionDisplay). One generic option for every widget
// but a note: the widget's own caption, a card's captions and the measurement-change / release
// notes all sit in the same region, so the setting folds that whole region.
//   always      every line in full (today's display); the stored value for it is "absent"
//   collapsible folded to about two lines with a Show more / Show less button, whenever the text
//               runs past two lines
//   auto        the same, but only once the text is over CAPTION_AUTO_CHARS characters
// A widget saved before this option has no value, which is 'always': nothing changes until someone
// turns it on. A new chart starts on 'auto' (App.vue addChart).
import type { CaptionDisplay, Widget } from '../types'

export const CAPTION_DISPLAYS: readonly CaptionDisplay[] = ['always', 'collapsible', 'auto']
/** 'auto' folds the notes once their text is longer than this many characters. */
export const CAPTION_AUTO_CHARS = 250
/** The display a new chart starts with. */
export const NEW_WIDGET_CAPTION_DISPLAY: CaptionDisplay = 'auto'

/** The mode a widget uses: its own value, or 'always' when it has none (or an unknown one). */
export function captionDisplayOf(widget: Pick<Widget, 'captionDisplay'>): CaptionDisplay {
  return widget.captionDisplay === 'collapsible' || widget.captionDisplay === 'auto' ? widget.captionDisplay : 'always'
}

/** Whether `chars` of text fold under `mode`; the region still shows no toggle unless it also runs
 * past two lines (CaptionCollapse.vue measures that). */
export function captionFolds(mode: CaptionDisplay | undefined, chars: number): boolean {
  if (mode === 'collapsible') return true
  if (mode === 'auto') return chars > CAPTION_AUTO_CHARS
  return false
}

/** The value normWidget keeps: only the two folding modes are stored ('always' is absent). */
export function normCaptionDisplay(v: unknown): CaptionDisplay | undefined {
  return v === 'collapsible' || v === 'auto' ? v : undefined
}
