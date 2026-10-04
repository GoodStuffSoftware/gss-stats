// Carry-over completions (retention spec S1): the preset is in the picker, the Retention template
// places it, and the notes read plainly. The row arithmetic and the SQL shape are pinned in
// functions/api/carryOver.test.ts.
import { describe, expect, it } from 'vitest'
import { presetOptions } from './editorModel'
import { presetById, PRESETS, CARRY_OVER_COMPLETIONS } from './presets'
import { validateCard } from './validate'
import { defaultRetentionWidgets } from '../defaults'
import { PAGE_TEMPLATES } from '../wizards'
import { getNote, noteRawText } from '../notes'
import { METRICS } from './metrics'

describe('carry-over completions: preset, picker and template', () => {
  it('is registered, valid and offered by the chart picker with a plain name and description', () => {
    expect(presetById('carry-over-completions')).toBe(CARRY_OVER_COMPLETIONS)
    expect(Object.keys(PRESETS)).toContain('carry-over-completions')
    expect(validateCard(CARRY_OVER_COMPLETIONS)).toEqual([])
    const opt = presetOptions().find((o) => o.value === 'carry-over-completions')
    expect(opt).toEqual({ value: 'carry-over-completions', label: 'Carry-over completions', description: expect.stringMatching(/weak signal/) })
  })

  it('reads the carry-over metric as a per-day sparkline beside the site-wide total, whole days only', () => {
    const items = CARRY_OVER_COMPLETIONS.sections.flatMap((s) => ('items' in s ? s.items : []))
    expect(items.map((i) => ('metric' in i.data ? i.data.metric : null))).toEqual(['bsk.completions', 'bsk.carryOverCompletions'])
    expect(items[1].display).toEqual({ as: 'sparkline', series: 'daily' })
    expect(METRICS.get('bsk.carryOverCompletions')).toMatchObject({ unit: 'completion', untagged: true, subsetOf: 'bsk.completions' })
  })

  it('says in one plain sentence that the spec rates it a weak signal', () => {
    const note = getNote('carry-over-weak-signal')!
    expect(note.text).toMatch(/weak signal/)
    expect(note.text.split('.').filter(Boolean)).toHaveLength(1)
    expect(CARRY_OVER_COMPLETIONS.captions).toContain('carry-over-weak-signal')
    expect(noteRawText('label.bsk.carryOverCompletions')).toBe('Carry-over completions')
  })

  it('is in the Retention page template, so "Restore default charts" (by templateId) includes it', () => {
    const tpl = PAGE_TEMPLATES.find((t) => t.id === 'tpl-bsk-retention')!
    const widgets = tpl.make().widgets
    const w = widgets.find((x) => x.card && 'preset' in x.card && x.card.preset === 'carry-over-completions')
    expect(w?.id).toBe('rt-carryover')
    expect(defaultRetentionWidgets().some((x) => x.id === 'rt-carryover')).toBe(true)
  })
})
