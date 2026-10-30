// The stored side of an ads reading (2026-10-30): the real wrangler D1 error surfaces, the daily
// reading carries the routine's verdict word in `proposal`, every reading names the last ET day its
// numbers cover ("data through"), and morning-read --as-of backfills a day that never ran.
// Synthetic fixtures and a real migrated SQLite: no network, no credential, never production.
import { describe, expect, it } from 'vitest'
import { redactedErrorLine } from '../../src/lib/adsRedact'
import { closedDataThrough, dataThroughNote, dataThroughOf, type RuleResult } from '../../src/lib/adsRules'
import { createSqlAdsStore } from '../../src/lib/adsStore'
import { campaignById } from '../../src/lib/campaigns'
import { MIN_COHORT } from '../../src/lib/popupEvents'
import { fixtureDeps, resolveMorningClock, type Fixture } from './cli'
import { createD1Select } from './d1'
import { wranglerAdsDb } from './d1Store'
import { dailyProposal, runMorningRead, type MorningOptions } from './read'
import { formatMorningReport } from './report'
import { openMigratedSqlite, sqliteAdsDb } from './sqliteDb'
import type { WranglerRunner } from './wrangler'

const NL = String.fromCharCode(10)
const F3_SEARCH = '24358792551'
const optsFor = (campaignId: string): MorningOptions => ({ campaignId, releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24 })

// What `wrangler d1 execute` really prints on stderr when D1 refuses a query: the proxy warning banner first,
// then the headline, then the detail line that carries the reason. Ids are made up.
const WRANGLER_7500 = [
  ' wrangler 4.0.0',
  '',
  '[WARNING] Proxy environment variables detected. We will use your proxy for fetch requests.',
  '',
  '[ERROR] A request to the Cloudflare API (/accounts/0123456789abcdef0123456789abcdef/d1/database/01234567-89ab-cdef-0123-456789abcdef/query) failed.',
  '',
  '  D1 DB reached its daily read limit. Try again later [code: 7500]',
  '',
].join(NL)

describe('redactedErrorLine', () => {
  it('skips the warning banner and keeps the real error with its reason line', () => {
    const line = redactedErrorLine([WRANGLER_7500], 400)
    expect(line).not.toContain('Proxy')
    expect(line).toContain('[ERROR] A request to the Cloudflare API')
    expect(line).toContain('[code: 7500]')
  })
  it('masks the Cloudflare account and database ids in the failing path', () => {
    const line = redactedErrorLine([WRANGLER_7500], 400)
    expect(line).not.toContain('0123456789abcdef0123456789abcdef')
    expect(line).not.toContain('01234567-89ab-cdef-0123-456789abcdef')
    expect(redactedErrorLine(['[ERROR] database 01234567-89ab-cdef-0123-456789abcdef not found'])).toBe('[ERROR] database <id> not found')
  })
  it('skips the indented body of a warning block, and falls through to the next text', () => {
    const noisy = ['[WARNING] Something odd', '  more about the odd thing', '', 'D1_ERROR: no such table: nope'].join(NL)
    expect(redactedErrorLine([noisy])).toBe('D1_ERROR: no such table: nope')
    expect(redactedErrorLine(['[WARNING] banner' + NL + '  its body', 'real failure on stdout'])).toBe('real failure on stdout')
  })
  it('falls back to the first line when everything is warning noise; plain and empty input behave like the old first line', () => {
    expect(redactedErrorLine(['[WARNING] only a banner'])).toBe('[WARNING] only a banner')
    expect(redactedErrorLine(['boom'])).toBe('boom')
    expect(redactedErrorLine(['', undefined, null])).toBe('')
    expect(redactedErrorLine(['word '.repeat(100)], 50)).toHaveLength(50)
  })
})

