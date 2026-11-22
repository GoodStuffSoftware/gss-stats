// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { loginKey } from '../loginStorage'
import { LAST_PAGE_PREFIX, readLastPage, writeLastPage } from './lastPage'

beforeEach(() => localStorage.clear())

describe('lastPage', () => {
  it('defaults to overview', () => {
    expect(readLastPage('a@example.test')).toBe('overview')
  })
  it('round-trips per login', () => {
    writeLastPage('a@example.test', 'loans')
    expect(readLastPage('A@example.test ')).toBe('loans')
    expect(readLastPage('b@example.test')).toBe('overview')
  })
  it('keeps nothing without a login', () => {
    writeLastPage(null, 'loans')
    expect(localStorage.length).toBe(0)
    expect(readLastPage('')).toBe('overview')
  })
  it('reads an unknown stored value as overview', () => {
    localStorage.setItem(loginKey(LAST_PAGE_PREFIX, 'a@example.test')!, 'bogus')
    expect(readLastPage('a@example.test')).toBe('overview')
  })
})
