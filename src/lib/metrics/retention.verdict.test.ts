// R-2b step 2: the organic matured baseline (the ET-day maturity band `s` on the organic returns
// fact) and the per-arm verdict metric campaign.retentionVerdict, through the real engine on
// synthetic facts.
import { describe, expect, it } from 'vitest'
import { buildFact, deriveBatch, factKeyString, newSideMemo, planBatch, type FactResult } from './engine'
import { FACTS } from './facts'
import { armMaturity, METRICS, VERDICT_CODES } from './metrics'
import { retentionBar, wilsonBounds } from './retention'
import { validateMetricsRequest } from './validate'
import { etMidnightMs } from './instrumentation'
import { campaignById, ORGANIC_ARM_ID } from '../campaigns'
import { NOTES_REGISTRY } from '../notes'
import type { MetricValue } from './types'

// The retest flight: 2026-09-26 .. 2026-10-02, so its serving end is 2026-10-03 00:00 ET and its
// last arrival's d2-7 window closes 7 ET days later: matured from T = 2026-10-10.
const RETEST = campaignById('24279250691')!
const UC = RETEST.ucValues[0]
const MATURED_T = '2026-10-10'
const MATURING_T = '2026-10-05'

type Raw = Record<string, unknown>
const arm = (bucket: string, c: number): Raw => ({ path: `/return/${UC}/${bucket}`, c, s: 0 })
const org = (bucket: string, c: number, s: number): Raw => ({ path: `/return/${ORGANIC_ARM_ID}/${bucket}`, c, s })

interface Opts {
  todayEt?: string
  /** Leave the organic arm's fact out of the facts map (a failed or missing read). */
  dropOrganic?: boolean
}
/** Derive requests against raw campaignReturns rows (both arms' rows; each arm keeps its own). */
function derive(requests: Record<string, unknown>[], rows: Raw[], o: Opts = {}): Record<string, MetricValue> {
  const todayEt = o.todayEt ?? MATURED_T
  const nowMs = etMidnightMs(todayEt) + 16 * 3_600_000
  const batch = validateMetricsRequest(JSON.stringify({ v: 1, requests }))
  if (!batch.ok) throw new Error(batch.error)
  expect(batch.requests.filter((r) => !r.ok)).toEqual([])
  const env = { context: batch.context, nowMs, todayEt, hasAdsDb: false }
  const memo = newSideMemo()
  const plan = planBatch(batch.requests.flatMap((r) => (r.ok ? [r.req] : [])), env, memo)
  const facts = new Map<string, FactResult>()
  for (const f of plan.facts) {
    if (o.dropOrganic && f.params.campaignId === ORGANIC_ARM_ID) continue
    const raw = rows.map((r) => ({ visitor: 'returning', campaign: '', d: 0, ...r }))
    facts.set(f.key, { ok: true, rows: FACTS[f.id].parse(raw), asOfMs: nowMs })
  }
  return deriveBatch(batch.requests, { ...env, facts }, memo)
}
const P = { campaignId: RETEST.id }
const verdict = (rows: Raw[], o: Opts = {}) => derive([{ key: 'v', metric: 'campaign.retentionVerdict', params: P }], rows, o).v
const codeOf = (v: MetricValue) => (typeof v.value === 'number' ? VERDICT_CODES[v.value] : null)
const MEASURED = expect.stringMatching(/^(ok|partial)$/)

