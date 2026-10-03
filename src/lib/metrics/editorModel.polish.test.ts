// Pure-function tests for the card-editor polish helpers (see CardEditor.polish.test.ts for the
// mounted behaviour): the one decimals range, the badge-colour
// row check and the spec comparison behind "Use a preset instead".
import { describe, expect, it } from 'vitest'
import { validateCard } from './validate'
import { cloneSpec, firstDisplayFor, makeDisplay, specFromPresetId, specsEqual, toneValueProblem } from './editorModel'
import type { CardSpec } from './types'

describe('the sparkline option (availability itself is pinned in editorModel.test.ts)', () => {
  it('firstDisplayFor still never picks the sparkline', () => {
    expect(firstDisplayFor({ metric: 'campaign.taggedArrivals' })).not.toBe('sparkline')
  })
})

describe('percent decimals 0 to 4 are one range (type, validator, editor)', () => {
  it('validateCard accepts each of 0-4 and rejects 5', () => {
    const card = (decimals: number) => ({ v: 1, repeat: { over: 'campaigns' }, sections: [{ layout: 'rows', items: [{ id: 'a', label: 'A', data: { ratio: 'campaign.acceptPerAsk' }, display: { as: 'percent', decimals } }] }] }) as unknown as CardSpec
    for (const d of [0, 1, 2, 3, 4]) expect(validateCard(card(d))).toEqual([])
    expect(validateCard(card(5)).join('\n')).toMatch(/decimals must be an integer from 0 to 4/)
  })
  it('makeDisplay keeps a stored 3 or 4 through a percent -> percent pick', () => {
    expect(makeDisplay('percent', { as: 'percent', decimals: 3 })).toEqual({ as: 'percent', decimals: 3 })
    expect(makeDisplay('percent', { as: 'percent', decimals: 4 })).toEqual({ as: 'percent', decimals: 4 })
  })
})

describe('toneValueProblem', () => {
  const rows = [
    { value: 'live', tone: 'live' as const },
    { value: 'paused', tone: 'warn' as const },
  ]
  it('flags an empty or blank text and a text another row already has', () => {
    expect(toneValueProblem(rows, 1, '')).toMatch(/empty/)
    expect(toneValueProblem(rows, 1, '   ')).toMatch(/empty/)
    expect(toneValueProblem(rows, 1, 'live')).toMatch(/already has a colour/)
  })
  it('accepts a new text, and a row keeping its own text', () => {
    expect(toneValueProblem(rows, 1, 'closed')).toBeNull()
    expect(toneValueProblem(rows, 1, 'paused')).toBeNull()
  })
})

describe('specsEqual', () => {
  it('ignores key order and undefined fields, and sees real differences', () => {
    const a = specFromPresetId('campaign-returns')
    const reordered = { sections: a.sections, repeat: { organic: a.repeat!.organic, empty: a.repeat!.empty, tracked: a.repeat!.tracked, over: a.repeat!.over }, title: a.title, minWidth: a.minWidth, v: a.v } as CardSpec
    expect(specsEqual(a, reordered)).toBe(true)
    expect(specsEqual(a, { ...a, link: undefined })).toBe(true)
    const c = cloneSpec(a)
    c.repeat = { ...c.repeat!, organic: undefined }
    expect(specsEqual(a, c)).toBe(false)
    const d = cloneSpec(a)
    d.sections[0].items[0].id = 'other'
    expect(specsEqual(a, d)).toBe(false)
  })
})
