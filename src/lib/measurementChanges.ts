// Measurement changes: days when HOW we count changed, so a jump in a count afterwards is partly
// the new counting and not performance. The one place the date is entered by hand.
//
// v1.99.2 (Best Sudoku) starts a sign-in first-touch fallback: a sign-in can now be tied back to
// the device's first ad touch, so tagged new accounts rise from that day for a reason that is not
// the ads working better. HOW TO MARK IT: when v1.99.2 is live on web, set `dateEt` below to that
// ET calendar day (YYYY-MM-DD). While it is null NOTHING shows anywhere: no timeline marker, no
// card caveat, no read-report line (the ads-cloud-daily routine's judge line is inert then too).
//
// The Play release of v1.99.2 is a second entry with its own date (2026-10-17, committed 22:49 ET 10-16; it reaches
// users once Google's review clears; it reaches the Apps arm, not the web arm). The notes registry has no
// per-arm targeting, so its caveat is the generic one under the tagged new-account cards, listed
// together with the web entry once each is dated.
//
// v1.99.3 web (dated 2026-10-17) and v1.99.3 Play (coachOnly, dated 2026-10-17, promoted 06:09:41Z, listed last so the later-timed entry wins the same-day tie) mark the coach strip meaning
// change (x closes one tip; a written note ends the notes tip). They feed only the timeline and the
// coach readouts (coachMeasurementNote): the Coach tips card, the Feature health Coach row and the
// report's tagged coach line. They stay out of the auth-success caveat and the generic report lines.
//
// v1.102.0 Android (authErrorOnly, date null until the Play production go-live time is known): native Google
// sign-in cancels move from the no-code row to user-cancelled. It feeds only the timeline and the
// sign-in failure cards (lib/notes.ts 'auth-error-measurement-note'); it stays out of the auth-success caveat, the coach
// readouts and the generic report lines.
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
  /** The coach-strip meaning change that rides on this entry: shown on the coach readouts only (Coach tips card, Feature health Coach row, report coach line), never under the auth-success cards. */
  coachNote?: string
  /** True when the whole entry is the coach change: it marks the timeline and feeds the coach readouts, but is kept out of the auth-success caveat and the generic report lines. */
  coachOnly?: boolean
  /** True when the whole entry only moves the sign-in failure rows (/auth/error/<code>): it marks the timeline and feeds the sign-in failure cards' caveat, and is kept out of the auth-success caveat, the coach readouts and the generic report lines. */
  authErrorOnly?: boolean
}

export type MarkedChange = MeasurementChange & { dateEt: string }

export const MEASUREMENT_CHANGES: MeasurementChange[] = [
  {
    id: 'v1.99.2',
    dateEt: '2026-10-16', // web live 2026-10-16T23:38:55Z = 19:38 ET
    note: 'sign-in first-touch fallback starts; the tagged new-account jump is partly measurement',
  },
  {
    id: 'v1.99.2 Play',
    dateEt: '2026-10-17', // committed to Play production 2026-10-17T02:49Z = 22:49 ET 10-16; reaches users when Google's review clears
    note: "Play release of v1.99.2: Apps-arm installs get the new app, with the sign-in ask-order A/B and the auth first-touch fallback, and the Play install referrer carries the campaign into the first sign-in. Committed 22:49 ET 10-16; reaches users when Google's review clears",
  },
  {
    id: 'v1.99.3 web',
    dateEt: '2026-10-17', // web live 2026-10-17T05:58:55Z = 01:58:55 ET (version.json first read 1.99.3); before the first possible flight-3 serve (12:00 ET 10-17)
    note: "web release of v1.99.3, live 2026-10-17 01:58 ET, before the first flight-3 serve (12:00 ET 10-17), so all flight-3 web traffic is on it; pre-flight organic rows since 2026-10-16 21:07Z mix v1.99.1, v1.99.2 and v1.99.3. Coach strip meaning change: from this marker the coach × closes one tip instead of retiring the schedule and writing a pencil note ends the notes tip with NO beacon, so notes-tip completions are not counted after it, later-tip shown counts rise and a dismissed row no longer means the tips stopped; shown/notes with no dismissed or closed-at row after it can also mean a note was written. The release also fixes the game reset/duplicate across devices, shows cross-device notices as pop-ups, never reloads mid-game, and saves right after email verification",
    coachOnly: true,
  },
  {
    id: 'v1.99.3 Play',
    dateEt: '2026-10-17', // promoted to Play production 2026-10-17T06:09:41Z = 02:09:41 ET (full rollout, managed publishing off); reaches users when Google's review clears. Listed after the web entry: the same-day release-panel tie goes to the later-listed one, and this is the later-timed (web 05:58:55Z)
    note: 'Play release of v1.99.3, coach strip meaning change: from v1.99.3 the coach × closes one tip instead of retiring the schedule and writing a pencil note ends the notes tip with no beacon, so later-tip shown counts rise and a dismissed row no longer means the tips stopped; shown/notes with no dismissed or closed-at row after it can also mean a note was written. Committed 02:09 ET. Public on Play 06:34Z 10-17. Android installs after it may be a mix of 19902 and 19903 until updates spread. Android coach rows after this are a mix of old and new semantics until updates spread',
    coachOnly: true,
  },
  {
    id: 'v1.102.0 Android',
    dateEt: null, // TODO: set to the ET day of the Play production go-live of 1.102.0 once that time is known (reaches users when Google's review clears)
    note: 'Android 1.102.0: native Google sign-in cancels move from the no-code row to the user-cancelled row, while other native Google failures stay in no-code; older Android installs keep sending cancels as no-code until they update, so no-code falls and user-cancelled rises while both are sign-in failure rows',
    authErrorOnly: true,
  },
]

