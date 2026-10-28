// The spend-only arm's daily line (flight 4, 2026-10-28): spend, impressions, clicks, installs (the
// campaign's installActionId conversions), cost per install and cumulative spend of the cap, stored
// in ads_readings from the stored daily rows and conversions. INFO only: no rule, verdict or proposal.
// Real migrated SQLite, a made-up campaign, a made-up conversion action id: no network, no credential,
// never the production database.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SPEND_ONLY_LABEL, buildSpendOnlyLine, spendOnlyLineText, spendOnlyReading, type SpendOnlyDay } from '../../src/lib/adsRules'
import { CAMPAIGNS, campaignById, type CampaignFlight } from '../../src/lib/campaigns'
import { EXTRAS_RUN_KEY_PREFIX, createSqlAdsStore, type ConversionDayRow } from '../../src/lib/adsStore'
import { armShortName, runSpendOnlyDailyRead, type ReadDeps } from './read'
import { formatSpendOnlyReport } from './report'
import { openMigratedSqlite, sqliteAdsDb } from './sqliteDb'

const ID = '99900000041' // made up
const ACTION = '5550001111' // made up
const OTHER_ACTION = '5550002222' // made up
const NOW = Date.parse('2026-10-28T16:00:00Z') // 12:00 ET, 10-28: yesterday is 10-27
const flight = (extra: Partial<CampaignFlight> = {}): CampaignFlight => ({
  id: ID,
  label: 'Flight 9 — test installs',
  ucValues: ['sudoku_test_none'],
  flightStart: '2026-10-26',
  flightEnd: '2026-11-02',
  status: 'active',
  kind: 'play-direct',
  dailyBudgetUsd: 10,
  hardCapUsd: 75,
  installActionId: ACTION,
  measurement: 'spend-only',
  noPlacements: true,
  notes: 'test fixture only',
  ...extra,
})
function unregister() {
  for (let i = CAMPAIGNS.findIndex((c) => c.id === ID); i >= 0; i = CAMPAIGNS.findIndex((c) => c.id === ID)) CAMPAIGNS.splice(i, 1)
}
beforeEach(unregister)
afterEach(unregister)

const day = (date: string, usd: number, impressions: number, clicks: number) => ({ date, costMicros: Math.round(usd * 1e6), impressions, clicks, fetchedAt: '2026-10-28T10:00:00Z', placementsFetchedAt: null })
const conv = (date: string, id: string, n: number): ConversionDayRow => ({ date, conversionActionId: id, conversionActionName: null, conversions: n, allConversions: n })

async function seeded(opts: { coveredThrough?: string; days?: ReturnType<typeof day>[]; conversions?: ConversionDayRow[]; dryRun?: boolean } = {}) {
  CAMPAIGNS.push(flight())
  const sqlite = openMigratedSqlite()
  const adapter = sqliteAdsDb(sqlite)
  const seedStore = createSqlAdsStore(adapter, { dryRun: false })
  await seedStore.syncCampaigns(CAMPAIGNS, '2026-10-28T10:00:00Z')
  await seedStore.putDailyRows(ID, opts.days ?? [day('2026-10-26', 9.95, 800, 12), day('2026-10-27', 10.04, 1500, 30)])
  await seedStore.putConversions!(ID, opts.conversions ?? [conv('2026-10-26', ACTION, 4), conv('2026-10-27', ACTION, 20), conv('2026-10-27', OTHER_ACTION, 3)], '2026-10-28T10:00:00Z')
  const through = opts.coveredThrough ?? '2026-10-27'
  await seedStore.appendSyncRun({
    runKey: `${EXTRAS_RUN_KEY_PREFIX}test:1`,
    source: 'worker-cron',
    startedAt: '2026-10-28T10:00:00Z',
    finishedAt: '2026-10-28T10:00:05Z',
    campaigns: [ID],
    campaignsOk: [],
    campaignsPulled: [],
    daysFetched: 0,
    daysChanged: 0,
    placementRowsFetched: 0,
    placementRowsChanged: 0,
    status: 'ok',
    error: null,
    detail: { extras: { [ID]: { conversions: { covered: [['2026-10-26', through]], ok: true } } } },
  })
  const store = createSqlAdsStore(adapter, { dryRun: !!opts.dryRun })
  const deps = { nowMs: NOW, ads: null, beacon: null, firebase: null, store, dryRun: !!opts.dryRun } as unknown as ReadDeps
  const rows = () => sqlite.prepare("SELECT et_date, spend_through_et, cumulative_spend_micros, kind, complete, rules, proposal, decision, counts, notes FROM ads_readings WHERE campaign_id = ? ORDER BY et_date").all(ID) as Record<string, unknown>[]
  return { sqlite, deps, rows }
}

