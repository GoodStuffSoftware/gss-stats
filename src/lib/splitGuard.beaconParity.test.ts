// Parity pin: the beacon (gss-beacon) skips the live "changed" ping for every refused path, using its own
// copy of this list. Mirror: gss-beacon functions/_lib/refused.ts, pinned by gss-beacon
// test/refused.test.ts (the SAME literal). Change the list in both repos, or a test fails.
import { describe, expect, it } from 'vitest'
import { SPLIT_REFUSED_PATH_PATTERNS } from './splitGuard'

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