describe('campaign.retentionVerdict: every code through the registry', () => {
  // No organic rows: the bar is the fixed 7.5% (retentionBar under 1,000 matured organic d0).
  it('too-few under 200 arm d0', () => {
    const v = verdict([arm('d0', 199), arm('d2-7', 100)])
    expect(codeOf(v)).toBe('too-few')
    expect(v.noteIds).toContain('verdict.too-few')
  })
  it('maturing before the arm is matured, even when its upper bound is already under the bar', () => {
    const v = verdict([arm('d0', 600), arm('d2-7', 6)], { todayEt: MATURING_T })
    expect(codeOf(v)).toBe('maturing')
    expect(v.noteIds).toContain('verdict.maturing')
  })
  it('no-go when matured and the upper bound is under the bar', () => {
    // 10 / 600: Wilson 90% upper about 0.027 < 0.075.
    expect(wilsonBounds(10, 600)!.upper).toBeLessThan(0.075)
    const v = verdict([arm('d0', 600), arm('d2-7', 10)])
    expect(v).toMatchObject({ status: MEASURED, noteIds: expect.arrayContaining(['verdict.no-go']) })
    expect(codeOf(v)).toBe('no-go')
  })
  it('provisional when matured, between 200 and 500 d0, and not a no-go', () => {
    const v = verdict([arm('d0', 300), arm('d2-7', 30)])
    expect(codeOf(v)).toBe('provisional')
    expect(v.noteIds).toContain('verdict.provisional')
  })
  it('go when matured, at least 500 d0, and the lower bound clears the bar', () => {
    expect(wilsonBounds(150, 1000)!.lower).toBeGreaterThanOrEqual(0.075)
    const v = verdict([arm('d0', 1000), arm('d2-7', 150)])
    expect(codeOf(v)).toBe('go')
    expect(v.noteIds).toContain('verdict.go')
  })
  it('hold when matured, at least 500 d0, and the interval straddles the bar', () => {
    const b = wilsonBounds(75, 1000)!
    expect(b.lower).toBeLessThan(0.075)
    expect(b.upper).toBeGreaterThanOrEqual(0.075)
    const v = verdict([arm('d0', 1000), arm('d2-7', 75)])
    expect(codeOf(v)).toBe('hold')
    expect(v.noteIds).toContain('verdict.hold')
  })
  it('every code has a short label and none shows a clock time', () => {
    expect(METRICS.get('campaign.retentionVerdict')).toMatchObject({ unit: 'code', withOrganic: true })
    expect(METRICS.get('campaign.retentionVerdict')!.organic).toBeUndefined()
    expect(METRICS.get('campaign.retentionVerdict')!.countsRefused).toBeUndefined()
    expect(NOTES_REGISTRY['label.campaign.retentionVerdict']?.kind).toBe('label')
    for (const code of VERDICT_CODES) {
      const n = NOTES_REGISTRY[`verdict.${code}`]
      expect(n, code).toBeDefined()
      expect(String(n.text), code).not.toMatch(/\d{1,2}:\d{2}/)
    }
  })
  it('the organic arm has no verdict of its own', () => {
    const b = validateMetricsRequest(JSON.stringify({ v: 1, requests: [{ key: 'o', metric: 'campaign.retentionVerdict', params: { campaignId: ORGANIC_ARM_ID } }] }))
    expect(b.ok && b.requests[0]).toEqual({ key: 'o', ok: false, reason: 'bad-param' })
  })
})

describe('arm maturity: servingEnd + 7 ET days <= ET midnight of today', () => {
  it('counts whole ET days and flips on the maturity date', () => {
    // servingEnd = 2026-10-03 00:00 ET; + 7 ET days = 2026-10-10.
    expect(armMaturity(RETEST, '2026-10-05')).toEqual({ matured: false, daysToMature: 5 })
    expect(armMaturity(RETEST, '2026-10-09')).toEqual({ matured: false, daysToMature: 1 })
    expect(armMaturity(RETEST, '2026-10-10')).toEqual({ matured: true, daysToMature: 0 })
    expect(armMaturity(RETEST, '2026-11-03')).toEqual({ matured: true, daysToMature: 0 })
  })
  it('counts ET days across the DST change (serving end 2026-10-30, matures 2026-11-06)', () => {
    const c = { ...RETEST, flightEnd: '2026-10-29' }
    // 11-01 is the 25-hour day; the count is in ET dates, so 5 days at T = 11-01 and 2 at T = 11-04.
    expect(armMaturity(c, '2026-11-01')).toEqual({ matured: false, daysToMature: 5 })
    expect(armMaturity(c, '2026-11-04')).toEqual({ matured: false, daysToMature: 2 })
    expect(armMaturity(c, '2026-11-06')).toEqual({ matured: true, daysToMature: 0 })
  })
})

