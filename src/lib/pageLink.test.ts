import { describe, expect, it } from 'vitest'
import { linkedPageId, searchWithPage } from './pageLink'
import { initialPageId } from './viewerPrefs'
import type { DashboardPage } from '../types'

const page = (id: string, isDefault = false) => ({ id, name: id, isDefault }) as unknown as DashboardPage
const pages = [page('default', true), page('bsk-features'), page('bsk-launch')]

describe('linkedPageId', () => {
  it('reads ?page=<id>', () => {
    expect(linkedPageId('?page=bsk-features')).toBe('bsk-features')
    expect(linkedPageId('?utm_source=x&page=bsk-features&y=1')).toBe('bsk-features')
  })
  it('no param, empty or oversize is nothing', () => {
    expect(linkedPageId('')).toBeUndefined()
    expect(linkedPageId('?page=')).toBeUndefined()
    expect(linkedPageId('?other=1')).toBeUndefined()
    expect(linkedPageId('?page=' + 'x'.repeat(201))).toBeUndefined()
  })
})

describe('initialPageId with a link', () => {
  it('?page= wins over the remembered page', () => {
    expect(initialPageId(pages, { active: 'bsk-launch' }, 'default', 'bsk-features')).toBe('bsk-features')
  })
  it('an unknown id falls back to the remembered page, then the landing page (the current behaviour)', () => {
    expect(initialPageId(pages, { active: 'bsk-launch' }, 'default', 'nope')).toBe('bsk-launch')
    expect(initialPageId(pages, {}, 'default', 'nope')).toBe('default')
    expect(initialPageId(pages, {}, 'default', undefined)).toBe('default')
  })
  it('a hostile id only ever selects among the known pages', () => {
    for (const bad of ['//evil.example', 'https://evil.example', 'javascript:alert(1)', '<script>', '__proto__', 'constructor']) {
      expect(initialPageId(pages, {}, 'default', bad), bad).toBe('default')
    }
  })
})

describe('searchWithPage', () => {
  it('sets the page param and keeps the other params', () => {
    expect(searchWithPage('', 'bsk-features')).toBe('?page=bsk-features')
    expect(searchWithPage('?page=old&utm_source=x', 'bsk-features')).toBe('?page=bsk-features&utm_source=x')
  })
  it('encodes the id', () => {
    expect(searchWithPage('', 'a b&c=d')).toBe('?page=a+b%26c%3Dd')
  })
  it('an empty id leaves the query alone', () => {
    expect(searchWithPage('?x=1', '')).toBe('?x=1')
    expect(searchWithPage('', '')).toBe('')
  })
})
