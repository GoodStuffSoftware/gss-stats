import { describe, expect, it } from 'vitest'
import { dataThroughText, readingDataThrough } from './adsReadingsFormat'

describe('readingDataThrough: the last closed ET day a reading covers', () => {
  it('a daily read covers the day BEFORE its read date (the 10-29 read carries 10-28)', () => {
    expect(readingDataThrough({ kind: 'daily', etDate: '2026-10-29' })).toBe('2026-10-28')
    expect(readingDataThrough({ kind: 'daily', etDate: '2026-10-01' })).toBe('2026-09-30')
    expect(readingDataThrough({ kind: 'daily', etDate: '2027-01-01' })).toBe('2026-12-31')
  })

  it('threshold and health reads read closed days too: the day before', () => {
    expect(readingDataThrough({ kind: 'threshold', etDate: '2026-10-29' })).toBe('2026-10-28')
    expect(readingDataThrough({ kind: 'health', etDate: '2026-10-29' })).toBe('2026-10-28')
  })

  it('a post-flight read stops at the flight end, however late it is taken (also under --as-of)', () => {
    expect(readingDataThrough({ kind: 'postflight', etDate: '2026-11-04' }, '2026-10-28')).toBe('2026-10-28') // wrap-up, flight end + 7
    expect(readingDataThrough({ kind: 'postflight', etDate: '2026-11-12' }, '2026-10-28')).toBe('2026-10-28') // an --as-of backfill
    expect(readingDataThrough({ kind: 'postflight', etDate: '2026-12-01' }, '2026-10-28')).toBe('2026-10-28')
  })

  it('a post-flight read taken inside the flight (a forced read) is capped at the day before, not the flight end', () => {
    expect(readingDataThrough({ kind: 'postflight', etDate: '2026-10-20' }, '2026-10-28')).toBe('2026-10-19')
  })

  it('a post-flight read with no known flight end says nothing rather than guessing', () => {
    expect(readingDataThrough({ kind: 'postflight', etDate: '2026-11-04' })).toBeNull()
    expect(readingDataThrough({ kind: 'postflight', etDate: '2026-11-04' }, null)).toBeNull()
    expect(readingDataThrough({ kind: 'postflight', etDate: '2026-11-04' }, 'soon')).toBeNull()
  })

  it('counts calendar days across the 11-01 fall-back: 11-01 reads through 10-31, 11-02 through 11-01', () => {
    expect(readingDataThrough({ kind: 'daily', etDate: '2026-11-01' })).toBe('2026-10-31')
    expect(readingDataThrough({ kind: 'daily', etDate: '2026-11-02' })).toBe('2026-11-01')
    expect(readingDataThrough({ kind: 'postflight', etDate: '2026-11-02' }, '2026-11-01')).toBe('2026-11-01')
    expect(readingDataThrough({ kind: 'postflight', etDate: '2026-11-01' }, '2026-11-05')).toBe('2026-10-31')
  })

  it('also counts across the March spring-forward and a leap day', () => {
    expect(readingDataThrough({ kind: 'daily', etDate: '2026-03-09' })).toBe('2026-03-08')
    expect(readingDataThrough({ kind: 'daily', etDate: '2028-03-01' })).toBe('2028-02-29')
  })

  it('prefers a stored dataThrough, for any kind, and ignores one that is not a date', () => {
    expect(readingDataThrough({ kind: 'daily', etDate: '2026-10-29', dataThrough: '2026-10-27' })).toBe('2026-10-27')
    expect(readingDataThrough({ kind: 'postflight', etDate: '2026-11-04', dataThrough: '2026-10-28' })).toBe('2026-10-28')
    expect(readingDataThrough({ kind: 'daily', etDate: '2026-10-29', dataThrough: null })).toBe('2026-10-28')
    expect(readingDataThrough({ kind: 'daily', etDate: '2026-10-29', dataThrough: 'Oct 27' })).toBe('2026-10-28')
  })

  it('an etDate that is not a date gives null', () => {
    expect(readingDataThrough({ kind: 'daily', etDate: '' })).toBeNull()
    expect(readingDataThrough({ kind: 'daily', etDate: 'Oct 29' })).toBeNull()
  })
})

describe('dataThroughText', () => {
  it('is "Oct 28" for a date and null for none', () => {
    expect(dataThroughText('2026-10-28')).toBe('Oct 28')
    expect(dataThroughText(null)).toBeNull()
  })
})