/** The Apps-arm Play-install read caveat ends here: v1.99.3 (19903) went public on Google Play between 06:31:47Z and 06:34:32Z on 2026-10-17 (the listing first showed its "What's new" at 06:34:32Z), before flight 3's first serve (12:00 ET 10-17). */
export const APPS_PLAY_CAVEAT_ENDS_AT_MS = Date.parse('2026-10-17T06:34:32Z')

/** Whether the Apps-arm Play-install caveat shows for a reading that starts at `readStartMs`: a reading that starts before the cut still shows it (for the part before); one wholly after does not. An unknown start (null / undefined) shows it. */
export function appsPlayCaveatApplies(readStartMs: number | null | undefined): boolean {
  return readStartMs == null || readStartMs < APPS_PLAY_CAVEAT_ENDS_AT_MS
}

/** The marked changes that move the auth-success counts (everything but the coach-only and sign-in-failure-only entries): the caveat under the tagged cards and the generic report lines use these. */
export function authMarkedChanges(): MarkedChange[] {
  return markedChanges().filter((c) => !c.coachOnly && !c.authErrorOnly)
}

/** The marked sign-in-failure-only changes (the no-code to user-cancelled move): the caveat under the sign-in failure cards uses these. */
export function authErrorMarkedChanges(): MarkedChange[] {
  return markedChanges().filter((c) => c.authErrorOnly)
}

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

/** The v1.99.2 note for a tagged new-account readout on `etDay` (the sign-in first-touch fallback lifts the tagged new-account count partly through measurement), else null before its date or while it is unmarked. */
export function newAccountMeasurementNote(etDay: string): string | null {
  const c = markedChanges().find((x) => x.id === 'v1.99.2')
  return c && c.dateEt <= etDay ? `${c.id} (from ${c.dateEt}): ${c.note}` : null
}

/** The coach-strip meaning-change note for a coach readout on `etDay` (v1.99.3: × closes one tip, a written note ends the notes tip). Web and app are combined on every coach readout, so the web entry and the Play entry each count from their own date; null before both dates or while unmarked. */
export function coachMeasurementNote(etDay: string): string | null {
  const parts = markedChanges()
    .filter((c) => c.dateEt <= etDay && (c.coachOnly || c.coachNote))
    .map((c) => `${c.id} (from ${c.dateEt}): ${c.coachOnly ? c.note : c.coachNote}`)
  return parts.length ? parts.join(' | ') : null
}

/** The report lines for a read on `etDay`: a marker on the change's day, a "since" line on later
 * reads, nothing before it or while no date is set. Every change is listed, oldest first. */
export function measurementReportLines(etDay: string): string[] {
  const out: string[] = []
  for (const c of authMarkedChanges()) {
    if (c.dateEt === etDay) out.push(`MEASUREMENT CHANGE TODAY, ${c.id}: ${c.note}`)
    else if (c.dateEt < etDay) out.push(`Measurement change since ${c.dateEt}, ${c.id}: ${c.note}`)
  }
  return out
}
