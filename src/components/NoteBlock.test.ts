// @vitest-environment happy-dom
//
// NoteBlock: a multi-paragraph `text` (a chart caption, slice 1c) renders each blank-line
// paragraph as its own block line inside the same note; one paragraph renders inline as before.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import NoteBlock from './NoteBlock.vue'

describe('NoteBlock paragraphs', () => {
  it('splits blank-line paragraphs into separate lines of one note, markup intact', () => {
    const w = mount(NoteBlock, { props: { text: 'First **bold**.\n\nSecond line.' } })
    expect(w.findAll('p.note-block')).toHaveLength(1)
    const paras = w.findAll('.note-para')
    expect(paras.map((p) => p.text())).toEqual(['First bold.', 'Second line.'])
    expect(paras[0].find('strong').text()).toBe('bold')
  })

  it('one paragraph renders inline with no paragraph wrapper; whitespace-only renders nothing', () => {
    const w = mount(NoteBlock, { props: { text: 'Just one.' } })
    expect(w.find('.note-para').exists()).toBe(false)
    expect(w.get('p.note-block').text()).toBe('Just one.')
    expect(mount(NoteBlock, { props: { text: '  \n\n ' } }).find('p').exists()).toBe(false)
  })
})
