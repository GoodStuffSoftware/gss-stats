// ADR 0005 slice 3, step A: the engine pieces a readings-log card needs — the nested readings
// repeat, the five whitelisted count paths (the counts-only privacy rule, read as rows only), the
// campaign freshness / thresholds fields, the ET datetime display, the sign-ups text and the
// repeat limit.
import { describe, expect, it } from 'vitest'
import { campaignById } from '../campaigns'
import { signUpsText, SIGNUPS_HINT, etDateTimeText, readingKindLabel } from '../adsReadingsFormat'
import type { ReadingRecord } from '../adsRules'
import type { AdsReadingsResponse } from '../adsStore'
import { itemViewModel } from './render'
import { readingScopeOf, readingsLoadOf } from './readingsScope'
import { nestScope, readingsLimit, readingsLimitOf, repeatsOverReadings, resolveRepeat, scopeField, sectionCells, type CampaignAdsInfo, type ReadingScope, type ScopeInstance } from './scope'
import { DEFAULT_READINGS_LIMIT, isReadingCountPath, MAX_READINGS_LIMIT, READING_COUNT_FIELDS, READING_COUNT_PATHS, type CardSpec, type MetricItem, type ScopePath } from './types'
import { validateCard } from './validate'

const A = campaignById('24279250691')!
const B = campaignById('24215315197')!
const CTX = { todayEt: '2026-10-03' }

const reading = (campaignId: string, n: number, extra: Partial<ReadingScope> = {}): ReadingScope => ({ campaignId, readAt: `2026-10-0${n}T15:00:00Z`, kind: 'daily', spend: n, ...extra })
const campaignScope = (c = A, ads?: CampaignAdsInfo): ScopeInstance => ({ kind: 'campaign', campaign: c, ...(ads ? { ads } : {}) })

describe('resolveRepeat: readings nested in a campaign', () => {
  const readings = [reading(A.id, 1), reading(B.id, 2), reading(A.id, 3), reading(B.id, 4)]
  it('keeps only the readings of the campaign the repeat sits in', () => {
    const forA = resolveRepeat({ over: 'readings' }, { ...CTX, readings }, campaignScope(A))
    expect(forA.map((s) => (s.kind === 'reading' ? s.reading.spend : null))).toEqual([1, 3])
    const forB = resolveRepeat({ over: 'readings' }, { ...CTX, readings }, campaignScope(B))
    expect(forB.map((s) => (s.kind === 'reading' ? s.reading.spend : null))).toEqual([2, 4])
  })
  it('with no campaign in scope it is every reading, in order', () => {
    expect(resolveRepeat({ over: 'readings' }, { ...CTX, readings })).toHaveLength(4)
    expect(resolveRepeat({ over: 'readings' }, { ...CTX, readings }, { kind: 'root' })).toHaveLength(4)
  })
  it('the organic arm has no readings log: it gets none of the campaigns readings', () => {
    expect(resolveRepeat({ over: 'readings' }, { ...CTX, readings }, { kind: 'organic' })).toEqual([])
  })
  it('a campaigns repeat honours ids (so a widget campaignIds narrowing reaches the readings)', () => {
    const cs = resolveRepeat({ over: 'campaigns', ids: [B.id] }, { ...CTX, readings })
    expect(cs).toHaveLength(1)
    const nested = resolveRepeat({ over: 'readings' }, { ...CTX, readings }, cs[0])
    expect(nested.every((s) => s.kind === 'reading' && s.reading.campaignId === B.id)).toBe(true)
  })
  it('a campaign instance carries the readings load facts for its campaign only', () => {
    const adsA: CampaignAdsInfo = { spendThrough: '2026-10-01', lastSync: null, stale: false, storeBound: true, thresholdsFired: null, loadedAtMs: 0 }
    const cs = resolveRepeat({ over: 'campaigns', ids: [A.id, B.id] }, { ...CTX, ads: { [A.id]: adsA } })
    expect(cs[0]).toMatchObject({ kind: 'campaign', ads: adsA })
    expect(cs[1]).not.toHaveProperty('ads')
  })
  it('the reading instance keeps the campaign instance as its parent once nested', () => {
    const [r] = resolveRepeat({ over: 'readings' }, { ...CTX, readings }, campaignScope(A))
    const nested = nestScope(r, campaignScope(A, { spendThrough: '2026-10-01', lastSync: null, stale: false, storeBound: true, thresholdsFired: null, loadedAtMs: 0 }))
    expect(scopeField(nested, 'campaign.label')).toBe(A.label)
    expect(scopeField(nested, 'reading.spend')).toBe('1')
    expect(scopeField(nested, 'campaign.freshness')).toContain('Spend through Oct 1')
  })
})

