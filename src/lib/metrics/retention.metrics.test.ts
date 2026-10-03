// R-2b step 1: the 'per' ratio kind (E1, completions per arrival) and the R2-7 metrics
// (d2-7 / d0 with its 90% Wilson bounds) through the real engine on synthetic facts.
import { describe, expect, it } from 'vitest'
import { deriveBatch, factCuts, newSideMemo, planBatch, type FactResult } from './engine'
import { FACTS, type FactId } from './facts'
import { METRICS } from './metrics'
import { RATIOS, ratioVerdict } from './ratios'
import { wilsonBounds } from './retention'
import { validateMetricsRequest } from './validate'
import { MIN_COHORT } from '../popupEvents'
import { campaignById, ORGANIC_ARM_ID } from '../campaigns'
import { NOTES_REGISTRY } from '../notes'
import type { MetricValue } from './types'

const RETEST = campaignById('24279250691')!
const UC = RETEST.ucValues[0]
const NOW = Date.parse('2026-10-10T16:00:00Z')
const TODAY = '2026-10-10'

type Raw = Record<string, unknown>
const ret = (bucket: string, c: number): Raw => ({ path: `/return/${UC}/${bucket}`, c })
const completed = (c: number): Raw => ({ path: '/game/complete/normal/easy', campaign: UC, visitor: 'returning', d: 0, c })

/** Derive requests against raw rows per fact id. Rows sit after every cut, so segments never exclude them. */
function derive(requests: Record<string, unknown>[], rawByFact: Partial<Record<FactId, Raw[]>>): Record<string, MetricValue> {
  const batch = validateMetricsRequest(JSON.stringify({ v: 1, requests }))
  if (!batch.ok) throw new Error(batch.error)
  expect(batch.requests.filter((r) => !r.ok)).toEqual([])
  const env = { context: batch.context, nowMs: NOW, todayEt: TODAY, hasAdsDb: false }
  const memo = newSideMemo()
  const plan = planBatch(batch.requests.flatMap((r) => (r.ok ? [r.req] : [])), env, memo)
  const facts = new Map<string, FactResult>()
  for (const f of plan.facts) {
    const raw = (rawByFact[f.id] ?? []).map((r) => ({ visitor: 'returning', campaign: '', d: 0, s: factCuts(f.id).length, ...r }))
    facts.set(f.key, { ok: true, rows: FACTS[f.id].parse(raw), asOfMs: NOW })
  }
  return deriveBatch(batch.requests, { ...env, facts }, memo)
}
const P = { campaignId: RETEST.id }
// Completions are counted only from GAME_COMPLETE_LIVE_AT, after this flight began: 'partial' is the
// engine's own "counted from" status, still a measured value.
const MEASURED = expect.stringMatching(/^(ok|partial)$/)
const per = (completions: number, d0: number) =>
  derive([{ key: 'e1', ratio: 'campaign.engagementPerArrival', params: P }], { campaignPathVisitor: [completed(completions)], campaignReturns: [ret('d0', d0)] }).e1

describe("the 'per' ratio kind: E1, completions per arrival", () => {
  it('is registered as a per over completions and first tagged loads, and passes the validity rule', () => {
    const r = RATIOS.get('campaign.engagementPerArrival')!
    expect(r).toMatchObject({ kind: 'per', num: 'campaign.completions', den: 'campaign.returnD0' })
    expect(ratioVerdict(r)).toMatchObject({ ok: true })
    // No subset needed (completions are not a subset of devices), still no time or category side.
    expect(ratioVerdict({ kind: 'per', num: 'campaign.completions', den: 'campaign.returnD0' }).ok).toBe(true)
    expect(ratioVerdict({ kind: 'per', num: 'campaign.spendSource', den: 'campaign.returnD0' }).ok).toBe(false)
    expect(ratioVerdict({ kind: 'per', num: 'campaign.completions', den: 'campaign.returnD2to7Rate' }).ok).toBe(false)
  })
  it('can exceed 1, and carries its counts', () => {
    const v = per(30, 20)
    expect(v).toMatchObject({ status: MEASURED, value: 1.5, numerator: 30, denominator: 20 })
  })
  it('is gated by MIN_COHORT on the denominator', () => {
    expect(per(30, MIN_COHORT - 1)).toMatchObject({ status: 'too-few', value: null, numerator: 30, denominator: MIN_COHORT - 1 })
    expect(per(30, MIN_COHORT)).toMatchObject({ status: MEASURED, value: 30 / MIN_COHORT })
  })
  it('is never organic (completions has no organic arm)', () => {
    const b = validateMetricsRequest(JSON.stringify({ v: 1, requests: [{ key: 'o', ratio: 'campaign.engagementPerArrival', params: { campaignId: ORGANIC_ARM_ID } }] }))
    expect(b.ok && b.requests[0]).toEqual({ key: 'o', ok: false, reason: 'bad-param' })
  })
  it('carries a label and a note saying what it is NOT', () => {
    expect(NOTES_REGISTRY['label.campaign.engagementPerArrival']?.kind).toBe('label')
    const note = NOTES_REGISTRY['engagement-per-arrival']
    expect(note?.kind).toBe('note')
    expect(String(note.text)).toMatch(/per arrival/)
    expect(String(note.text)).toMatch(/exceed 1/)
    expect(String(note.text)).toMatch(/repeat players/)
    expect(String(note.text)).toMatch(/not the share/)
  })
})

