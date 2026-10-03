// Refused-path test vocabulary (lib/splitGuard.ts SPLIT_REFUSED_PATH_PATTERNS). Test-only: no
// production code reads it. The metrics engine's 'refused-whole-days' note is driven by the
// declarative MetricDef.countsRefused flag; metrics.refused.test.ts proves every opt-out against
// REFUSED_PATH_VOCABULARY, so a metric whose path test can pass ANY refused row a client sends
// (any return bucket or tag, any completion mode/difficulty, either tutorial run kind, any tour
// exit step) cannot opt out of the note unnoticed.
import { CAMPAIGNS, GAME_COMPLETE_DIFFICULTIES, GAME_COMPLETE_MODES, ORGANIC_ARM_ID, RETURN_BUCKETS } from '../campaigns'
import { TOUR_EXIT_STEPS } from '../popupEvents'
import { SPLIT_REFUSED_PATH_PATTERNS } from '../splitGuard'

/** One sample path per refused pattern (the SQLite fixture rows of splitGuard.window.test.ts). */
export const REFUSED_SAMPLE_PATHS: readonly string[] = [
  '/return/x/d0',
  '/game/complete/normal/easy',
  '/game/complete-deferred/normal/easy',
  '/game/tutorial-complete/first-run',
  '/game/start/easy',
  '/tour/exit-at/1',
]

/** Every segment value a refused beacon is known to carry, plus junk ('x', '1', ''). */
export const REFUSED_PATH_TOKENS: readonly string[] = [
  ...new Set([
    ...RETURN_BUCKETS,
    ...GAME_COMPLETE_MODES,
    ...GAME_COMPLETE_DIFFICULTIES,
    ...TOUR_EXIT_STEPS,
    'first-run',
    'replay',
    ORGANIC_ARM_ID,
    ...CAMPAIGNS.flatMap((c) => c.ucValues),
    'x',
    '1',
    '',
  ]),
]

/** Each refused pattern's prefix followed by zero, one and two vocabulary segments, in the
 * pattern's own case and upper-cased (SQLite LIKE folds ASCII case). Every entry is refused. */
export const REFUSED_PATH_VOCABULARY: readonly string[] = (() => {
  const out = new Set<string>()
  for (const pat of SPLIT_REFUSED_PATH_PATTERNS) {
    const base = pat.slice(0, -1)
    for (const prefix of [base, base.toUpperCase()]) {
      out.add(prefix)
      for (const a of REFUSED_PATH_TOKENS) {
        out.add(prefix + a)
        for (const b of REFUSED_PATH_TOKENS) out.add(`${prefix}${a}/${b}`)
      }
    }
  }
  return [...out]
})()