describe('the wrangler D1 failure message', () => {
  const failing: WranglerRunner = async () => ({ code: 1, stdout: '', stderr: WRANGLER_7500 })
  it('a read through createD1Select names the D1 limit, not the proxy warning', async () => {
    const select = createD1Select(failing, 'gss-geo')
    const err = await select('SELECT 1', []).then(
      () => null,
      (e: Error) => e,
    )
    expect(err).not.toBeNull()
    expect(err!.message).toContain('exit 1')
    expect(err!.message).toContain('[code: 7500]')
    expect(err!.message).not.toContain('Proxy')
  })
  it('a write through the ads store names it too, and the ids stay masked', async () => {
    const db = wranglerAdsDb(failing)
    const err = await db.run({ sql: 'INSERT INTO ads_readings (reading_key) VALUES (?)', binds: ['k'] }).then(
      () => null,
      (e: Error) => e,
    )
    expect(err).not.toBeNull()
    expect(err!.message).toContain('[code: 7500]')
    expect(err!.message).not.toContain('Proxy')
    expect(err!.message).not.toContain('0123456789abcdef0123456789abcdef')
  })
})

describe('dailyProposal', () => {
  const rule = (status: RuleResult['status']): RuleResult => ({ id: 4, label: 'hard cap daily', status, value: null, limit: 0, detail: '' }) as unknown as RuleResult
  it('PROPOSE PAUSE when kill rule 4 trips or the F3 rules propose one', () => {
    expect(dailyProposal(rule('trip'), undefined)).toBe('PROPOSE PAUSE')
    expect(dailyProposal(rule('clear'), { proposal: 'PROPOSE PAUSE' })).toBe('PROPOSE PAUSE')
    expect(dailyProposal(rule('trip'), { proposal: 'CONTINUE' })).toBe('PROPOSE PAUSE')
  })
  it('CONTINUE when the F3 rules ran and found nothing, or the F2 rules ran not armed', () => {
    expect(dailyProposal(rule('clear'), { proposal: 'CONTINUE' })).toBe('CONTINUE')
    expect(dailyProposal(null, { proposal: 'CONTINUE' })).toBe('CONTINUE')
    expect(dailyProposal(rule('not-armed'), undefined)).toBe('CONTINUE')
  })
  it('null when no rule was evaluated (spend unread, no data)', () => {
    expect(dailyProposal(null, undefined)).toBeNull()
    expect(dailyProposal(rule('no-data'), undefined)).toBeNull()
  })
})

describe('data through', () => {
  it('a note names the date, and dataThroughOf reads it back (and only it)', () => {
    expect(dataThroughNote('2026-10-28')).toBe('data through 2026-10-28 ET')
    expect(dataThroughOf(['campaign ENABLED/SERVING', dataThroughNote('2026-10-28')])).toBe('2026-10-28')
    expect(dataThroughOf(['campaign ENABLED/SERVING'])).toBeNull()
    expect(dataThroughOf([])).toBeNull()
    expect(dataThroughOf(['data through yesterday ET'])).toBeNull()
  })
  it('the closed day before a read, not past the flight end', () => {
    expect(closedDataThrough('2026-10-29')).toBe('2026-10-28')
    expect(closedDataThrough('2026-10-29', '2026-11-02')).toBe('2026-10-28')
    expect(closedDataThrough('2026-11-05', '2026-11-02')).toBe('2026-11-02')
    expect(closedDataThrough('2026-11-01', '2026-11-02')).toBe('2026-10-31')
  })
})

type Tagged = Extract<Fixture['beacon'], { tagged: unknown }>['tagged']
/** F3 Search, flight day 3 (2026-10-19): closed days 10-17 and 10-18 at `perDay` dollars each. */
function f3Fixture(perDay: number, tagged: Tagged, now = '2026-10-19T12:05:00Z'): Fixture {
  const micros = perDay * 1_000_000
  return {
    now,
    ads: {
      status: { id: F3_SEARCH, name: 'fixture F3 Search', status: 'ENABLED', servingStatus: 'SERVING', primaryStatus: 'ELIGIBLE', dailyBudget: 10 },
      daily: {
        '2026-10-17': { costMicros: micros, impressions: 400, clicks: 9 },
        '2026-10-18': { costMicros: micros, impressions: 500, clicks: 11 },
        '2026-10-19': { costMicros: 0, impressions: 0, clicks: 0 },
      },
      placements: [],
    },
    beacon: { tagged, siteEvents: [], returns: [], returnSites: [] },
    store: {},
  }
}
const arrivals: Tagged = [{ hour: '2026-10-17T17:00:00Z', path: '/', visitor: 'new', count: 40 }]
const withComplete: Tagged = [...arrivals, { hour: '2026-10-18T18:00:00Z', path: '/game/complete/normal/easy', visitor: 'new', count: 14 }, { hour: '2026-10-18T19:00:00Z', path: '/signin-prompt/placement', visitor: 'new', count: 3 }]