describe('the bar: fixed 7.5% under 1,000 MATURED organic d0, then 0.6x the organic R2-7', () => {
  // Arm: 1,000 d0, 150 d2-7 (15%, lower about 0.132, upper about 0.170).
  // Organic matured: 50% R2-7, so from 1,000 matured d0 the bar is 0.6 x 0.5 = 0.30 > the arm's upper.
  const armRows = [arm('d0', 1000), arm('d2-7', 150)]
  it('999 matured organic d0: fixed bar, GO', () => {
    expect(retentionBar({ organicD0: 999, organicReturns: 500 })).toEqual({ bar: 0.075, source: 'fixed' })
    expect(codeOf(verdict([...armRows, org('d0', 999, 0), org('d2-7', 500, 0)]))).toBe('go')
  })
  it('1,000 matured organic d0: the organic bar (0.30), NO-GO', () => {
    expect(retentionBar({ organicD0: 1000, organicReturns: 500 }).bar).toBeCloseTo(0.3, 12)
    expect(codeOf(verdict([...armRows, org('d0', 1000, 0), org('d2-7', 500, 0)]))).toBe('no-go')
  })
  it('only matured organic d0 (s = 0) counts toward the 1,000', () => {
    // 999 at s 0 + 400 at s 1 + 400 at s 2: matured d0 is 999 (exact), so the bar stays fixed.
    expect(codeOf(verdict([...armRows, org('d0', 999, 0), org('d0', 400, 1), org('d0', 400, 2), org('d2-7', 500, 0)]))).toBe('go')
  })
  it('organic d2-7 counts at s <= 1 and never at s = 2 (today)', () => {
    // Matured d0 = 1,000. d2-7: 100 (s 0) + 200 (s 1) = 300 counted; 1,000 at s 2 left out.
    // Bar = 0.6 x 300 / 1,000 = 0.18 > the arm's upper (about 0.170): NO-GO.
    expect(wilsonBounds(150, 1000)!.upper).toBeLessThan(0.18)
    const rows = [...armRows, org('d0', 1000, 0), org('d2-7', 100, 0), org('d2-7', 200, 1), org('d2-7', 1000, 2)]
    expect(codeOf(verdict(rows))).toBe('no-go')
    // Without the s = 1 rows: bar = 0.6 x 100 / 1,000 = 0.06 <= the arm's lower: GO.
    expect(codeOf(verdict([...armRows, org('d0', 1000, 0), org('d2-7', 100, 0), org('d2-7', 1000, 2)]))).toBe('go')
  })
  it('the arm itself counts every row, whatever its band', () => {
    // A campaign fact has no band (s defaults to 0 there), but a stray s never drops arm rows.
    const v = derive([{ key: 'r', metric: 'campaign.returnD2to7Rate', params: P }], [{ ...arm('d0', 600), s: 2 }, { ...arm('d2-7', 60), s: 2 }]).r
    expect(v).toMatchObject({ value: 0.1, numerator: 60, denominator: 600 })
  })
})

