// @vitest-environment happy-dom
//
// NoteWidgetBody compact rendering (fix/clean-look, 2026-09-26): a note widget must render as
// a single caption line via NoteBlock — no separate title, no extra chrome of its own (the
// enclosing ChartCard.vue supplies the .note-card styling that removes the card's border/
// background — see ChartCard.test.ts). This just confirms the body itself stays a plain
// NoteBlock render with the registry text, for both a registry noteId and free custom text.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import NoteWidgetBody from './NoteWidgetBody.vue'
import type { Widget } from '../../types'

function noteWidget(overrides: Partial<Widget> = {}): Widget {
  return {
    id: 'n1',
    i: 'n1',
    title: 'Small sample',
    type: 'note',
    dimension: '',
    metric: 'pageviews',
    limit: 1,
    x: 0,
    y: 0,
    w: 12,
    h: 3,
    ...overrides,
  }
}

describe('NoteWidgetBody', () => {
  it('renders the registry note text (small-sample) as a single caption paragraph, no heading', () => {
    const w = mount(NoteWidgetBody, { props: { widget: noteWidget({ noteId: 'small-sample' }) } })
    const p = w.get('.note-block')
    expect(p.text().length).toBeGreaterThan(0)
    expect(w.find('h1,h2,h3').exists()).toBe(false)
  })

  it('renders free custom text when no noteId is set', () => {
    const w = mount(NoteWidgetBody, { props: { widget: noteWidget({ noteId: undefined, note: 'A custom caption.' }) } })
    expect(w.get('.note-block').text()).toBe('A custom caption.')
  })

  it('falls back to a placeholder for a genuinely empty custom note (never a blank tile)', () => {
    const w = mount(NoteWidgetBody, { props: { widget: noteWidget({ noteId: undefined, note: '' }) } })
    expect(w.get('.note-block').text()).toBe('(empty note)')
  })
})