describe('section cells: a readings table inside a campaign card', () => {
  const item: MetricItem = { id: 'spend', label: 'Spend', data: { field: 'reading.spend' }, display: { as: 'currency' } }
  it('each campaign card lists its own readings, not everyone', () => {
    const readings = [reading(A.id, 1), reading(B.id, 2), reading(A.id, 3)]
    const section = { layout: 'table' as const, repeat: { over: 'readings' as const }, items: [item] }
    expect(sectionCells(section, campaignScope(A), { ...CTX, readings })).toHaveLength(2)
    expect(sectionCells(section, campaignScope(B), { ...CTX, readings })).toHaveLength(1)
  })
})

describe('readings repeat limit', () => {
  const many = Array.from({ length: 600 }, (_, i) => ({ campaignId: A.id, readAt: '2026-10-01T00:00:00Z', kind: 'daily', spend: i }))
  it('defaults to 30, caps at 500, floors a fraction, ignores a non-number', () => {
    expect(DEFAULT_READINGS_LIMIT).toBe(30)
    expect(MAX_READINGS_LIMIT).toBe(500)
    expect(resolveRepeat({ over: 'readings' }, { ...CTX, readings: many })).toHaveLength(30)
    expect(resolveRepeat({ over: 'readings', limit: 10 }, { ...CTX, readings: many })).toHaveLength(10)
    expect(resolveRepeat({ over: 'readings', limit: 9999 }, { ...CTX, readings: many })).toHaveLength(500)
    expect(readingsLimit({ limit: 2.9 })).toBe(2)
    expect(readingsLimit({ limit: 0 })).toBe(30)
    expect(readingsLimit({ limit: -4 })).toBe(30)
    expect(readingsLimit({ limit: Number.NaN })).toBe(30)
    expect(readingsLimit({ limit: '5' as never })).toBe(30)
  })
  it('keeps the newest first: the first N of the list', () => {
    const out = resolveRepeat({ over: 'readings', limit: 3 }, { ...CTX, readings: many })
    expect(out.map((s) => (s.kind === 'reading' ? s.reading.spend : -1))).toEqual([0, 1, 2])
  })
  it('the limit applies per campaign when nested', () => {
    const rs = [...Array.from({ length: 5 }, (_, i) => reading(A.id, 1, { spend: i })), ...Array.from({ length: 5 }, (_, i) => reading(B.id, 1, { spend: i }))]
    expect(resolveRepeat({ over: 'readings', limit: 2 }, { ...CTX, readings: rs }, campaignScope(A))).toHaveLength(2)
    expect(resolveRepeat({ over: 'readings', limit: 2 }, { ...CTX, readings: rs }, campaignScope(B))).toHaveLength(2)
  })
  it('a card finds its readings repeats, and the biggest limit to request', () => {
    const spec: CardSpec = {
      v: 1,
      repeat: { over: 'campaigns' },
      sections: [
        { layout: 'table', repeat: { over: 'readings', limit: 12 }, items: [] },
        { layout: 'rows', items: [{ id: 'x', label: 'x', repeat: { over: 'readings', limit: 40 }, data: { field: 'reading.kind' }, display: { as: 'text' } }] },
      ],
    }
    expect(repeatsOverReadings(spec)).toBe(true)
    expect(readingsLimitOf(spec)).toBe(40)
    const plain: CardSpec = { v: 1, sections: [{ layout: 'rows', items: [] }] }
    expect(repeatsOverReadings(plain)).toBe(false)
    expect(readingsLimitOf(plain)).toBe(30)
  })
})

