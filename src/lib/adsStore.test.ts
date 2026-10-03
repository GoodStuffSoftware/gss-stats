import { describe, expect, it } from 'vitest'
import {
  campaignSyncStatements,
  dailyRowUpserts,
  MAX_BINDS,
  mapReadingRow,
  scrubPlayHour,
  parseCampaignIdsParam,
  placementDailyUpserts,
  readingInsert,
  readReadings,
  readSpendSummaries,
  readThresholdState,
  rowsToStoredSpend,
  SPEND_SUMMARY_SQL,
  thresholdStateInsert,
  type D1Reader,
} from './adsStore'
import { CAMPAIGNS } from './campaigns'
import type { ReadingRecord } from './adsRules'

const rec = (over: Partial<ReadingRecord> = {}): ReadingRecord => ({
  v: 1,
  id: 'threshold:24279250691:2026-09-30T12:05:00.000Z',
  campaignId: '24279250691',
  kind: 'threshold',
  readAt: '2026-09-30T12:05:00.000Z',
  etDate: '2026-09-30',
  spendThroughEt: '2026-09-29',
  cumulativeSpend: 50.1,
  thresholds: [50],
  complete: true,
  rules: [{ id: 'ctr', label: 'CTR', status: 'clear', value: 0.008, limit: 0.0015, detail: '0.8%' }],
  proposal: 'CONTINUE',
  decision: null,
  counts: { taggedArrivals: 30, asks: 5 },
  notes: ['a; b'],
  ...over,
})

describe('write builders (routine side)', () => {
  it('campaign sync upserts every configured campaign with micros money and its kind', () => {
    const [st, ...more] = campaignSyncStatements(CAMPAIGNS, '2026-09-26T16:00:00Z')
    expect(more).toEqual([])
    expect(st.sql).toMatch(/^INSERT INTO ads_campaigns \(/)
    expect(st.sql).toMatch(/ON CONFLICT \(id\) DO UPDATE SET name = excluded\.name/)
    // An unchanged definition is a no-op: the update fires only when a field (not synced_at) differs.
    expect(st.sql).toMatch(/ WHERE ads_campaigns\.name IS NOT excluded\.name OR /)
    expect(st.sql).not.toMatch(/synced_at IS NOT/)
    expect(st.binds).toHaveLength(CAMPAIGNS.length * 12)
    const retest = st.binds.slice(24, 36)
    expect(retest).toEqual(['24279250691', 'US+CA web retest', '["sudoku_funnel_retest"]', 'web', '2026-09-26', '12:00', '2026-10-02', 'active', 13_000_000, 100_000_000, 'beacon', '2026-09-26T16:00:00Z'])
    expect(st.binds.slice(12, 24)).toContain('play-direct')
    expect(st.binds.slice(12, 24)).toContain('spend-only')
  })
  it('daily rows are upserts, chunked under D1\'s 100 bound parameters, and carry the placement coverage', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, costMicros: 1, impressions: 1, clicks: 0, fetchedAt: 'x', placementsFetchedAt: i % 2 ? 'y' : null }))
    const stmts = dailyRowUpserts('24279250691', rows)
    expect(stmts).toHaveLength(3) // 12 rows x 8 binds per statement
    expect(stmts[0].sql).toMatch(/ON CONFLICT \(campaign_id, date\) DO UPDATE SET cost_micros = excluded\.cost_micros/)
    expect(stmts[0].sql).toMatch(/placements_fetched_at = excluded\.placements_fetched_at$/)
    for (const st of stmts) expect(st.binds.length).toBeLessThanOrEqual(MAX_BINDS)
    expect(stmts[0].binds.slice(0, 8)).toEqual(['24279250691', '2026-10-01', 1, 1, 0, 'google-ads-api', 'x', null])
  })
  it('placement rows carry approved as 1/0/NULL', () => {
    const [st] = placementDailyUpserts(
      '24279250691',
      [
        { date: '2026-09-27', placement: 'mobileapp::2-a', displayName: null, type: null, targetUrl: null, approved: true, costMicros: 1, impressions: 1, clicks: 0 },
        { date: '2026-09-27', placement: 'mobileapp::2-b', displayName: null, type: null, targetUrl: null, approved: null, costMicros: 1, impressions: 1, clicks: 0 },
      ],
      'x',
    )
    expect(st.binds[6]).toBe(1)
    expect(st.binds[17]).toBeNull()
  })
  it('a reading is one append with JSON columns and micros spend; a retry is a no-op', () => {
    const st = readingInsert(rec(), 'ads-reads/test')
    // No conflict target: covers both the reading_key retry and the 0003 (campaign, day, entry) key.
    expect(st.sql).toMatch(/^INSERT INTO ads_readings .* ON CONFLICT DO NOTHING$/)
    expect(st.binds[16]).toBe('threshold-50')
    expect(st.binds[7]).toBe(50_100_000)
    expect(JSON.parse(st.binds[8] as string)).toEqual([50])
    expect(st.binds[9]).toBe(1)
    expect(JSON.parse(st.binds[13] as string)).toEqual({ taggedArrivals: 30, asks: 5 })
    expect(st.binds[15]).toBe('ads-reads/test')
  })
  it('an unknown proposal string is stored as NULL (the column only allows the two proposals)', () => {
    expect(readingInsert(rec({ proposal: 'SCALE UP' })).binds[11]).toBeNull()
  })
  it('threshold state is written only for a COMPLETE threshold read, pointing at its reading', () => {
    const st = thresholdStateInsert(rec({ thresholds: [25, 50] }))!
    expect(st.sql).toMatch(/INSERT INTO ads_threshold_state .* ON CONFLICT \(campaign_id, threshold_usd\) DO NOTHING/)
    // by the de-dup key, else (a row from before 0003) by its reading_key
    expect(st.sql).toMatch(/COALESCE\(\(SELECT id FROM ads_readings WHERE campaign_id = \? AND et_date = \? AND entry_kind = \?\), \(SELECT id FROM ads_readings WHERE reading_key = \?\)\)/)
    const t = '2026-09-30T12:05:00.000Z'
    const k = rec().id
    expect(st.binds).toEqual(['24279250691', 25, t, '24279250691', '2026-09-30', 'threshold-25-50', k, '24279250691', 50, t, '24279250691', '2026-09-30', 'threshold-25-50', k])
    expect(thresholdStateInsert(rec({ complete: false }))).toBeNull()
    expect(thresholdStateInsert(rec({ kind: 'daily' }))).toBeNull()
  })
  it('no builder emits a compound SELECT (D1 caps those at 5 terms)', () => {
    const all = [...campaignSyncStatements(CAMPAIGNS, 'x'), ...dailyRowUpserts('1', [{ date: '2026-01-01', costMicros: 0, impressions: 0, clicks: 0, fetchedAt: 'x', placementsFetchedAt: null }]), readingInsert(rec()), thresholdStateInsert(rec())!]
    for (const s of all) expect(s.sql).not.toMatch(/\bUNION\b|\bINTERSECT\b|\bEXCEPT\b/i)
  })
})

