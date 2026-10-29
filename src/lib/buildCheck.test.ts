import { describe, expect, it } from 'vitest'
import { isNewerBuild, parseBuildId, reloadBannerWarning, RELOAD_DISCARD_TEXT } from './buildCheck'

describe('parseBuildId', () => {
  it('reads the id', () => expect(parseBuildId({ id: 'abc-1' })).toBe('abc-1'))
  it.each([null, undefined, 'x', 3, {}, { id: '' }, { id: 4 }])('rejects %j', (v) => expect(parseBuildId(v)).toBeNull())
})

describe('isNewerBuild', () => {
  it('is true when the live id differs', () => expect(isNewerBuild('a-1', 'b-2')).toBe(true))
  it('is false when the ids match', () => expect(isNewerBuild('a-1', 'a-1')).toBe(false))
  it('is false when the live id is unknown', () => expect(isNewerBuild('a-1', null)).toBe(false))
  it('is always false for a dev build', () => expect(isNewerBuild('dev', 'b-2')).toBe(false))
})

describe('reloadBannerWarning', () => {
  it('warns only with unsaved work', () => {
    expect(reloadBannerWarning(true)).toBe(RELOAD_DISCARD_TEXT)
    expect(reloadBannerWarning(false)).toBe('')
  })
})