describe('buildSpendOnlyLine', () => {
  const days: SpendOnlyDay[] = [
    { date: '2026-10-26', costMicros: 9_950_000, impressions: 800, clicks: 12, installs: 4 },
    { date: '2026-10-27', costMicros: 10_040_000, impressions: 1500, clicks: 30, installs: 20 },
  ]
  it('has the agreed fields, the label and the cumulative spend of the cap', () => {
    const l = buildSpendOnlyLine(days, '2026-10-27', '2026-10-26', 75)
    expect(l).toEqual({ date: '2026-10-27', flightDay: 2, spend: 10.04, impressions: 1500, clicks: 30, installs: 20, costPerInstall: 0.5, cumulativeSpend: 19.99, hardCap: 75, atOrOverCap: false, label: 'spend-only, Google-reported installs' })
    expect(l.label).toBe(SPEND_ONLY_LABEL)
    const first = buildSpendOnlyLine(days, '2026-10-26', '2026-10-26', 75)
    expect(first).toMatchObject({ flightDay: 1, cumulativeSpend: 9.95, costPerInstall: 2.49 })
  })
  it('cost per install is null (not Infinity or NaN) with zero installs, and a zero-spend day is 0 not null', () => {
    const none: SpendOnlyDay[] = [{ date: '2026-10-26', costMicros: 3_000_000, impressions: 100, clicks: 2, installs: 0 }]
    const l = buildSpendOnlyLine(none, '2026-10-26', '2026-10-26', 75)
    expect(l.costPerInstall).toBeNull()
    expect(JSON.stringify(l)).toContain('"costPerInstall":null')
    expect(spendOnlyLineText(l, 'F9')).toContain('n/a per install (no installs yet)')
    expect(spendOnlyLineText(l, 'F9')).not.toMatch(/Infinity|NaN/)
    const free = buildSpendOnlyLine([{ date: '2026-10-26', costMicros: 0, impressions: 0, clicks: 0, installs: 2 }], '2026-10-26', '2026-10-26', 75)
    expect(free.costPerInstall).toBe(0)
  })
  it('sums spend from the flight start through the day only, and flags the cap at or over it without proposing anything', () => {
    const big: SpendOnlyDay[] = [
      { date: '2026-10-26', costMicros: 40_000_000, impressions: 1, clicks: 1, installs: 1 },
      { date: '2026-10-27', costMicros: 35_000_000, impressions: 1, clicks: 1, installs: 1 },
      { date: '2026-10-28', costMicros: 5_000_000, impressions: 1, clicks: 1, installs: 1 },
    ]
    expect(buildSpendOnlyLine(big, '2026-10-26', '2026-10-26', 75)).toMatchObject({ cumulativeSpend: 40, atOrOverCap: false })
    const atCap = buildSpendOnlyLine(big, '2026-10-27', '2026-10-26', 75)
    expect(atCap).toMatchObject({ cumulativeSpend: 75, atOrOverCap: true })
    const over = buildSpendOnlyLine(big, '2026-10-28', '2026-10-26', 75)
    expect(over).toMatchObject({ cumulativeSpend: 80, atOrOverCap: true })
    const text = spendOnlyLineText(over, 'F9')
    expect(text).toBe('F9 day 3 INFO: $80.00 of $75.00 cap, $5.00 per install (Google-reported), $5.00 that day, 1 clicks, 1 impr, 1 installs; spend-only, Google-reported installs; over cap (info only)')
    expect(text).not.toMatch(/PROPOSE|CONTINUE|pause|ask Mike/i)
    const worst = buildSpendOnlyLine([{ date: '2026-10-26', costMicros: 100_000_000, impressions: 123456, clicks: 1234, installs: 120 }], '2026-10-26', '2026-10-26', 75)
    expect(spendOnlyLineText(worst, 'F4').length).toBeLessThan(200) // a push line stays under 200 characters
  })
  it('refuses a day with no row (a gap never reads as a zero day)', () => {
    expect(() => buildSpendOnlyLine(days, '2026-10-29', '2026-10-26', 75)).toThrow(/no row for 2026-10-29/)
  })
})