describe('row mapping', () => {
  it('rowsToStoredSpend marks days closed when fetched on a later ET day', () => {
    const s = rowsToStoredSpend('24279250691', [
      { date: '2026-09-26', cost_micros: 10_500_000, impressions: 2600, clicks: 21, fetched_at: '2026-09-27T12:05:00Z' },
      { date: '2026-09-27', cost_micros: 3_000_000, impressions: 900, clicks: 5, fetched_at: '2026-09-27T12:05:00Z' },
    ])!
    expect(s.closedThroughEt).toBe('2026-09-26')
    expect(s.days['2026-09-27'].costMicros).toBe(3_000_000)
    expect(rowsToStoredSpend('x', [])).toBeNull()
  })
  it('mapReadingRow round-trips a stored row and tolerates bad JSON', () => {
    const st = readingInsert(rec())
    const cols = ['reading_key', 'campaign_id', 'kind', 'stage', 'read_at', 'et_date', 'spend_through_et', 'cumulative_spend_micros', 'thresholds', 'complete', 'rules', 'proposal', 'decision', 'counts', 'notes', 'routine_version', 'entry_kind']
    const row = Object.fromEntries(cols.map((c, i) => [c, st.binds[i]]))
    expect(mapReadingRow(row)).toEqual({ ...rec(), entryKind: 'threshold-50' })
    // A row from before migration 0003 (no entry_kind) gets the same key, derived.
    expect(mapReadingRow({ ...row, entry_kind: null })!.entryKind).toBe('threshold-50')
    expect(mapReadingRow({ ...row, counts: '{broken' })!.counts).toEqual({})
    expect(mapReadingRow({ ...row, kind: 'nope' })).toBeNull()
  })
  it('mapReadingRow drops the hour from a stored pre-R-1b Play line and leaves other times alone', () => {
    const oldLines = [
      'Play: not yet seen. Web /return/ rows are continuing (last 2026-09-30 21:00 ET), so the pipeline works and the app build simply hasn\'t landed.',
      'Play: not yet seen. Web /return/ rows last seen 2026-09-29 08:00 ET.',
      'Play: first bestsudoku-app /return/ row seen 2026-10-01 14:00 ET (2 app rows since go-live).',
    ]
    const flight = 'Flight 2 started 2026-09-30 12:26 ET'
    const st = readingInsert({ ...rec(), notes: [...oldLines, flight] })
    const cols = ['reading_key', 'campaign_id', 'kind', 'stage', 'read_at', 'et_date', 'spend_through_et', 'cumulative_spend_micros', 'thresholds', 'complete', 'rules', 'proposal', 'decision', 'counts', 'notes', 'routine_version', 'entry_kind']
    const notes = mapReadingRow(Object.fromEntries(cols.map((c, i) => [c, st.binds[i]])))!.notes
    expect(notes.slice(0, 3)).toEqual([
      'Play: not yet seen. Web /return/ rows are continuing (last 2026-09-30 ET), so the pipeline works and the app build simply hasn\'t landed.',
      'Play: not yet seen. Web /return/ rows last seen 2026-09-29 ET.',
      'Play: first bestsudoku-app /return/ row seen 2026-10-01 ET (2 app rows since go-live).',
    ])
    for (const n of notes.slice(0, 3)) expect(n).not.toMatch(/\d{2}:\d{2}/)
    expect(notes[3]).toBe(flight)
    expect(scrubPlayHour('install fix went live 26 Sep 12:26 ET')).toBe('install fix went live 26 Sep 12:26 ET')
    expect(scrubPlayHour('Play: not yet seen. Web /return/ rows last seen on 2026-09-30 ET.')).toBe('Play: not yet seen. Web /return/ rows last seen on 2026-09-30 ET.')
  })
  it('mapReadingRow stays total for malformed stored notes', () => {
    const st = readingInsert(rec())
    const cols = ['reading_key', 'campaign_id', 'kind', 'stage', 'read_at', 'et_date', 'spend_through_et', 'cumulative_spend_micros', 'thresholds', 'complete', 'rules', 'proposal', 'decision', 'counts', 'notes', 'routine_version', 'entry_kind']
    const row = Object.fromEntries(cols.map((c, i) => [c, st.binds[i]]))
    expect(mapReadingRow({ ...row, notes: '{"a":1}' })!.notes).toEqual({ a: 1 })
    expect(mapReadingRow({ ...row, notes: '"text"' })!.notes).toBe('text')
    expect(mapReadingRow({ ...row, notes: 'null' })!.notes).toBeNull()
    expect(mapReadingRow({ ...row, notes: '[1, null, "Play: Web /return/ rows last seen 2026-09-29 08:00 ET."]' })!.notes).toEqual([
      1,
      null,
      'Play: Web /return/ rows last seen 2026-09-29 ET.',
    ])
  })
})