describe('R2-7: d2-7 / d0 with 90% Wilson bounds', () => {
  const ids = ['campaign.returnD2to7Rate', 'campaign.returnD2to7Lower', 'campaign.returnD2to7Upper']
  const run = (rows: Raw[]) => {
    const v = derive(ids.map((metric, i) => ({ key: `m${i}`, metric, params: P })), { campaignReturns: rows })
    return { rate: v.m0, lower: v.m1, upper: v.m2 }
  }
  it('the rate is d2-7 / d0 and the bounds are wilsonBounds at 90%', () => {
    const { rate, lower, upper } = run([ret('d0', 500), ret('d2-7', 40), ret('d1', 90), ret('d8-14', 12)])
    const w = wilsonBounds(40, 500)!
    expect(rate.value).toBeCloseTo(40 / 500, 12)
    expect(lower.value).toBeCloseTo(w.lower, 12)
    expect(upper.value).toBeCloseTo(w.upper, 12)
    for (const v of [rate, lower, upper]) expect(v).toMatchObject({ numerator: 40, denominator: 500 })
    expect(lower.value!).toBeLessThan(rate.value!)
    expect(upper.value!).toBeGreaterThan(rate.value!)
  })
  it('sums every row of the arm and ignores other arms', () => {
    const { rate } = run([ret('d0', 100), ret('d0', 100), ret('d2-7', 10), ret('d2-7', 6), { path: '/return/organic/d0', c: 900 }, { path: '/return/organic/d2-7', c: 900 }, { path: '/return/other_tag/d0', c: 900 }])
    expect(rate).toMatchObject({ value: 16 / 200, numerator: 16, denominator: 200 })
  })
  it('is too-few under MIN_COHORT d0 (a null value with its counts), and no-data with none', () => {
    const few = run([ret('d0', MIN_COHORT - 1), ret('d2-7', 1)])
    for (const v of Object.values(few)) expect(v).toMatchObject({ status: 'too-few', value: null, numerator: 1, denominator: MIN_COHORT - 1 })
    const none = run([])
    for (const v of Object.values(none)) expect(v).toMatchObject({ status: 'no-data', value: null })
    const edge = run([ret('d0', MIN_COHORT)])
    expect(edge.rate).toMatchObject({ status: 'ok', value: 0 })
    expect(edge.lower.value).toBe(0)
    expect(edge.upper.value!).toBeGreaterThan(0)
  })
  it('is a share, never a count: no ratio may use it', () => {
    for (const id of ids) expect(METRICS.get(id)!.unit).toBe('rate')
    expect(ratioVerdict({ kind: 'pair', num: ids[0], den: 'campaign.returnD0' }).ok).toBe(false)
  })
  it('keeps the default refused-row handling and serves the organic arm (its matured cohort)', () => {
    for (const id of ids) {
      const def = METRICS.get(id)!
      expect(def.countsRefused, id).toBeUndefined()
      expect(def.organic, id).toBe(true)
      expect(NOTES_REGISTRY[def.label]?.kind, id).toBe('label')
    }
  })
})
