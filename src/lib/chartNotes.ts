// The notes under a chart, in one place and one fixed order (notes plan, slices 1b and 1c).
// ChartCard's `.card-captions` area renders this list with a single v-for, so the order below, and
// which source shows when, is tested here and not in the template. A card's own spec captions are
// a different thing: MetricCard keeps them inside the card body (`.mc-captions`), and hides them
// through the same `widget.hiddenCaveats` list (isNoteIdHideable below).
import type { StatsResponse, Widget } from '../types'
import { getNote, isStaticCaptionNote, noteTemplate, widgetCaptionNoteIds, type NoteSeverity } from './notes'
import { CAPTION_MAX_CHARS } from './defaults'
import { rangeNoticeText } from './rangeNotice'
import { REFUSED_WHOLE_DAYS_CAPTION, SPLIT_GUARD_CAPTION } from './splitGuard'

export interface ChartNote {
  /** Stable, unique render key: 'caption' (the widget's own text), `caption:<registry id>` for a
   * legacy caption id, else the runtime note's own key ('popup-note', 'split-guard', …). */
  key: string
  /** 'caption': text the chart's author attached. 'caveat': a system note about the data. */
  kind: 'caption' | 'caveat'
  /** Set only where the note picks its own tone; a registry note takes the registry's. */
  severity?: NoteSeverity
  /** Exactly one of these two is set: a registry note id, or ready text. */
  noteId?: string
  text?: string
  /** false = it cannot be hidden: a data-cut note (it says what the numbers leave out), the
   * widget's own caption (edited, not hidden) or an unknown legacy id. */
  hideable: boolean
  /** The id `widget.hiddenCaveats` uses for this note: the registry id, or the runtime note's key.
   * Set only when `hideable` is true. */
  hideId?: string
  /** A legacy caption id the registry does not know. It renders nothing (as before 1c) and the
   * editor offers to remove it (N1). */
  unknown?: true
}

/** True when `id` names a registry note that a chart or card may hide: known, and not marked
 * `hideable: false`. An unknown id is never hideable. MetricCard uses this for spec captions. */
export function isNoteIdHideable(id: string): boolean {
  const def = getNote(id)
  return !!def && def.hideable !== false
}

// The widget's own plain-text caption (Widget.caption) goes first.
function captionNotes(widget: Widget): ChartNote[] {
  return widget.caption ? [{ key: 'caption', kind: 'caption', text: widget.caption, hideable: false }] : []
}

function runtimeNote(key: string, text: string, hideable: boolean, severity?: NoteSeverity): ChartNote {
  return { key, kind: 'caveat', text, hideable, ...(severity ? { severity } : {}), ...(hideable ? { hideId: key } : {}) }
}

/** Every note the chart could show, hidden ones included (the editor's "Data caveats" list). */
export function allChartNotes(widget: Widget, data: StatsResponse | null | undefined, error: string | null | undefined): ChartNote[] {
  const notes: ChartNote[] = captionNotes(widget)

  // Legacy caption ids: the whole list when set (a note-type widget has none). Hideable follows
  // the registry entry; an unknown id stays in the list, flagged, and renders as nothing.
  for (const id of widgetCaptionNoteIds(widget)) {
    if (!getNote(id)) {
      notes.push({ key: `caption:${id}`, kind: 'caption', noteId: id, hideable: false, unknown: true })
      continue
    }
    const hideable = isNoteIdHideable(id)
    notes.push({ key: `caption:${id}`, kind: 'caption', noteId: id, hideable, ...(hideable ? { hideId: id } : {}) })
  }

  // Runtime notes: they travel with the response. Only the range notice is dropped on an error
  // (the error state keeps its own message).
  if (data?.note) notes.push(runtimeNote('popup-note', data.note, true))
  if (data?.meta?.splitGuard) notes.push(runtimeNote('split-guard', SPLIT_GUARD_CAPTION, false))
  if (data?.meta?.refusedWholeDays) notes.push(runtimeNote('refused-whole-days', REFUSED_WHOLE_DAYS_CAPTION, false))
  if (!error && data?.notice) {
    const text = rangeNoticeText(data.notice)
    if (text) notes.push(runtimeNote('range-notice', text, false, 'caveat'))
  }
  return notes
}

/** Whether `widget.hiddenCaveats` hides this note. A note that is not hideable is never hidden,
 * whatever the list says. */
export function isChartNoteHidden(note: ChartNote, hiddenCaveats: readonly string[] | undefined): boolean {
  return note.hideable && note.hideId !== undefined && !!hiddenCaveats?.includes(note.hideId)
}

/** The notes ChartCard shows: allChartNotes minus the ones this widget hides. */
export function chartNotes(widget: Widget, data: StatsResponse | null | undefined, error: string | null | undefined): ChartNote[] {
  return allChartNotes(widget, data, error).filter((n) => !isChartNoteHidden(n, widget.hiddenCaveats))
}

/** D5 convert-on-edit (slice 1c). ChartEditor applies this to its draft when it opens a chart that
 * still has legacy `notes` ids, so the author sees the result and Cancel leaves the chart as it was:
 *  - a static library caption (isStaticCaptionNote) is appended to `caption` as its text, in list
 *    order, blank-line separated, after any existing caption; its id leaves `notes`. One the chart
 *    hides (`hiddenCaveats`) leaves `notes` without adding text, so the chart looks the same;
 *  - every other id stays in `notes`: an unknown id until the author removes it (N1), and a
 *    caveat (D1: gated, computed or code-tied text, or a data-cut note), which must stay live;
 *  - `notes` is deleted once empty. A note widget never shows `notes`, so it is left alone.
 * Returns a new widget (never mutates) and the converted ids; with none, the same widget. */
export function convertLegacyNotes<W extends Widget>(widget: W): { widget: W; converted: string[] } {
  if (widget.type === 'note' || !widget.notes?.length) return { widget, converted: [] }
  const keep: string[] = []
  const converted: string[] = []
  const texts: string[] = []
  for (const id of widget.notes) {
    if (!isStaticCaptionNote(id)) {
      keep.push(id)
      continue
    }
    converted.push(id)
    if (!widget.hiddenCaveats?.includes(id)) texts.push(noteTemplate(id).trim())
  }
  if (!converted.length) return { widget, converted }
  const next = { ...widget }
  const caption = [widget.caption?.trimEnd() ?? '', ...texts].filter(Boolean).join('\n\n').slice(0, CAPTION_MAX_CHARS)
  if (caption) next.caption = caption
  else delete next.caption
  if (keep.length) next.notes = keep
  else delete next.notes
  return { widget: next, converted }
}
