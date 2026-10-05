// Parity pin: the beacon (gss-beacon) skips the live "changed" ping for every refused path, using its own
// copy of this list. Mirror: gss-beacon functions/_lib/refused.ts, pinned by gss-beacon
// test/refused.test.ts (the SAME literal). Change the list in both repos, or a test fails.
import { describe, expect, it } from 'vitest'
import { isSplitRefusedPath, SPLIT_REFUSED_PATH_PATTERNS } from './splitGuard'

describe('SPLIT_REFUSED_PATH_PATTERNS beacon parity', () => {
  it('equals the literal list the beacon pins', () => {
    expect([...SPLIT_REFUSED_PATH_PATTERNS]).toEqual([
      '/return/%',
      '/game/complete/%',
      '/game/complete-deferred/%',
      '/game/tutorial-complete/%',
      '/game/start/%',
      '/tour/exit-at/%',
      '/tour/exit-at',
      '/tour/skip',
      '/tour/skip/%',
    ])
  })
})

// The matcher, pinned with the same cases as gss-beacon test/refused.test.ts @0f0046e (isSplitRefusedPath),
// so one file here states the whole contract. The beacon also judges refusal on the stored 200-char clip of
// the path (b.ts); a prefix pattern is length-independent, so the clip cases are pinned here too.
describe('isSplitRefusedPath beacon parity (matcher)', () => {
  it('prefix patterns need the full segment, exact patterns match exactly, ASCII case-folded', () => {
    for (const p of [
      '/return/x/d0',
      '/RETURN/x',
      '/Game/Complete/1',
      '/game/complete-deferred/a',
      '/game/tutorial-complete/first-run',
      '/game/start/x',
      '/tour/exit-at',
      '/Tour/Exit-At/3',
      '/tour/skip',
      '/TOUR/SKIP',
      '/tour/skip/x',
    ]) {
      expect(isSplitRefusedPath(p), p).toBe(true)
    }
    for (const p of [
      '/',
      '/game',
      '/game/first-move',
      '/tour/start',
      '/tour/complete',
      '/tour/skipped',
      '/tour/exit-atx',
      '/returns',
      '/return',
      '/game/completed',
      '/x/return/y',
      '',
    ]) {
      expect(isSplitRefusedPath(p), p).toBe(false)
    }
  })

  it('fails closed on NUL: any path containing one is refused', () => {
    for (const p of [
      '/tour/skip\u0000x',
      '/tour/exit-at\u0000/1',
      '/tour/skip\u0000',
      '/return/\u0000x',
      '/game/start/x\u0000',
      '/play\u0000',
      '\u0000/play',
    ]) {
      expect(isSplitRefusedPath(p), JSON.stringify(p)).toBe(true)
    }
    expect(isSplitRefusedPath('/')).toBe(false)
  })

  it('judges the stored 200-char clip the same as the full path', () => {
    const clip = (v: string) => v.slice(0, 200)
    // A refused path far longer than 200 chars is refused before and after the clip.
    for (const p of [`/return/${'a'.repeat(400)}`, `/RETURN/${'a'.repeat(400)}`, `/tour/skip/${'z'.repeat(400)}`]) {
      expect(isSplitRefusedPath(p), p.slice(0, 30)).toBe(true)
      expect(isSplitRefusedPath(clip(p)), clip(p).slice(0, 30)).toBe(true)
    }
    // An exact pattern with a long tail is not the exact path, clipped or not.
    for (const p of [`/tour/skip${'x'.repeat(300)}`, `/tour/exit-at${'x'.repeat(300)}`]) {
      expect(isSplitRefusedPath(p)).toBe(false)
      expect(isSplitRefusedPath(clip(p))).toBe(false)
    }
    // A clip that ends exactly on the pattern keeps matching: 200 chars of padding then the refused
    // text is a plain page path, but the same text clipped to a refused head stays refused.
    const head = '/game/start/'
    expect(isSplitRefusedPath(clip(head + 'q'.repeat(300)))).toBe(true)
    expect(isSplitRefusedPath(clip('/' + 'q'.repeat(199) + head))).toBe(false)
    // A NUL past the clip is cut off with it: the clipped stored path is what is judged.
    expect(isSplitRefusedPath(clip('/' + 'q'.repeat(250) + '\u0000'))).toBe(false)
    expect(isSplitRefusedPath(clip('/' + 'q'.repeat(150) + '\u0000'))).toBe(true)
  })
})
