import { describe, expect, it } from 'vitest'
import { METRIC_PATH_PREFIX, metricRefsIn, metricRequestSpec, metricTokenOptions, metricTokenValue, parseMetricPath } from './metricValueTokens'
import { METRICS } from './metrics/metrics'
import { resolveValueToken, parseValueToken } from './valueTokens'
import type { MetricValue } from './metrics/types'

const ok = (value: number): MetricValue => ({ status: 'ok', value }) as MetricValue

describe('parseMetricPath', () => {
  it('names a param-free catalog metric over one of its own windows, with the catalog kind', () => {
    expect(parseMetricPath('metric:bsk.pageviews@page')).toEqual({ path: 'metric:bsk.pageviews@page', of: 'metric', id: 'bsk.pageviews', window: 'page', kind: 'number' })
    expect(parseMetricPath('metric:bsk.pageviews@todaySoFar')?.window).toBe('todaySoFar')
    expect(parseMetricPath('metric:play.dataThrough@page')?.kind).toBe('date') // instant -> date
    expect(parseMetricPath('metric:bsk.popupTapRate@page')).toMatchObject({ of: 'ratio', kind: 'share' })
  })

  it('refuses a missing window, an unknown id or window, and a metric that needs a choice', () => {
    expect(parseMetricPath('metric:bsk.pageviews')).toBeNull() // the window is required
    expect(parseMetricPath('metric:bsk.pageviews@')).toBeNull()
    expect(parseMetricPath('metric:nope.nothing@page')).toBeNull()
    expect(parseMetricPath('metric:bsk.pageviews@lastWeek')).toBeNull()
    expect(parseMetricPath('metric:campaign.taggedArrivals@attribution')).toBeNull() // needs a campaign
    expect(parseMetricPath('chart.total')).toBeNull()
  })

  it('is case-sensitive: a window or id in the wrong case names nothing (the dash), never the right one', () => {
    expect(parseMetricPath('metric:bsk.pageviews@page')).not.toBeNull()
    for (const p of ['metric:bsk.pageviews@Page', 'metric:bsk.pageviews@PAGE', 'metric:bsk.pageviews@TODAYSOFAR', 'metric:bsk.pageviews@todaysofar', 'metric:bsk.popupTapRate@Page', 'metric:BSK.pageviews@page', 'metric:bsk.popuptaprate@page']) expect(parseMetricPath(p), p).toBeNull()
    expect(metricRefsIn(['{=metric:bsk.pageviews@Page|number}'])).toEqual([])
  })

  it('every offered window is one of the metric\'s own (the catalog is the authority)', () => {
    for (const o of metricTokenOptions()) {
      const def = METRICS.get(o.ref.id)
      if (def) expect(Object.keys(def.windows), o.ref.path).toContain(o.ref.window)
    }
  })
})

describe('metricRequestSpec', () => {
  it('sends only the metric or ratio and its window, never a param, delta or series', () => {
    expect(metricRequestSpec(parseMetricPath('metric:bsk.pageviews@page')!)).toEqual({ metric: 'bsk.pageviews', window: 'page' })
    expect(metricRequestSpec(parseMetricPath('metric:bsk.popupTapRate@page')!)).toEqual({ ratio: 'bsk.popupTapRate', window: 'page' })
  })
})

describe('metricTokenValue', () => {
  const num = parseMetricPath('metric:bsk.pageviews@page')!
  it('shows a measured, finite value', () => {
    expect(metricTokenValue(num, ok(1234))).toEqual({ kind: 'number', value: 1234 })
  })
  it('shows the placeholder for loading, errors and anything not measured', () => {
    expect(metricTokenValue(num, undefined).value).toBeNull()
    for (const status of ['pending', 'error', 'unmeasured', 'no-data', 'too-few', 'partial'] as const) expect(metricTokenValue(num, { status, value: 5 } as unknown as MetricValue).value, status).toBeNull()
    expect(metricTokenValue(num, ok(Number.NaN)).value).toBeNull()
  })
  it('shows an instant as its ET day', () => {
    const t = parseMetricPath('metric:play.dataThrough@page')!
    expect(metricTokenValue(t, ok(Date.parse('2026-09-30T16:00:00Z')))).toEqual({ kind: 'date', value: '2026-09-30' })
  })
})

describe('metricRefsIn', () => {
  it('finds every addressable metric token once, in first-seen order, and skips the rest', () => {
    const refs = metricRefsIn([
      'a {=metric:bsk.pageviews@page|number} b {=metric:bsk.pageviews@page|number} {=chart.total}',
      undefined,
      '{=metric:play.deviceInstalls@page|number} {=metric:nope@page} {=metric:bsk.pageviews}',
    ])
    expect(refs.map((r) => r.path)).toEqual(['metric:bsk.pageviews@page', 'metric:play.deviceInstalls@page'])
  })

  it('one path written with different formats (or none) is still ONE ref, so one request', () => {
    const refs = metricRefsIn(['{=metric:bsk.pageviews@page|number} then {=metric:bsk.pageviews@page} and {=metric:bsk.pageviews@page|pct}', '{=metric:bsk.pageviews@page|date}'])
    expect(refs.map((r) => r.path)).toEqual(['metric:bsk.pageviews@page'])
  })
})

describe('metricTokenOptions', () => {
  const options = metricTokenOptions()
  it('lists the Metrics group with a format that matches each kind', () => {
    expect(options.length).toBeGreaterThan(10)
    for (const o of options) {
      expect(o.group).toBe('Metrics')
      expect(o.token.startsWith(`{=${METRIC_PATH_PREFIX}`)).toBe(true)
      const t = parseValueToken(o.token)!
      expect(t.path, o.token).toBe(o.ref.path)
      const fmt = { number: 'number', share: 'pct', date: 'date', text: undefined }[o.ref.kind]
      expect(t.format, o.token).toBe(fmt)
    }
  })
  it('never offers a campaign, popup-choice, dollar or category metric', () => {
    const ids = options.map((o) => o.ref.id)
    expect(ids).toContain('bsk.pageviews')
    expect(ids.some((id) => id.startsWith('campaign.'))).toBe(false)
    expect(ids.some((id) => METRICS.get(id)?.unit === 'usd' || METRICS.get(id)?.unit === 'code')).toBe(false)
  })
  it('an option resolves to its placeholder with no value, and to a figure with one', () => {
    const o = options.find((x) => x.ref.path === 'metric:bsk.pageviews@page')!
    expect(resolveValueToken(o.token, { [o.ref.path]: { kind: 'number', value: null } })).toBeNull()
    expect(resolveValueToken(o.token, { [o.ref.path]: { kind: 'number', value: 1234 } })).toBe('1,234')
  })
})
