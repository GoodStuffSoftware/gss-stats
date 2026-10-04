// The logic of `npm run ads:play-sync` (R-4): Google Play's per-day install totals into the
// gss-stats-ads table ads_play_daily (migration 0005). Kept apart from the CLI wrapper
// (play-sync.ts) so tests import it without running a command.
//
// Stored per Play day, whole-app totals only: device installs, user installs, device uninstalls
// and active device installs. The country and traffic-source reports the reader also returns are
// never stored (no place split). Idempotent: a re-run overwrites the same days.

import { PLAY_TRACKING_ACTIVATION_DATE_ET } from '../../src/lib/popupEvents'
import { etDateFast } from '../../src/lib/etTime'
import { normalizePlayDays, writePlayDaily, type AdsDb, type PlayDayRow } from '../../src/lib/adsStore'
import { HOUSEHOLD_NOTE, RETENTION_NOTE, type PlayReportsSection } from './play'

/** The first Play day a default run reads: the Play tracking go-live (2026-09-26). */
export const DEFAULT_PLAY_SYNC_START = PLAY_TRACKING_ACTIVATION_DATE_ET ?? '2026-09-26'

export interface PlaySyncResult {
  ok: boolean
  dryRun: boolean
  since: string
  until: string
  /** The latest Play day this run read (null = none in the range). */
  installsThrough: string | null
  /** Days the report returned that are usable (well-formed, deduplicated). */
  days: number
  /** Days written; 0 on a dry run. */
  written: number
  statements: number
  error: string | null
  errors: string[]
  lines: string[]
}

export interface PlaySyncDeps {
  /** readPlayReports over a service-account path (or a fixture in tests). */
  read: (o: { since: string; until: string; flightStart: string; cumulativeSpend: number }) => Promise<PlayReportsSection>
  db: AdsDb
  nowMs: number
  dryRun: boolean
  since?: string
  until?: string
}

const ISO = /^\d{4}-\d{2}-\d{2}$/

export async function runPlaySync(deps: PlaySyncDeps): Promise<PlaySyncResult> {
  const since = deps.since ?? DEFAULT_PLAY_SYNC_START
  const until = deps.until ?? etDateFast(deps.nowMs)
  const base = { dryRun: deps.dryRun, since, until, installsThrough: null as string | null, days: 0, written: 0, statements: 0, errors: [] as string[] }
  const out = (r: Partial<PlaySyncResult> & { ok: boolean; error: string | null }): PlaySyncResult => {
    const res = { ...base, ...r }
    const lines = [`Play installs sync into gss-stats-ads (${res.dryRun ? 'DRY RUN, nothing written' : 'live'}), Play days ${since} to ${until}`]
    if (res.error) lines.push(`FAILED: ${res.error}`)
    else lines.push(`${res.days} Play days read (data through ${res.installsThrough ?? 'none yet'}); ${res.dryRun ? `would write ${res.days} days in ${res.statements} statement(s)` : `${res.written} days written in ${res.statements} statement(s)`}`)
    for (const e of res.errors) lines.push(`warning: ${e}`)
    lines.push(`note: ${HOUSEHOLD_NOTE}`, `note: ${RETENTION_NOTE}`)
    return { ...res, lines }
  }
  if (!ISO.test(since) || !ISO.test(until) || since > until) return out({ ok: false, error: `bad range ${since}..${until} (want YYYY-MM-DD, since <= until)` })

  const report = await deps.read({ since, until, flightStart: since, cumulativeSpend: 0 })
  if (!report.ok) return out({ ok: false, error: report.error ?? 'the Play report could not be read', errors: report.errors })
  // Only the installs overview matters here: the store_performance files the reader also fetches
  // are never stored, so a failure on one is a warning, not a failed sync. A failed installs month
  // file is a failure: the rest is still written (upserts), but the exit code says it was partial.
  const installErrors = report.errors.filter((e) => e.startsWith('installs overview'))
  const rows: PlayDayRow[] = (report.installsByDay ?? []).map((d) => ({ date: d.date, deviceInstalls: d.deviceInstalls, userInstalls: d.userInstalls, deviceUninstalls: d.deviceUninstalls, activeDeviceInstalls: d.activeDeviceInstalls }))
  const days = normalizePlayDays(rows)
  const w = await writePlayDaily(deps.db, days, new Date(deps.nowMs).toISOString(), { dryRun: deps.dryRun })
  const through = days.length ? days[days.length - 1].date : null
  return out({
    ok: installErrors.length === 0,
    error: installErrors.length ? `${installErrors.length} installs report file(s) could not be read; the days that were read are still written` : null,
    installsThrough: through,
    days: days.length,
    written: w.written ? w.days : 0,
    statements: w.statements,
    errors: report.errors,
  })
}
