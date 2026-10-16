// Measurement changes: days when HOW we count changed, so a jump in a count afterwards is partly
// the new counting and not performance. The one place the date is entered by hand.
//
// v1.99.2 (Best Sudoku) starts a sign-in first-touch fallback: a sign-in can now be tied back to
// the device's first ad touch, so tagged new accounts rise from that day for a reason that is not
// the ads working better. HOW TO MARK IT: when v1.99.2 is live on web, set `dateEt` below to that
// ET calendar day (YYYY-MM-DD). While it is null NOTHING shows anywhere: no timeline marker, no
// card caveat, no read-report line (the ads-cloud-daily routine's judge line is inert then too).
//
// The Play release of v1.99.2 is a second entry with its own date, entered the same way once that
// build is live on Play (it reaches the Apps arm, not the web arm). The notes registry has no
// per-arm targeting, so its caveat is the generic one under the tagged new-account cards, listed
// together with the web entry once each is dated.
//
// Where it shows once set: the Overview timeline (lib/releases.ts RELEASES), a caveat under the
// tagged new-account and auth-success cards (lib/notes.ts 'measurement-change-note'), and the ads
// read reports (scripts/ads-reads/report.ts).

export interface MeasurementChange {
  /** The game version that changes the counting. */
  id: string
  /** ET calendar day (YYYY-MM-DD) the new counting starts, or null until it is marked. */
  dateEt: string | null
  note: string
}

export type MarkedChange = MeasurementChange & { dateEt: string }

export const MEASUREMENT_CHANGES: MeasurementChange[] = [
  {
    id: 'v1.99.2',
    dateEt: null,
    note: 'sign-in first-touch fallback starts; the tagged new-account jump is partly measurement',
  },
  {
    id: 'v1.99.2 Play',
    dateEt: null,
    note: 'Play release of v1.99.2: Apps-arm installs get the new app and in-app sign-ins carry the first-touch tag from here',
  },
]

/** The changes that have a date, oldest first (a null-dated one is not yet marked). */
export function markedChanges(): MarkedChange[] {
  return MEASUREMENT_CHANGES.filter((c): c is MarkedChange => c.dateEt !== null).sort((a, b) => (a.dateEt < b.dateEt ? -1 : a.dateEt > b.dateEt ? 1 : 0))
}

/** The note for a change that starts exactly on `etDay`, else null. */
export function measurementNoteOn(etDay: string): string | null {
  const c = markedChanges().find((x) => x.dateEt === etDay)
  return c ? `${c.id}: ${c.note}` : null
}

/** The note for the newest change that started BEFORE `etDay`, else null. */
export function measurementNoteSince(etDay: string): string | null {
  const c = markedChanges().filter((x) => x.dateEt < etDay).pop()
  return c ? `${c.id} (from ${c.dateEt}): ${c.note}` : null
}

/** The report lines for a read on `etDay`: a marker on the change's day, a "since" line on later
 * reads, nothing before it or while no date is set. Every change is listed, oldest first. */
export function measurementReportLines(etDay: string): string[] {
  const out: string[] = []
  for (const c of markedChanges()) {
    if (c.dateEt === etDay) out.push(`MEASUREMENT CHANGE TODAY, ${c.id}: ${c.note}`)
    else if (c.dateEt < etDay) out.push(`Measurement change since ${c.dateEt}, ${c.id}: ${c.note}`)
  }
  return out
}