describe('organic R2-7 reads the matured cohort; the organic counts still sum every band', () => {
  const O = { campaignId: ORGANIC_ARM_ID }
  const rows = [org('d0', 300, 0), org('d0', 200, 1), org('d0', 50, 2), org('d2-7', 30, 0), org('d2-7', 10, 1), org('d2-7', 5, 2), org('d1', 7, 0), org('d1', 3, 2)]
  it('returnD0 .. d31-60 for the organic arm sum across every s (unchanged values)', () => {
    const v = derive(
      [
        { key: 'd0', metric: 'campaign.returnD0', params: O },
        { key: 'd1', metric: 'campaign.returnD1', params: O },
        { key: 'd27', metric: 'campaign.returnD2to7', params: O },
      ],
      rows,
    )
    expect(v.d0.value).toBe(550)
    expect(v.d1.value).toBe(10)
    expect(v.d27.value).toBe(45)
  })
  it('the organic R2-7 is matured d2-7 (s <= 1) over matured d0 (s = 0)', () => {
    // 40 / 300, the same quantity the verdict's bar reads.
    const v = derive([{ key: 'r', metric: 'campaign.returnD2to7Rate', params: O }], rows).r
    expect(v).toMatchObject({ numerator: 40, denominator: 300 })
    expect(v.value).toBeCloseTo(40 / 300, 12)
  })
})

describe('planning, keys and failure', () => {
  const plan = (metric: string, campaignId = RETEST.id, todayEt = MATURED_T) => {
    const batch = validateMetricsRequest(JSON.stringify({ v: 1, requests: [{ key: 'k', metric, params: { campaignId } }] }))
    if (!batch.ok) throw new Error(batch.error)
    const env = { context: batch.context, nowMs: etMidnightMs(todayEt) + 3_600_000, todayEt, hasAdsDb: false }
    return planBatch(batch.requests.flatMap((r) => (r.ok ? [r.req] : [])), env, newSideMemo())
  }
  it('the verdict plans the arm and the organic returns facts; only the organic one keys on todayEt', () => {
    const p = plan('campaign.retentionVerdict')
    expect(p.facts.map((f) => [f.id, f.params]).sort()).toEqual(
      [
        ['campaignReturns', { campaignId: RETEST.id }],
        ['campaignReturns', { campaignId: ORGANIC_ARM_ID, todayEt: MATURED_T }],
      ].sort(),
    )
  })
  it("a campaign's returns fact key and statement are unchanged (no todayEt)", () => {
    for (const metric of ['campaign.returnD0', 'campaign.returnD2to7Rate', 'campaign.retentionVerdict']) {
      for (const todayEt of ['2026-10-05', '2026-11-03']) {
        const f = plan(metric, RETEST.id, todayEt).facts.find((x) => x.params.campaignId === RETEST.id)!
        expect(f.key).toBe(JSON.stringify({ id: 'campaignReturns', params: { campaignId: RETEST.id } }))
        expect(f.key).toBe(factKeyString('campaignReturns', { campaignId: RETEST.id }))
        expect(f.params).toEqual({ campaignId: RETEST.id })
        const stmt = buildFact(f, 0)
        expect(stmt).toEqual(FACTS.campaignReturns.build({ campaignId: RETEST.id }, 0))
        expect(stmt.sql).toMatch(/^SELECT path, COUNT\(\*\) AS c FROM hits /)
        expect(stmt.sql).toMatch(/GROUP BY path$/)
      }
    }
  })
  it('the organic returns fact keys on todayEt (a new day is a new entry)', () => {
    const a = plan('campaign.returnD0', ORGANIC_ARM_ID, '2026-10-05').facts[0]
    const b = plan('campaign.returnD0', ORGANIC_ARM_ID, '2026-10-06').facts[0]
    expect(a.params).toEqual({ campaignId: ORGANIC_ARM_ID, todayEt: '2026-10-05' })
    expect(a.key).not.toBe(b.key)
  })
  it('a missing organic fact makes the verdict an error, never a fixed-bar guess', () => {
    const v = verdict([arm('d0', 1000), arm('d2-7', 150)], { dropOrganic: true })
    expect(v.status).toBe('error')
    expect(v.value ?? null).toBeNull()
    expect(v.noteIds ?? []).not.toContain('verdict.go')
    // The arm's own R2-7 does not need it.
    const r = derive([{ key: 'r', metric: 'campaign.returnD2to7Rate', params: P }], [arm('d0', 1000), arm('d2-7', 150)], { dropOrganic: true }).r
    expect(r.value).toBeCloseTo(0.15, 12)
  })
})
