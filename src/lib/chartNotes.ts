// The notes under a chart, in one place and one fixed order (notes plan, slice 1b). ChartCard's
// `.card-captions` area renders this list with a single v-for, so the order below, and which
// source shows when, is tested here and not in the template. A card's own spec captions are a
// different thing: MetricCard keeps them inside the card body (`.mc-captions`).
import type { StatsResponse, Widget } from '../types'
import { getNote, widgetCaptionNoteIds, type NoteSeverity } from './notes'
import { rangeNoticeText } from './rangeNotice'
import { REFUSED_WHOLE_DAYS_CAPTION, SPLIT_GUARD_CAPTION } from './splitGuard'

export interface ChartNote {
  /** Stable key: a registry id for a legacy caption, else the runtime note's own key. */
  key: string
  /** 'caption': text the chart's author attached. 'caveat': a system note about the data. */
  kind: 'caption' | 'caveat'
  /** Set only where the note picks its own tone; a registry note takes the registry's. */
  severity?: NoteSeverity
  /** Exactly one of these two is set: a registry note id, or ready text. */
  noteId?: string
  text?: string
  /** false = the viewer cannot hide it (a data-cut note: it says what the numbers leave out).
   * Only `false` means anything; 1c adds the hiding, nothing reads this yet. */
  hideable: boolean
}

// 1c's plain-text caption (`widget.caption`) goes first. Nothing writes the field yet.
function captionNotes(_widget: Widget): ChartNote[] {
  return []
}

export function chartNotes(widget: Widget, data: StatsResponse | null | undefined, error: string | null | undefined): ChartNote[] {
  const notes: ChartNote[] = captionNotes(widget)

  // Legacy caption ids: the whole list when set (a note-type widget has none). Hideable follows
  // the registry entry; an unknown id stays in the list and renders as nothing (NoteBlock).
  for (const id of widgetCaptionNoteIds(widget)) {
    notes.push({ key: id, kind: 'caption', noteId: id, hideable: getNote(id)?.hideable !== false })
  }

  // Runtime notes: they travel with the response. Only the range notice is dropped on an error
  // (the error state keeps its own message).
  if (data?.note) notes.push({ key: 'popup-note', kind: 'caveat', text: data.note, hideable: true })
  if (data?.meta?.splitGuard) notes.push({ key: 'split-guard', kind: 'caveat', text: SPLIT_GUARD_CAPTION, hideable: false })
  if (data?.meta?.refusedWholeDays) notes.push({ key: 'refused-whole-days', kind: 'caveat', text: REFUSED_WHOLE_DAYS_CAPTION, hideable: false })
  if (!error && data?.notice) {
    const text = rangeNoticeText(data.notice)
    if (text) notes.push({ key: 'range-notice', kind: 'caveat', severity: 'caveat', text, hideable: false })
  }
  return notes
}