describe('reading.count.*: the five whitelisted paths (counts only, rows only)', () => {
  const rd = (counts: ReadingScope['counts'], extra: Partial<ReadingScope> = {}): ScopeInstance => ({ kind: 'reading', reading: { ...reading(A.id, 1), counts, ...extra } })

  it('is exactly five paths, each tied to one record field', () => {
    expect(READING_COUNT_PATHS.slice().sort()).toEqual(['reading.count.accepts', 'reading.count.arrivals', 'reading.count.asks', 'reading.count.auth', 'reading.count.signUpsAtMost'])
    expect(READING_COUNT_FIELDS).toEqual({
      'reading.count.arrivals': 'taggedArrivals',
      'reading.count.asks': 'asks',
      'reading.count.accepts': 'accepts',
      'reading.count.auth': 'authSuccess',
      'reading.count.signUpsAtMost': 'signUpsAtMost',
    })
  })
  it('no allow-listed field is a /return, game-start, game-complete, tutorial or tour count', () => {
    for (const field of Object.values(READING_COUNT_FIELDS)) expect(field).not.toMatch(/return|gameStart|game-start|gameComplete|game-complete|tutorial|tour|segment|device|hour|place|country/i)
    for (const path of [...READING_COUNT_PATHS, 'reading.count.signUps']) expect(path).not.toMatch(/return|gamestart|gamecomplete|tutorial|tour/i)
  })
  it('only the allow-list counts as a reading count path: a generic or refused key is not one', () => {
    for (const p of [...READING_COUNT_PATHS, 'reading.count.signUps']) expect(isReadingCountPath(p)).toBe(true)
    for (const p of ['reading.count.returnD0Web', 'reading.count.gameStart', 'reading.count.tutorialComplete', 'reading.count.tour', 'reading.count.', 'reading.count', 'reading.count.__proto__', 'reading.count.toString', 'reading.counts.asks'])
      expect(isReadingCountPath(p)).toBe(false)
  })
  it('each path reads its own count; a missing or null count is null (the empty gating decides)', () => {
    const s = rd({ taggedArrivals: 10, asks: 20, accepts: 30, authSuccess: 40, signUpsAtMost: 50 })
    expect(scopeField(s, 'reading.count.arrivals')).toBe('10')
    expect(scopeField(s, 'reading.count.asks')).toBe('20')
    expect(scopeField(s, 'reading.count.accepts')).toBe('30')
    expect(scopeField(s, 'reading.count.auth')).toBe('40')
    expect(scopeField(s, 'reading.count.signUpsAtMost')).toBe('50')
    expect(scopeField(rd({ taggedArrivals: 0 }), 'reading.count.arrivals')).toBe('0') // a measured zero is a value
    expect(scopeField(rd({ asks: null }), 'reading.count.asks')).toBeNull()
    expect(scopeField(rd(undefined), 'reading.count.asks')).toBeNull()
    expect(scopeField({ kind: 'root' }, 'reading.count.asks')).toBeNull()
  })
  it('an unlisted key smuggled into a scope is unreachable through any path', () => {
    const sneaky = rd({ taggedArrivals: 1, returnD0Web: 99, gameStart: 98 } as never)
    const paths: ScopePath[] = [...READING_COUNT_PATHS, 'reading.count.signUps', 'reading.kind', 'reading.rules', 'reading.proposal', 'reading.readAt', 'reading.spend']
    for (const p of paths) expect(String(scopeField(sneaky, p))).not.toMatch(/9[89]/)
  })
})

