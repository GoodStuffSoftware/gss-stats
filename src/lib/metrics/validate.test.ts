// validateCard over every preset, and the POST /api/metrics whitelist (ADR 0003 section 3).
import { describe, expect, it } from 'vitest'
import { KEY_RE, MAX_REQUESTS, validateCard, validateMetricsRequest, type ValidatedBatch } from './validate'
import { PRESETS, presetById } from './presets'
import { getNote, hasNote, isNoteActive, noteRawText, noteTemplate, noteTokens } from '../notes'
import type { CardSpec, MetricItem } from './types'
import { MIN_COHORT } from '../popupEvents'

describe('validateCard', () => {
  it.each(Object.entries(PRESETS))('preset %s is valid', (_id, spec) => {
    expect(validateCard(spec)).toEqual([])
  })

  const card = (item: Partial<MetricItem>, repeat?: CardSpec['repeat']): CardSpec => ({
    v: 1,
    ...(repeat ? { repeat } : {}),
    sections: [{ layout: 'pills', items: [{ id: 'x', label: 'X', data: { metric: 'bsk.pageviews' }, display: { as: 'number' }, ...item } as MetricItem] }],
  })
  const CAMPAIGNS_REPEAT = { over: 'campaigns' } as const
  it.each([
    ['a percent on a pair (the 314.7% pill)', card({ data: { ratio: 'campaign.gameViewsVsArrivals' }, display: { as: 'percent' } }, CAMPAIGNS_REPEAT), /display 'percent' not allowed for a pair/],
    ['a percent on a count', card({ display: { as: 'percent' } }), /not allowed for a count/],
    ['a currency on a proportion', card({ data: { ratio: 'campaign.acceptPerAsk' }, display: { as: 'currency' } }, CAMPAIGNS_REPEAT), /not allowed for a proportion/],
    ['an unknown metric id', card({ data: { metric: 'campaign.nope' } }), /unknown data id/],
    ['an unknown ratio id', card({ data: { ratio: 'campaign.playedPerArrival' }, display: { as: 'percent' } }), /unknown data id/],
    ['a param the metric does not declare', card({ data: { metric: 'bsk.pageviews', params: { campaignId: '24215315197' } } }), /param 'campaignId' not accepted/],
    ['an unknown campaign id', card({ data: { metric: 'campaign.asks', params: { campaignId: '999' } } }), /unknown campaignId '999'/],
    ['a campaign metric with no campaign in scope', card({ data: { metric: 'campaign.asks' } }), /param 'campaignId' is neither set nor provided by a repeat/],
    ['a window the metric does not allow', card({ data: { metric: 'campaign.asks', window: 'todaySoFar' } }, CAMPAIGNS_REPEAT), /window 'todaySoFar' not allowed/],
    ['a window the registry does not serve yet', card({ data: { metric: 'bsk.pageviews', window: 'before' } }), /window "before" is not served/],
    ['deltas on a campaign-window count', card({ data: { metric: 'campaign.asks' }, display: { as: 'number', deltas: ['yesterday'] } }, CAMPAIGNS_REPEAT), /deltas need a count metric over 'todaySoFar'/],
    ['a minCohort under the floor', card({ data: { ratio: 'campaign.acceptPerAsk' }, display: { as: 'percent' }, gating: { minCohort: MIN_COHORT - 1 } }, CAMPAIGNS_REPEAT), /minCohort below MIN_COHORT/],
    ['an unknown note label', card({ label: { note: 'label.nope' } }), /unknown note id 'label.nope'/],
    ['an unknown whenEmpty note', card({ gating: { whenEmpty: { note: 'nope' } } }), /whenEmpty: unknown note id 'nope'/],
    ['{ metric: true } on a field', card({ label: { metric: true }, data: { field: 'campaign.flight' }, display: { as: 'dateRange' } }, CAMPAIGNS_REPEAT), /needs a metric or ratio binding/],
    ['a repeat over an unknown campaign', card({}, { over: 'campaigns', ids: ['123'] }), /unknown campaign '123'/],
  ] as const)('rejects %s', (_n, spec, err) => {
    expect(validateCard(spec).join('\n')).toMatch(err)
  })
  it('rejects a wrong version and an empty card', () => {
    expect(validateCard({ v: 2 } as unknown as CardSpec)).toEqual(['card: v must be 1'])
    expect(validateCard({ v: 1, sections: [] })).toContain('card: needs at least one section')
  })
})

