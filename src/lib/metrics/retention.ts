/**
 * Retention verdict statistics (R-2): a Wilson score interval, the GO/NO-GO bar,
 * and the per-arm verdict rule from the retention spec section 4. Pure
 * functions, no engine or registry imports.
 *
 * Read these three statements before using any number from this module:
 *
 *  1. Organic d0 and campaign d0 are DISJOINT populations. Organic is a
 *     first-ever web visit with no utm; the first touch wins, so a device first
 *     touched by a campaign never counts as organic (and vice versa).
 *  2. The 0.6x bar COMPARES the groups. It does not net organic out of a
 *     campaign arm: it only asks whether an arm retains at least a set share of
 *     what the organic population does.
 *  3. The rates are a LOWER BOUND on person-level retention. d0 counts browser
 *     storage, not people (cleared storage, private windows, a second browser
 *     and a move from web to the app all inflate d0 or lose returns), and the
 *     error bars do not include that bias.
 */

/** z for a two-sided 90% interval. */
export const Z_90 = 1.6448536

/** Bar used until the organic baseline is large enough to trust (7.5%). */
export const BAR_FIXED = 0.075
/** Organic d0 (matured cohort) at which the bar switches to the organic one. */
export const ORGANIC_MIN_D0 = 1000
/** Matured organic ET days (tracking start through T-7) needed before the organic bar is used. The
 * organic days 2-7 count is cut at ET midnights, so it also includes already-fired returns from
 * recent arrivals that are not yet in the matured arrival count (about 2.5 to 3.5 arrival-days'
 * worth). The organic rate and the bar read from it therefore run HIGH by about
 * (2.5 to 3.5 days) / (matured organic days); 21 days keeps that near 12 to 17%. */
export const ORGANIC_MIN_DAYS = 21
/** The organic bar is this fraction of the organic R2-7 point estimate. */
export const ORGANIC_BAR_FACTOR = 0.6
/** Below this d0 an arm gets no verdict at all. */
export const TOO_FEW = 200
/** At or above this d0 (and matured) an arm can get a full GO / HOLD / NO-GO. */
export const FULL = 500

export interface WilsonBounds {
  lower: number
  upper: number
}

/**
 * Wilson score interval for `successes` out of `n`, at z (default: 90%).
 * Null when n <= 0. Unlike Wald it is correct at 0/n and n/n, where it gives a
 * non-degenerate bound on the far side. Result is clamped to [0, 1].
 */
export function wilsonBounds(successes: number, n: number, z: number = Z_90): WilsonBounds | null {
  if (!(n > 0)) return null
  const x = Math.min(Math.max(successes, 0), n)
  const p = x / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return {
    lower: Math.min(1, Math.max(0, centre - half)),
    upper: Math.min(1, Math.max(0, centre + half)),
  }
}

/** Why the fixed bar was used (null when the organic bar is): shown beside the verdict. */
export type FixedBarReason = 'arrivals' | 'days' | 'no-returns'

export interface RetentionBar {
  bar: number
  source: 'fixed' | 'organic'
  /** Set only when source is 'fixed': the first guard that failed. */
  reason: FixedBarReason | null
}

/**
 * The bar an arm's R2-7 is judged against. The fixed 7.5% bar, unless ALL of these hold, and then
 * 0.6 x the organic R2-7:
 *  - at least ORGANIC_MIN_D0 matured organic arrivals;
 *  - at least ORGANIC_MIN_DAYS matured organic ET days (the organic days 2-7 count also includes
 *    already-fired returns from recent arrivals not yet in the matured arrival count, which
 *    raises the organic rate: see ORGANIC_MIN_DAYS);
 *  - organic d2-7 returns above zero. Zero returns would make the bar 0, and every arm would then
 *    clear it: a broken or not-yet-firing organic beacon must fall back to the fixed bar, never
 *    to a free GO.
 *
 * The organic point estimate is taken as FIXED: its own sampling error (about
 * +-1 point on the bar at d0 = 1,000) is deliberately not propagated into the
 * verdict (spec review #6, "say the bar is treated as fixed").
 */
export function retentionBar(input: { organicD0: number; organicReturns: number; organicDays: number }): RetentionBar {
  const { organicD0, organicReturns, organicDays } = input
  if (!(organicD0 >= ORGANIC_MIN_D0)) return { bar: BAR_FIXED, source: 'fixed', reason: 'arrivals' }
  if (!(organicDays >= ORGANIC_MIN_DAYS)) return { bar: BAR_FIXED, source: 'fixed', reason: 'days' }
  if (!(organicReturns > 0)) return { bar: BAR_FIXED, source: 'fixed', reason: 'no-returns' }
  return { bar: (ORGANIC_BAR_FACTOR * organicReturns) / organicD0, source: 'organic', reason: null }
}

export type VerdictCode = 'too-few' | 'provisional' | 'maturing' | 'go' | 'hold' | 'no-go'

export interface RetentionVerdict {
  code: VerdictCode
  /** Days left until the arm is matured; set only when code is 'maturing'. */
  daysToMature: number | null
  /** R2-7 = returns27 / d0; null when d0 <= 0. */
  rate: number | null
  /** 90% Wilson bounds on the rate; null when d0 <= 0. */
  lower: number | null
  upper: number | null
}

/**
 * Verdict for one arm (spec section 4), on R2-7 = returns27 / d0.
 *
 *  - d0 < TOO_FEW                     -> too-few
 *  - not matured                      -> maturing (daysToMature passed through)
 *  - TOO_FEW <= d0 < FULL, matured    -> no-go if upper < bar, else provisional
 *  - d0 >= FULL, matured              -> go if lower >= bar, no-go if upper < bar, else hold
 *
 * Early NO-GO is NOT applied while maturing. Returns can only grow as the
 * window fills, so the observed rate is a downward-biased snapshot: "upper <
 * bar" now says nothing certain about the final rate, and the verdict could
 * reverse once the window closes. The conservative choice is to wait. The
 * spec's provisional early NO-GO is therefore read as applying to a matured arm
 * that stopped short of FULL.
 */
export function retentionVerdict(input: {
  d0: number
  returns27: number
  matured: boolean
  daysToMature: number
  bar: number
}): RetentionVerdict {
  const { d0, returns27, matured, daysToMature, bar } = input
  const b = wilsonBounds(returns27, d0)
  const out = (code: VerdictCode, days: number | null = null): RetentionVerdict => ({
    code,
    daysToMature: days,
    rate: d0 > 0 ? Math.min(Math.max(returns27, 0), d0) / d0 : null,
    lower: b ? b.lower : null,
    upper: b ? b.upper : null,
  })

  if (!b || d0 < TOO_FEW) return out('too-few')
  if (!matured) return out('maturing', daysToMature)
  if (b.upper < bar) return out('no-go')
  if (d0 < FULL) return out('provisional')
  return b.lower >= bar ? out('go') : out('hold')
}