describe('reading.count.signUps: the derived Sign-ups text', () => {
  const rd = (atMost: number | null | undefined, exact: boolean): ScopeInstance => ({ kind: 'reading', reading: { ...reading(A.id, 1), counts: { signUpsAtMost: atMost }, signUpsExact: exact } })
  it('"N (exact)" when exact, "at most N" otherwise, an em dash when unread', () => {
    expect(scopeField(rd(1234, true), 'reading.count.signUps')).toBe('1,234 (exact)')
    expect(scopeField(rd(7, false), 'reading.count.signUps')).toBe('at most 7')
    expect(scopeField(rd(null, true), 'reading.count.signUps')).toBe('—')
    expect(scopeField(rd(undefined, false), 'reading.count.signUps')).toBe('—')
    expect(scopeField(rd(0, true), 'reading.count.signUps')).toBe('0 (exact)')
  })
  it('is the text the widget draws (one shared function), and the tooltip is shared too', () => {
    expect(signUpsText(5, true)).toBe('5 (exact)')
    expect(signUpsText(5, false)).toBe('at most 5')
    expect(signUpsText(null, false)).toBe('—')
    expect(SIGNUPS_HINT).toMatch(/UPPER bound/)
  })
})

describe('campaign.freshness and campaign.thresholds', () => {
  const NOW = Date.parse('2026-10-03T14:00:00Z')
  const ads = (over: Partial<CampaignAdsInfo> = {}): CampaignAdsInfo => ({ spendThrough: '2026-10-02', lastSync: '2026-10-03T12:00:00Z', stale: false, storeBound: true, thresholdsFired: null, loadedAtMs: NOW, ...over })
  it('is the shared freshness line, and the stale note when a closed day is missing', () => {
    expect(scopeField(campaignScope(A, ads()), 'campaign.freshness')).toBe('Spend through Oct 2 · synced 2h ago')
    expect(scopeField(campaignScope(A, ads({ stale: true })), 'campaign.freshness')).toBe('Spend through Oct 2 · synced 2h ago · stale — sync pending')
    expect(scopeField(campaignScope(A, ads({ spendThrough: null, lastSync: null })), 'campaign.freshness')).toBe('No closed spend day stored yet · not synced yet')
  })
  it('is null with no readings load yet, with the store not bound, or off a campaign', () => {
    expect(scopeField(campaignScope(A), 'campaign.freshness')).toBeNull()
    expect(scopeField(campaignScope(A, ads({ storeBound: false })), 'campaign.freshness')).toBeNull()
    expect(scopeField({ kind: 'organic' }, 'campaign.freshness')).toBeNull()
    expect(scopeField({ kind: 'root' }, 'campaign.thresholds')).toBeNull()
  })
  it('lists the fired thresholds with their ET time, null when none fired', () => {
    const fired = [
      { threshold: 50, firedAt: '2026-10-01T19:00:00Z' },
      { threshold: 100, firedAt: '2026-10-02T19:30:00Z' },
    ]
    expect(scopeField(campaignScope(A, ads({ thresholdsFired: fired })), 'campaign.thresholds')).toBe('$50 · Oct 1, 3:00 PM ET; $100 · Oct 2, 3:30 PM ET')
    expect(scopeField(campaignScope(A, ads({ thresholdsFired: [] })), 'campaign.thresholds')).toBeNull()
    expect(scopeField(campaignScope(A, ads()), 'campaign.thresholds')).toBeNull()
  })
  it('a reading inside the campaign sees its freshness through the parent chain', () => {
    const inner = nestScope({ kind: 'reading', reading: reading(A.id, 1) }, campaignScope(A, ads()))
    expect(scopeField(inner, 'campaign.freshness')).toBe('Spend through Oct 2 · synced 2h ago')
  })
})