const batch = (body: unknown): ValidatedBatch => validateMetricsRequest(JSON.stringify(body))
const one = (req: Record<string, unknown>, context?: unknown) => {
  const b = batch({ v: 1, ...(context ? { context } : {}), requests: [{ key: 'k', ...req }] })
  if (!b.ok) throw new Error('batch rejected: ' + b.error)
  return b.requests[0]
}

describe('validateMetricsRequest: batch-level rejections', () => {
  it.each([
    ['invalid JSON', '{', 400, 'invalid JSON body'],
    ['not an object', '[]', 400, 'body must be an object'],
    ['a wrong version', JSON.stringify({ v: 2, requests: [{ key: 'a', metric: 'bsk.pageviews' }] }), 400, 'v must be 1'],
    ['an unknown top-level field', JSON.stringify({ v: 1, sql: 'SELECT 1', requests: [] }), 400, 'sql is not accepted'],
    ['no requests', JSON.stringify({ v: 1, requests: [] }), 400, 'requests must be a non-empty array'],
    ['fresh that is not exactly true', JSON.stringify({ v: 1, fresh: 'yes', requests: [{ key: 'a', metric: 'bsk.pageviews' }] }), 400, 'fresh must be exactly true when set'],
    ['a key outside the key regex', JSON.stringify({ v: 1, requests: [{ key: 'A B', metric: 'bsk.pageviews' }] }), 400, 'every request needs a key matching ' + KEY_RE.source],
    ['a duplicate key', JSON.stringify({ v: 1, requests: [{ key: 'a', metric: 'bsk.pageviews' }, { key: 'a', metric: 'bsk.gameViews' }] }), 400, "duplicate key 'a'"],
    ['an unknown context field', JSON.stringify({ v: 1, context: { where: '1=1' }, requests: [{ key: 'a', metric: 'bsk.pageviews' }] }), 400, 'context.where is not accepted'],
    ['a malformed date', JSON.stringify({ v: 1, context: { since: '2026-09-01; DROP', until: '2026-09-02' }, requests: [{ key: 'a', metric: 'bsk.pageviews' }] }), 400, 'context.since must be YYYY-MM-DD or an ISO datetime'],
    ['since without until', JSON.stringify({ v: 1, context: { since: '2026-09-01' }, requests: [{ key: 'a', metric: 'bsk.pageviews' }] }), 400, 'context.since and context.until go together'],
    ['a malformed site (its own message, review #12)', JSON.stringify({ v: 1, context: { sites: ["x' OR '1"] }, requests: [{ key: 'a', metric: 'bsk.pageviews' }] }), 400, 'context.sites contains an invalid site tag'],
    ['too many sites', JSON.stringify({ v: 1, context: { sites: Array.from({ length: 51 }, (_, i) => `s${i}`) }, requests: [{ key: 'a', metric: 'bsk.pageviews' }] }), 400, 'context.sites must be a list of at most 50 site tags'],
    ['sites that are not a list', JSON.stringify({ v: 1, context: { sites: 'bestsudoku' }, requests: [{ key: 'a', metric: 'bsk.pageviews' }] }), 400, 'context.sites must be a list of at most 50 site tags'],
    ['a non-true boolean', JSON.stringify({ v: 1, context: { excludeOwnVisits: 1 }, requests: [{ key: 'a', metric: 'bsk.pageviews' }] }), 400, 'context.excludeOwnVisits must be exactly true when set'],
    ['a bad user agent', JSON.stringify({ v: 1, context: { ownBrowser: 'Chrome<script>' }, requests: [{ key: 'a', metric: 'bsk.pageviews' }] }), 400, 'context.ownBrowser is not a valid user-agent value'],
  ])('%s', (_n, text, status, error) => {
    expect(validateMetricsRequest(text)).toMatchObject({ ok: false, status, error })
  })
  it(`more than ${MAX_REQUESTS} requests is a 413 with maxRequests`, () => {
    const requests = Array.from({ length: MAX_REQUESTS + 1 }, (_, i) => ({ key: `k${i}`, metric: 'bsk.pageviews' }))
    expect(batch({ v: 1, requests })).toEqual({ ok: false, status: 413, error: 'too many requests', detail: { maxRequests: MAX_REQUESTS } })
    expect(batch({ v: 1, requests: requests.slice(0, MAX_REQUESTS) }).ok).toBe(true)
  })
})

