// MUST-1 (review of #63): MetricDef.countsRefused is the one source of the 'refused-whole-days'
// note. Every opt-out (countsRefused: false) is proved against the whole refused-path vocabulary,
// and every metric on the snapped page fact that can pass a refused row keeps the note. A new
// metric is fail-closed: it gets the note until it opts out, and a wrong opt-out fails here.
import { describe, expect, it } from 'vitest'
import { METRICS, metricWindows, type MetricCtx, type MetricDef } from './metrics'
import { CAMPAIGNS } from '../campaigns'
import { REFUSED_PATH_VOCABULARY } from '../__fixtures__/refusedPaths'

/** Every ctx a path test can be called with (each window, and each campaign for campaign metrics). */
function ctxs(def: MetricDef): MetricCtx[] {
  const out: MetricCtx[] = []
  for (const window of metricWindows(def)) {
    out.push({ params: {}, window })
    if (def.params.includes('campaignId')) for (const c of CAMPAIGNS) out.push({ params: { campaignId: c.id }, campaign: c, window })
  }
  return out
}
function passesARefusedRow(def: MetricDef): string | null {
  const test = def.path
  if (!test) return '(no path test: every row)'
  for (const ctx of ctxs(def)) for (const p of REFUSED_PATH_VOCABULARY) if (test(p, ctx)) return p
  return null
}

describe('MetricDef.countsRefused', () => {
  const all = [...METRICS.values()]
  it('every opt-out passes no refused path at all', () => {
    for (const d of all.filter((x) => x.countsRefused === false)) expect(passesARefusedRow(d), d.id).toBeNull()
  })
  it('every metric on the snapped page fact carries the note exactly when it can count a refused row', () => {
    const snapped = all.filter((d) => Object.values(d.windows).includes('bskRangePath'))
    expect(snapped.length).toBeGreaterThan(10)
    for (const d of snapped) expect(d.countsRefused !== false, `${d.id} (passes ${passesARefusedRow(d)})`).toBe(passesARefusedRow(d) !== null)
  })
  it('names the metrics that keep the note (the refused-whole-days set)', () => {
    const noted = all.filter((d) => Object.values(d.windows).includes('bskRangePath') && d.countsRefused !== false).map((d) => d.id)
    expect(noted.sort()).toEqual(['bsk.carryOverCompletions', 'bsk.completions', 'bsk.returnsD1plus', 'bsk.taggedArrivals', 'bsk.tourExitHub', 'bsk.tourExitPreamble', 'bsk.tourExitSection', 'bsk.tutorialFirstRun', 'bsk.tutorialReplay'])
  })
})