describe('datetime-et display', () => {
  const item = (display: MetricItem['display']): MetricItem => ({ id: 'when', label: 'Read', data: { field: 'reading.readAt' }, display })
  const scope: ScopeInstance = { kind: 'reading', reading: reading(A.id, 1, { readAt: '2026-09-26T19:00:00Z' }) }
  const opts = { todayEt: '2026-10-03', nowMs: Date.parse('2026-10-03T14:00:00Z') }
  it('shows an ISO instant as Eastern time', () => {
    expect(itemViewModel(item({ as: 'datetime-et' }), undefined, scope, opts).primary).toBe('Sep 26, 3:00 PM ET')
    expect(etDateTimeText('2026-01-15T17:05:00Z')).toBe('Jan 15, 12:05 PM ET') // EST, not EDT
  })
  it('leaves the plain datetime display as the raw text', () => {
    expect(itemViewModel(item({ as: 'datetime' }), undefined, scope, opts).primary).toBe('2026-09-26T19:00:00Z')
  })
  it('hands back text that is not a date untouched, and an empty value gets the empty gating', () => {
    const odd: ScopeInstance = { kind: 'reading', reading: reading(A.id, 1, { readAt: 'not a date' }) }
    expect(itemViewModel(item({ as: 'datetime-et' }), undefined, odd, opts).primary).toBe('not a date')
    const vm = itemViewModel(item({ as: 'datetime-et' }), undefined, { kind: 'root' }, opts)
    expect(vm.primary).toBe('—')
  })
  it('the kind label is shared with the widget', () => {
    expect(readingKindLabel({ kind: 'threshold', stage: undefined, thresholds: [50, 100] })).toBe('threshold $50, $100')
    expect(readingKindLabel({ kind: 'postflight', stage: 'wrapup', thresholds: [] })).toBe('post-flight wrapup')
    expect(readingKindLabel({ kind: 'health', stage: undefined, thresholds: [] })).toBe('health')
  })
})

describe('readingScopeOf / readingsLoadOf: only the five counts leave a stored record', () => {
  const record = (over: Partial<ReadingRecord> = {}): ReadingRecord =>
    ({
      v: 1,
      id: 'r1',
      campaignId: A.id,
      kind: 'daily',
      readAt: '2026-10-02T12:00:00Z',
      etDate: '2026-10-02',
      spendThroughEt: '2026-10-01',
      cumulativeSpend: 12.5,
      thresholds: [],
      complete: true,
      rules: null,
      proposal: null,
      decision: null,
      counts: {
        taggedArrivals: 1,
        asks: 2,
        accepts: 3,
        authSuccess: 4,
        signUpsAtMost: 5,
        signUpsExact: 1,
        returnD0Web: 111,
        returnD1: 112,
        returnD31to60: 113,
        returnD0App: 114,
        gameStart: 115,
        gameStarts: 116,
        gameComplete: 117,
        tutorialComplete: 118,
        tourSkip: 119,
        tourExit: 120,
      },
      notes: [],
      ...over,
    }) as ReadingRecord

  it('copies the five allow-listed counts and nothing else', () => {
    const s = readingScopeOf(record())
    expect(Object.keys(s.counts ?? {}).sort()).toEqual(['accepts', 'asks', 'authSuccess', 'signUpsAtMost', 'taggedArrivals'])
    expect(s.counts).toEqual({ taggedArrivals: 1, asks: 2, accepts: 3, authSuccess: 4, signUpsAtMost: 5 })
    expect(JSON.stringify(s)).not.toMatch(/11\d|120|return|tutorial|tour|gameStart|gameComplete/i)
    expect(s.signUpsExact).toBe(true)
  })
  it('a missing count is null, an inexact bound is not exact, and null spend stays null', () => {
    const s = readingScopeOf(record({ cumulativeSpend: null, counts: { asks: 9 } }))
    expect(s.counts).toEqual({ taggedArrivals: null, asks: 9, accepts: null, authSuccess: null, signUpsAtMost: null })
    expect(s.signUpsExact).toBe(false)
    expect(s.spend).toBeNull()
    expect(s.complete).toBe(true)
  })
  it('carries the formatted kind, the read time and the campaign', () => {
    const s = readingScopeOf(record({ kind: 'threshold', thresholds: [50] }))
    expect(s).toMatchObject({ campaignId: A.id, kind: 'threshold $50', readAt: '2026-10-02T12:00:00Z' })
  })
  it('the whole response: readings tagged by campaign, the freshness facts by campaign id', () => {
    const res = {
      storeBound: true,
      storeReadable: true,
      generatedAt: '2026-10-03T14:00:00Z',
      campaigns: [
        { campaignId: A.id, label: A.label, status: 'active', spend: {}, spendThrough: '2026-10-02', lastSync: '2026-10-03T12:00:00Z', stale: true, thresholdsFired: [{ threshold: 50, firedAt: '2026-10-01T19:00:00Z' }], readings: [record({ id: 'a1' }), record({ id: 'a2' })] },
        { campaignId: B.id, label: B.label, status: 'closed', spend: {}, spendThrough: null, lastSync: null, stale: false, thresholdsFired: null, readings: [record({ id: 'b1', campaignId: 'wrong' })] },
      ],
    } as unknown as AdsReadingsResponse
    const load = readingsLoadOf(res)
    expect(load.readings.map((r) => r.campaignId)).toEqual([A.id, A.id, B.id]) // the response's grouping wins
    expect(load.ads[A.id]).toMatchObject({ spendThrough: '2026-10-02', stale: true, storeBound: true, loadedAtMs: Date.parse('2026-10-03T14:00:00Z') })
    expect(load.ads[B.id].thresholdsFired).toBeNull()
    expect(readingsLoadOf(null)).toEqual({ readings: [], ads: {} })
  })
})