describe('validateMetricsRequest: per-request rejections (the rest of the batch still answers)', () => {
  const C = '24215315197'
  it.each([
    ['an unknown metric id', { metric: 'campaign.nope' }, 'unknown-id'],
    ['an unknown ratio id', { ratio: 'campaign.playedPerArrival' }, 'unknown-id'],
    ['a metric id that is SQL', { metric: "x'; DROP TABLE hits;--" }, 'unknown-id'],
    ['a non-string id', { metric: 5 }, 'unknown-id'],
    ['both metric and ratio', { metric: 'bsk.pageviews', ratio: 'bsk.popupTapRate' }, 'bad-request'],
    ['neither metric nor ratio', {}, 'bad-request'],
    ['an unknown request field', { metric: 'bsk.pageviews', column: 'ts' }, 'bad-request'],
    ['a param the metric does not declare', { metric: 'bsk.pageviews', params: { campaignId: C } }, 'bad-param'],
    ['an unknown param name', { metric: 'campaign.asks', params: { campaignId: C, table: 'hits' } }, 'bad-param'],
    ['a campaignId outside CAMPAIGNS', { metric: 'campaign.asks', params: { campaignId: '1 OR 1=1' } }, 'bad-param'],
    ['a popup outside POPUPS', { metric: 'popup.shown', params: { popup: 'nope' } }, 'bad-param'],
    ['a missing required param', { metric: 'campaign.asks' }, 'missing-param'],
    ['a window the metric does not allow', { metric: 'campaign.asks', params: { campaignId: C }, window: 'todaySoFar' }, 'bad-window'],
    ['a page window without a range', { metric: 'bsk.pageviews', window: 'page' }, 'missing-range'],
    ['deltas outside the enum', { metric: 'bsk.pageviews', window: 'todaySoFar', deltas: ['lastYear'] }, 'bad-deltas'],
    ['deltas on a ratio', { ratio: 'bsk.popupTapRate', deltas: ['yesterday'] }, 'bad-deltas'],
    ['deltas on a campaign-window metric', { metric: 'campaign.asks', params: { campaignId: C }, deltas: ['avg7'] }, 'bad-deltas'],
    ['a minCohort on a count', { metric: 'bsk.pageviews', minCohort: 10 }, 'bad-param'],
    ['a non-integer minCohort', { ratio: 'campaign.acceptPerAsk', params: { campaignId: C }, minCohort: 5.5 }, 'bad-param'],
  ])('%s → %s', (_n, req, reason) => {
    expect(one(req)).toEqual({ key: 'k', ok: false, reason })
  })

  it('a valid request resolves its default window and clamps minCohort up to MIN_COHORT', () => {
    expect(one({ ratio: 'campaign.acceptPerAsk', params: { campaignId: C }, minCohort: 1 })).toEqual({
      key: 'k',
      ok: true,
      req: { key: 'k', kind: 'ratio', id: 'campaign.acceptPerAsk', params: { campaignId: C }, window: 'attribution', deltas: [], minCohort: MIN_COHORT },
    })
    expect(one({ ratio: 'campaign.acceptPerAsk', params: { campaignId: C }, minCohort: 20 })).toMatchObject({ ok: true, req: { minCohort: 20 } })
    expect(one({ metric: 'bsk.pageviews', deltas: ['avg7', 'yesterday', 'avg7'] })).toMatchObject({ ok: true, req: { window: 'todaySoFar', deltas: ['avg7', 'yesterday'] } })
    expect(one({ metric: 'popup.shown', params: { popup: 'install' } }, { since: '2026-09-20', until: '2026-09-26', sites: ['bestsudoku-web', 'bestsudoku'] })).toMatchObject({
      ok: true,
      req: { window: 'page', params: { popup: 'install' } },
    })
  })
  it('context sites are deduplicated and sorted (a stable fact key)', () => {
    const b = batch({ v: 1, context: { since: '2026-09-20', until: '2026-09-26', sites: ['b', 'a', 'b'] }, requests: [{ key: 'a', metric: 'bsk.pageviews' }] })
    expect(b.ok && b.context.sites).toEqual(['a', 'b'])
  })
})