describe('spendOnlyReading', () => {
  it('is a daily reading with no rules, decision, proposal or thresholds, for the next ET day', () => {
    const l = buildSpendOnlyLine([{ date: '2026-10-26', costMicros: 9_950_000, impressions: 800, clicks: 12, installs: 4 }], '2026-10-26', '2026-10-26', 75)
    const r = spendOnlyReading(ID, l, '2026-10-28T16:00:00.000Z', 'F9')
    expect(r).toMatchObject({ kind: 'daily', etDate: '2026-10-27', spendThroughEt: '2026-10-26', cumulativeSpend: 9.95, complete: true, rules: null, decision: null, proposal: null, thresholds: [] })
    expect(r.id).toBe(`daily:${ID}:spend-only:2026-10-26`)
    expect(r.counts).toEqual({ flightDay: 1, spend: 9.95, impressions: 800, clicks: 12, installs: 4, costPerInstall: 2.49, cumulativeSpend: 9.95, hardCap: 75 })
    expect(r.notes[0]).toBe(SPEND_ONLY_LABEL)
    expect(r.f3).toBeUndefined()
  })
})

describe('runSpendOnlyDailyRead', () => {
  it('stores one line per closed day (a backfill), counting only the campaign installActionId, and a rerun stores nothing', async () => {
    const { deps, rows } = await seeded()
    const r = await runSpendOnlyDailyRead(deps, { campaignId: ID })
    expect(r.errors).toEqual([])
    expect(r.gaps).toEqual([])
    expect(r.stored).toEqual(['2026-10-26', '2026-10-27'])
    expect(r.lines.map((l) => [l.date, l.installs, l.costPerInstall, l.cumulativeSpend])).toEqual([
      ['2026-10-26', 4, 2.49, 9.95],
      ['2026-10-27', 20, 0.5, 19.99], // the other action's 3 conversions are not installs
    ])
    expect(r.thresholds).toBeNull()
    expect(r.proposal).toBeNull()
    expect(r.notify).toEqual({ push: true, busCopy: false, reason: expect.any(String), text: 'F9 day 2 INFO: $19.99 of $75.00 cap, $0.50 per install (Google-reported), $10.04 that day, 30 clicks, 1500 impr, 20 installs; spend-only, Google-reported installs' })
    const stored = rows()
    expect(stored.map((x) => [x.et_date, x.spend_through_et, x.kind, x.complete, x.rules, x.proposal, x.decision])).toEqual([
      ['2026-10-27', '2026-10-26', 'daily', 1, null, null, null],
      ['2026-10-28', '2026-10-27', 'daily', 1, null, null, null],
    ])
    expect(JSON.parse(stored[1].counts as string)).toMatchObject({ installs: 20, costPerInstall: 0.5, cumulativeSpend: 19.99, hardCap: 75 })
    expect(stored[1].cumulative_spend_micros).toBe(19_990_000)

    const again = await runSpendOnlyDailyRead(deps, { campaignId: ID })
    expect(again.stored).toEqual([])
    expect(again.lines).toHaveLength(2)
    expect(rows()).toHaveLength(2)
    expect(formatSpendOnlyReport(again)).toContain('none (already recorded)')
  })
  it('stores a zero-install day with cost per install null in the row', async () => {
    const { deps, rows } = await seeded({ conversions: [conv('2026-10-27', ACTION, 5)] }) // nothing on 10-26
    await runSpendOnlyDailyRead(deps, { campaignId: ID })
    const first = JSON.parse(rows()[0].counts as string)
    expect(first.installs).toBe(0)
    expect(first.costPerInstall).toBeNull()
    expect(rows()[0].counts).not.toMatch(/Infinity|NaN/)
  })
  it('treats a spend row fetched before its day closed (03:00 ET next day) as a gap, never stores it', async () => {
    const early = { ...day('2026-10-27', 10.04, 1500, 30), fetchedAt: '2026-10-28T05:00:00Z' } // 01:00 ET on 10-28
    const { deps, rows } = await seeded({ days: [day('2026-10-26', 9.95, 800, 12), early] })
    const r = await runSpendOnlyDailyRead(deps, { campaignId: ID })
    expect(r.stored).toEqual(['2026-10-26'])
    expect(r.gaps).toEqual([{ date: '2026-10-27', reason: 'daily spend fetched before the day closed' }])
    expect(rows()).toHaveLength(1)
  })
  it('waits (stores nothing for it or later) while a day\'s install conversions are not synced yet, instead of storing a false zero', async () => {
    const { deps, rows } = await seeded({ coveredThrough: '2026-10-26' })
    const r = await runSpendOnlyDailyRead(deps, { campaignId: ID })
    expect(r.stored).toEqual(['2026-10-26'])
    expect(r.gaps).toEqual([{ date: '2026-10-27', reason: 'install conversions not stored yet' }])
    expect(rows()).toHaveLength(1)
    expect(formatSpendOnlyReport(r)).toContain('Waiting: 2026-10-27 install conversions not stored yet')
  })
  it('waits while a day\'s spend row is missing', async () => {
    const { deps } = await seeded({ days: [day('2026-10-27', 10.04, 1500, 30)] })
    const r = await runSpendOnlyDailyRead(deps, { campaignId: ID })
    expect(r.stored).toEqual([])
    expect(r.gaps[0]).toEqual({ date: '2026-10-26', reason: 'daily spend not stored yet' })
    expect(r.notify.text).toBeNull()
  })
  it('--dry-run stores nothing', async () => {
    const { deps, rows } = await seeded({ dryRun: true })
    const r = await runSpendOnlyDailyRead(deps, { campaignId: ID })
    expect(r.dryRun).toBe(true)
    expect(rows()).toHaveLength(0)
    expect(formatSpendOnlyReport(r)).toContain('Would store: 2026-10-26, 2026-10-27')
  })
  it('spend over the cap is information only: the line and the stored row carry no proposal', async () => {
    const { deps, rows } = await seeded({ days: [day('2026-10-26', 70, 8000, 120), day('2026-10-27', 10, 1500, 30)] })
    const r = await runSpendOnlyDailyRead(deps, { campaignId: ID })
    expect(r.lines.at(-1)).toMatchObject({ cumulativeSpend: 80, atOrOverCap: true })
    expect(r.notify.text).toContain('over cap (info only)')
    expect(r.notify.text).not.toMatch(/PROPOSE|CONTINUE|pause|ask Mike/i)
    expect(rows().every((x) => x.proposal === null && x.rules === null && x.decision === null)).toBe(true)
    expect(JSON.stringify(r)).not.toMatch(/PROPOSE PAUSE/)
  })
  it('does not read past the flight end', async () => {
    const { deps } = await seeded({ days: [day('2026-10-26', 5, 1, 1), day('2026-10-27', 5, 1, 1)] })
    campaignById(ID)!.flightEnd = '2026-10-26'
    const r = await runSpendOnlyDailyRead(deps, { campaignId: ID })
    expect(r.lines.map((l) => l.date)).toEqual(['2026-10-26'])
  })
  it('refuses a campaign that is not a spend-only install arm (no installActionId, or a read-plan campaign)', async () => {
    const { deps } = await seeded()
    campaignById(ID)!.installActionId = undefined
    await expect(runSpendOnlyDailyRead(deps, { campaignId: ID })).rejects.toThrow(/installActionId/)
    await expect(runSpendOnlyDailyRead(deps, { campaignId: '24358792551' })).rejects.toThrow(/not a spend-only campaign/)
    await expect(runSpendOnlyDailyRead(deps, { campaignId: '24215315197' })).rejects.toThrow()
  })
})

describe('the F4 registry entry and the code path', () => {
  it('carries installActionId 7756366796, and no read code hardcodes it', () => {
    const f4 = campaignById('24392866056')!
    expect(f4.installActionId).toBe('7756366796')
    expect(f4.hardCapUsd).toBe(75)
    for (const rel of ['../../src/lib/adsRules.ts', './read.ts', './report.ts', './morning-read.ts']) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
      expect(src, rel).not.toContain('7756366796')
    }
  })
  it('names the arm F<n> from its label', () => {
    expect(armShortName('Flight 4 — Android installs')).toBe('F4')
    expect(armShortName('Retest')).toBe('Retest')
  })
})