describe('the morning read stores the verdict word and data through', () => {
  it('a quiet F3 day stores CONTINUE and a data-through note on the daily row', async () => {
    const deps = fixtureDeps(f3Fixture(8.5, withComplete), false)
    const r = await runMorningRead(deps, optsFor(F3_SEARCH))
    expect(r.flight3!.proposal).toBe('CONTINUE')
    expect(r.dataThrough).toBe('2026-10-18')
    const [daily] = deps.store.written.readings.filter((x) => x.kind === 'daily')
    expect(daily).toMatchObject({ etDate: '2026-10-19', proposal: 'CONTINUE', decision: null })
    expect(dataThroughOf(daily.notes)).toBe('2026-10-18')
    expect(formatMorningReport(r)).toContain('ET, data through 2026-10-18')
  })
  it('a tripped F3 day stores PROPOSE PAUSE', async () => {
    const pausing = f3Fixture(8.5, [...arrivals, { hour: '2026-10-18T19:00:00Z', path: '/signin-prompt/placement', visitor: 'new', count: 3 }])
    const deps = fixtureDeps(pausing, false)
    await runMorningRead(deps, optsFor(F3_SEARCH))
    const [daily] = deps.store.written.readings.filter((x) => x.kind === 'daily')
    expect(daily.proposal).toBe('PROPOSE PAUSE')
  })
  it('the stored proposal fits the table CHECK: it round-trips through a real SQLite', async () => {
    const sqlite = openMigratedSqlite()
    const store = createSqlAdsStore(sqliteAdsDb(sqlite), { dryRun: false, kind: 'sqlite' })
    await store.syncCampaigns([campaignById(F3_SEARCH)!], 'x')
    const deps = { ...fixtureDeps(f3Fixture(8.5, withComplete), false), store }
    await runMorningRead(deps, optsFor(F3_SEARCH))
    const row = sqlite.prepare("SELECT proposal, decision, notes FROM ads_readings WHERE campaign_id = ? AND kind = 'daily'").get(F3_SEARCH) as { proposal: string | null; decision: string | null; notes: string }
    expect(row.proposal).toBe('CONTINUE')
    expect(row.decision).toBeNull()
    expect(dataThroughOf(JSON.parse(row.notes) as string[])).toBe('2026-10-18')
  })
})

describe('resolveMorningClock (morning-read --as-of)', () => {
  const TODAY = Date.parse('2026-10-30T16:00:00Z')
  it('without --as-of there is no override', () => {
    expect(resolveMorningClock({}, TODAY)).toBeNull()
  })
  it('the clock is 08:05 ET of the read day; the mark names the last day covered', () => {
    const c = resolveMorningClock({ 'as-of': '2026-10-29' }, TODAY)!
    expect(new Date(c.nowMs).toISOString()).toBe('2026-10-29T12:05:00.000Z') // 08:05 EDT
    expect(c.asOf).toEqual({ etDate: '2026-10-28', realNowMs: TODAY })
  })
  it('refuses today, a later day, a malformed date, and --now beside it', () => {
    expect(() => resolveMorningClock({ 'as-of': '2026-10-30' }, TODAY)).toThrow(/before today/)
    expect(() => resolveMorningClock({ 'as-of': '2026-11-02' }, TODAY)).toThrow(/before today/)
    for (const bad of ['10-29', '2026-10-29T12:00', '2026-02-30', '', 'yesterday']) expect(() => resolveMorningClock({ 'as-of': bad }, TODAY), bad).toThrow(/YYYY-MM-DD/)
    expect(() => resolveMorningClock({ 'as-of': '2026-10-29', now: '2026-10-29T12:00:00Z' }, TODAY)).toThrow(/cannot be combined/)
  })
})