describe('context dates are real and ordered (review #10)', () => {
  const ctx = (since: string, until: string) => validateMetricsRequest(JSON.stringify({ v: 1, context: { since, until }, requests: [{ key: 'a', metric: 'bsk.pageviews' }] }))
  it.each([
    ['an impossible month and day', '2026-99-99', '2026-10-01', 'context.since must be YYYY-MM-DD or an ISO datetime'],
    ['a day the month does not have (Date.parse rolls it over)', '2026-02-30', '2026-03-05', 'context.since must be YYYY-MM-DD or an ISO datetime'],
    ['an impossible clock time', '2026-09-26T25:61', '2026-09-27', 'context.since must be YYYY-MM-DD or an ISO datetime'],
    ['a 24:00 clock time', '2026-09-26T24:00', '2026-09-27', 'context.since must be YYYY-MM-DD or an ISO datetime'],
    ['an impossible until', '2026-09-20', '2026-09-26T23:60:00Z', 'context.until must be YYYY-MM-DD or an ISO datetime'],
    ['a reversed range', '2026-09-26', '2026-09-20', 'context.since must be before context.until'],
    ['an empty range', '2026-09-26T12:00:00Z', '2026-09-26T12:00:00Z', 'context.since must be before context.until'],
    ['1970 to 9999', '1970-01-01', '9999-12-31', 'context range is longer than 400 days'],
    ['401 days', '2025-09-01', '2026-10-06', 'context range is longer than 400 days'],
    ['401 calendar days spanning one extra fall-back', '2025-10-01', '2026-11-05', 'context range is longer than 400 days'],
    ['400 days and a minute of datetimes', '2025-10-01T04:00:00Z', '2026-11-05T04:01:00Z', 'context range is longer than 400 days'],
  ])('%s is a 400', (_n, since, until, error) => {
    expect(ctx(since, until)).toMatchObject({ ok: false, status: 400, error })
  })
  it.each([
    ['one ET day', '2026-09-26', '2026-09-26'],
    ['400 days exactly', '2025-08-22', '2026-09-25'],
    // Two fall-backs (2025-11-02, 2026-11-01) and one spring-forward: 400 days + 1 h in ms.
    ['400 calendar days spanning one extra fall-back', '2025-10-01', '2026-11-04'],
    ['datetimes, with and without a zone', '2026-09-20T00:00:00Z', '2026-09-26T12:30'],
    ['the leap day', '2028-02-29', '2028-03-01'],
  ])('%s is accepted', (_n, since, until) => {
    expect(ctx(since, until).ok).toBe(true)
  })
})

describe('note ids are own keys only (review #1)', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])('%s is not a note: validateCard refuses it, and the note helpers never throw', (id) => {
    const spec: CardSpec = { v: 1, captions: [id], sections: [{ layout: 'rows', items: [{ id: 'x', label: { note: id }, data: { metric: 'bsk.pageviews' }, display: { as: 'number' }, gating: { whenEmpty: { note: id } } }] }] }
    const errors = validateCard(spec).join('\n')
    expect(errors).toContain(`card.captions: unknown note id '${id}'`)
    expect(errors).toContain(`sections[0].x.label: unknown note id '${id}'`)
    expect(errors).toContain(`sections[0].x.gating.whenEmpty: unknown note id '${id}'`)
    expect(hasNote(id)).toBe(false)
    expect(getNote(id)).toBeUndefined()
    expect(noteRawText(id)).toBe('')
    expect(noteTokens(id)).toEqual([])
    expect(noteTemplate(id)).toBe('')
    expect(isNoteActive(id)).toBe(false)
  })
  it('a real note still resolves', () => {
    expect(hasNote('arrivals-caveat')).toBe(true)
    expect(noteRawText('label.bsk.gameViews')).toBe('Game-screen views')
  })
  it('a repeat over an unknown kind is refused, and a preset id is an own key only', () => {
    const spec = { v: 1, repeat: { over: 'constructor' }, sections: [{ layout: 'rows', items: [{ id: 'x', label: 'X', data: { metric: 'bsk.pageviews' }, display: { as: 'number' } }] }] } as unknown as CardSpec
    expect(validateCard(spec)).toContain("card.repeat: unknown repeat 'constructor'")
    expect(presetById('constructor')).toBeUndefined()
    expect(presetById('__proto__')).toBeUndefined()
    expect(presetById('bsk-kpis')).toBe(PRESETS['bsk-kpis'])
  })
})