describe('validateCard: reading counts and the limit', () => {
  const card = (item: Partial<MetricItem>, repeat: CardSpec['sections'][number]['repeat'] = { over: 'readings' }): CardSpec => ({
    v: 1,
    sections: [{ layout: 'table', repeat, items: [{ id: 'i', label: 'L', data: { field: 'reading.count.asks' }, display: { as: 'number' }, ...item }] }],
  })
  it('accepts the five paths, the derived text, the freshness fields and datetime-et', () => {
    for (const p of [...READING_COUNT_PATHS, 'reading.count.signUps'] as ScopePath[]) expect(validateCard(card({ data: { field: p }, display: { as: 'text' } }))).toEqual([])
    expect(validateCard(card({ data: { field: 'reading.readAt' }, display: { as: 'datetime-et' } }))).toEqual([])
    expect(validateCard(card({ data: { field: 'campaign.freshness' }, display: { as: 'text' } }, undefined))).toEqual([])
  })
  it('refuses any other reading.count path, as a field and as a bound label', () => {
    expect(validateCard(card({ data: { field: 'reading.count.returnD0Web' as ScopePath } })).join()).toMatch(/not a reading count a card may show/)
    expect(validateCard(card({ data: { field: 'reading.count.gameStart' as ScopePath } })).join()).toMatch(/not a reading count/)
    expect(validateCard(card({ label: { bind: 'reading.count.tour' as ScopePath } })).join()).toMatch(/not a reading count/)
  })
  it('limit: a whole number from 1 to the cap, readings only', () => {
    expect(validateCard(card({}, { over: 'readings', limit: 30 }))).toEqual([])
    expect(validateCard(card({}, { over: 'readings', limit: MAX_READINGS_LIMIT }))).toEqual([])
    for (const limit of [0, -1, 1.5, MAX_READINGS_LIMIT + 1, '5' as never]) expect(validateCard(card({}, { over: 'readings', limit })).join()).toMatch(/limit is for readings/)
    expect(validateCard({ v: 1, sections: [{ layout: 'rows', repeat: { over: 'popups', limit: 3 }, items: [{ id: 'p', label: 'p', data: { field: 'popup.id' }, display: { as: 'text' } }] }] }).join()).toMatch(/limit is for readings/)
  })
})