describe('a morning --as-of read', () => {
  // The real day is 10-21; the read for 10-19 never ran. The fixture has spend through 10-20 so a wrongly unbounded read would show it.
  const REAL_NOW = Date.parse('2026-10-21T15:00:00Z')
  const fx = (): Fixture => {
    const f = f3Fixture(8.5, withComplete)
    const ads = f.ads as Extract<Fixture['ads'], { daily: unknown }>
    ads.daily['2026-10-19'] = { costMicros: 9_000_000, impressions: 100, clicks: 2 }
    ads.daily['2026-10-20'] = { costMicros: 50_000_000, impressions: 900, clicks: 40 }
    return f
  }
  it('stores the row under the read date with the real read_at, an as-of note, and the day before as data through', async () => {
    const clock = resolveMorningClock({ 'as-of': '2026-10-19' }, REAL_NOW)!
    const f = fx()
    f.now = new Date(clock.nowMs).toISOString()
    const deps = fixtureDeps(f, false)
    deps.asOf = clock.asOf!
    const r = await runMorningRead(deps, optsFor(F3_SEARCH))
    expect(r.etDate).toBe('2026-10-19')
    expect(r.dataThrough).toBe('2026-10-18')
    expect(r.readAt).toBe('2026-10-21T15:00:00.000Z')
    const [daily] = deps.store.written.readings.filter((x) => x.kind === 'daily')
    expect(daily).toMatchObject({ etDate: '2026-10-19', readAt: '2026-10-21T15:00:00.000Z', spendThroughEt: '2026-10-18', proposal: 'CONTINUE' })
    expect(daily.notes[0]).toContain('As-of read')
    expect(dataThroughOf(daily.notes)).toBe('2026-10-18')
    // Yesterday's spend is 10-18's ($8.50), not the later days' in the fixture.
    expect(daily.counts.yesterdaySpend).toBe(8.5)
    // A second as-of run of the same day adds nothing.
    const again = await runMorningRead(deps, optsFor(F3_SEARCH))
    expect(again.dedup.skipped.map((s) => s.kind)).toContain('daily')
    expect(deps.store.written.readings.filter((x) => x.kind === 'daily')).toHaveLength(1)
  })
  it('every beacon read of an as-of run stops at the read day midnight, the first-session ones too', async () => {
    const MIDNIGHT = Date.parse('2026-10-19T04:00:00Z')
    const clock = resolveMorningClock({ 'as-of': '2026-10-19' }, REAL_NOW)!
    const f = fx()
    f.now = new Date(clock.nowMs).toISOString()
    const deps = fixtureDeps(f, false)
    deps.asOf = clock.asOf!
    const seen: (number | null | undefined)[] = []
    const b = deps.beacon!
    deps.beacon = { ...b, returnArrivals: async (c, s, until) => (seen.push(until), b.returnArrivals!(c, s, until)) }
    await runMorningRead(deps, optsFor(F3_SEARCH))
    expect(seen.length).toBeGreaterThan(0)
    expect(new Set(seen)).toEqual(new Set([MIDNIGHT]))
  })
  it('a live read (no as-of) has no as-of note', async () => {
    const deps = fixtureDeps(f3Fixture(8.5, withComplete), false)
    await runMorningRead(deps, optsFor(F3_SEARCH))
    const [daily] = deps.store.written.readings.filter((x) => x.kind === 'daily')
    expect(daily.notes.join(' ')).not.toContain('As-of')
  })
  it('refuses an as-of release-health-only read', async () => {
    const deps = fixtureDeps(fx(), false)
    deps.asOf = { etDate: '2026-10-18', realNowMs: REAL_NOW }
    await expect(runMorningRead(deps, { ...optsFor(F3_SEARCH), healthOnly: true })).rejects.toThrow(/as-of/)
  })
})
