// Measurement changes: days when HOW we count changed, so a jump in a count afterwards is partly
// the new counting and not performance. The one place the date is entered by hand.
//
// v1.99.2 (Best Sudoku) starts a sign-in first-touch fallback: a sign-in can now be tied back to
// the device's first ad touch, so tagged new accounts rise from that day for a reason that is not
// the ads working better. HOW TO MARK IT: when v1.99.2 is live on web, set `dateEt` below to that
// ET calendar day (YYYY-MM-DD). While it is null NOTHING shows anywhere: no timeline marker, no
// card caveat, no read-report line (the ads-cloud-daily routine's judge line is inert then too).
//
// The Play release of v1.99.2 is a second entry with its own date (2026-10-17, committed 22:49 ET 10-16; public on Google Play from 2026-10-17; it reaches the Apps arm, not the web arm). The notes registry has no
// per-arm targeting, so its caveat is the generic one under the tagged new-account cards, listed
// together with the web entry once each is dated.
//
// v1.99.3 web (dated 2026-10-17) and v1.99.3 Play (coachOnly, dated 2026-10-17, promoted 06:09:41Z, listed last so the later-timed entry wins the same-day tie) mark the coach strip meaning
// change (x closes one tip; a written note ends the notes tip). They feed only the timeline and the
// coach readouts (coachMeasurementNote): the Coach tips card, the Feature health Coach row and the
// report's tagged coach line. They stay out of the auth-success caveat and the generic report lines.
//
// v1.103.0 Android (authErrorOnly): native Google sign-in cancels move from the no-code row to user-cancelled.
// It feeds only the sign-in failure cards (lib/notes.ts 'auth-error-measurement-note'); it stays out of the
// auth-success caveat, the coach readouts and the generic report lines. Unlike the entries above it mints no
// timeline marker of its own (lib/releases.ts skips authErrorOnly): the plain v1.103.0 Play marker already
// marks that release, so the timeline shows one marker, not two. The dates must match (a test checks it).
//
// v1.105.0 (errorRowsOnly): one transient sw.js update-check failure goes to the beacon path
// /app/error/sw-update-transient instead of an obs_errors row. Like the v1.103.0 Android entry it mints no
// timeline marker (the plain v1.105.0 web and Play markers already mark the release) and stays out of the
// auth-success caveat, the sign-in failure caveat, the coach readouts and the generic report lines.
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
  /** True when the whole entry only moves the sign-in failure rows (/auth/error/<code>): it feeds the sign-in failure cards' caveat (and mints no timeline marker: the plain release marker of the same release already marks it), and is kept out of the auth-success caveat, the coach readouts and the generic report lines. */
  authErrorOnly?: boolean
  /** True when the whole entry only moves obs_errors row counts (v1.105.0: a single transient sw.js update failure no longer files a row): it mints no timeline marker and is kept out of every auth, coach and report-line consumer. */
  errorRowsOnly?: boolean
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
    dateEt: '2026-10-17', // committed to Play production 2026-10-17T02:49Z = 22:49 ET 10-16; public on Google Play from 2026-10-17
    note: "Play release of v1.99.2: Apps-arm installs get the sign-in ask-order A/B and the auth first-touch fallback, and the Play install referrer carries the campaign into the first sign-in. Public on Google Play from 2026-10-17",
  },
  {
    id: 'v1.99.3 web',
    dateEt: '2026-10-17', // web live 2026-10-17T05:58:55Z = 01:58:55 ET (version.json first read 1.99.3); before the first possible flight-3 serve (12:00 ET 10-17)
    // Detail kept here, not in the note: pre-flight organic rows since 2026-10-16 21:07Z mix v1.99.1, v1.99.2 and v1.99.3; the release also fixes the game reset/duplicate across devices, shows cross-device notices as pop-ups, never reloads mid-game, and saves right after email verification.
    note: 'live 2026-10-17 01:58 ET, before the first flight-3 serve: the coach × now closes one tip, and writing a note ends the notes tip with no beacon, so later-tip shown counts rise and notes-tip completion cannot be read from a dismissed row',
    coachOnly: true,
  },
  {
    id: 'v1.99.3 Play',
    dateEt: '2026-10-17', // promoted to Play production 2026-10-17T06:09:41Z = 02:09:41 ET (full rollout, managed publishing off); public on Play 06:34Z 10-17. Listed after the web entry: the same-day release-panel tie goes to the later-listed one, and this is the later-timed (web 05:58:55Z)
    // Committed 02:09 ET. Android installs after it may be a mix of 19902 and 19903 until updates spread.
    note: 'same coach × change as web, public on Play 06:34Z 10-17; Android coach rows are a mix of old and new until updates spread',
    coachOnly: true,
  },
  {
    id: 'v1.103.0 Android',
    dateEt: '2026-10-26', // 1.103.0 promoted to Play production 2026-10-26T22:28:21Z = 18:28:21 ET (full rollout, versionCode 1103000); 1.102.0 never reached any prod channel. Same day as the plain v1.103.0 Play marker in lib/releases.ts
    note: 'native Google sign-in cancels on Android move from the no-code row to the user-cancelled row; older Android installs keep sending cancels as no-code until they update',
    authErrorOnly: true,
  },
  {
    id: 'v1.105.0',
    dateEt: '2026-10-28', // web live 2026-10-28T21:58:36Z = 17:58:36 ET; Play production 21:55:45Z = 17:55:45 ET (full rollout, versionCode 1105000). Same day as the plain v1.105.0 markers in lib/releases.ts
    note: 'from web 21:58:36Z and Play 21:55:45Z on 10-28, a single transient sw.js update-check failure no longer counts as an error row (it goes to /app/error/sw-update-transient); a second consecutive failure still files a row, so sw-update error rows fall while older clients keep filing them until they update',
    errorRowsOnly: true,
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
  return markedChanges().filter((c) => !c.coachOnly && !c.authErrorOnly && !c.errorRowsOnly)
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