describe('dashboard readers fail soft', () => {
  const stub = (rows: Record<string, unknown>[], throws = false): D1Reader => ({
    prepare: () => ({
      bind: () => ({
        all: async () => {
          if (throws) throw new Error('no such table: ads_daily_metrics')
          return { results: rows }
        },
      }),
    }),
  })
  it('no binding → null (callers fall back to config)', async () => {
    expect(await readSpendSummaries(undefined)).toBeNull()
    expect(await readReadings(null, '1')).toBeNull()
    expect(await readThresholdState(undefined, '1')).toBeNull()
  })
  it('a D1 error (e.g. migration not applied locally) → null, never a throw', async () => {
    expect(await readSpendSummaries(stub([], true))).toBeNull()
    expect(await readReadings(stub([], true), '1')).toBeNull()
  })
  it('summaries are keyed by campaign id', async () => {
    const m = await readSpendSummaries(stub([{ campaign_id: '24215315197', cost_micros: 124_470_711, impressions: 48844, clicks: 539, days: 8, first_date: '2026-09-02', last_date: '2026-09-09', fetched_at: 'x' }]))
    expect(m!.get('24215315197')!.costMicros).toBe(124_470_711)
    expect(SPEND_SUMMARY_SQL).toMatch(/GROUP BY campaign_id$/)
  })
})

describe('parseCampaignIdsParam (widget: empty = all campaigns)', () => {
  const known = ['1', '2', '3']
  it('repeated and comma forms, unknown ids dropped, none → all', () => {
    expect(parseCampaignIdsParam(new URLSearchParams('campaignId=2&campaignIds=3,9'), known)).toEqual(['2', '3'])
    expect(parseCampaignIdsParam(new URLSearchParams(''), known)).toEqual(known)
    expect(parseCampaignIdsParam(new URLSearchParams('campaignId=9'), known)).toEqual(known)
  })
})
