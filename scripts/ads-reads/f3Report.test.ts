// The flight 3 rules block in the morning report, on a made-up flight day 3 read of the Search
// arm (2026-10-19; day 1 = 2026-10-17). Synthetic fixture rows only: no network, no credentials.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fixtureDeps, type Fixture } from './cli'
import { runMorningRead, type MorningOptions } from './read'
import { formatMorningReport } from './report'
import { MIN_COHORT } from '../../src/lib/popupEvents'

const here = path.dirname(fileURLToPath(import.meta.url))
const F3_SEARCH = '24358792551'
const opts: MorningOptions = { campaignId: F3_SEARCH, releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24 }

/** Day 3 morning: closed days 10-17 ($8.00) and 10-18 ($9.50) = $17.50, 900 impressions, 20 clicks (CTR 2.22%), 14 tagged complete rows, 3 placement asks. */
const day3 = (): Fixture => ({
  now: '2026-10-19T12:05:00Z',
  ads: {
    status: { id: F3_SEARCH, name: 'fixture F3 Search', status: 'ENABLED', servingStatus: 'SERVING', primaryStatus: 'ELIGIBLE', dailyBudget: 10 },
    daily: {
      '2026-10-17': { costMicros: 8_000_000, impressions: 400, clicks: 9 },
      '2026-10-18': { costMicros: 9_500_000, impressions: 500, clicks: 11 },
      '2026-10-19': { costMicros: 0, impressions: 0, clicks: 0 },
    },
    placements: [],
  },
  beacon: {
    tagged: [
      { hour: '2026-10-17T17:00:00Z', path: '/', visitor: 'new', count: 9 },
      { hour: '2026-10-18T17:00:00Z', path: '/', visitor: 'new', count: 11 },
      { hour: '2026-10-17T18:00:00Z', path: '/game/complete/normal/easy', visitor: 'new', count: 6 },
      { hour: '2026-10-18T18:00:00Z', path: '/game/complete/normal/easy', visitor: 'new', count: 8 },
      { hour: '2026-10-18T19:00:00Z', path: '/signin-prompt/placement', visitor: 'new', count: 3 },
    ],
    siteEvents: [],
    returns: [],
    returnSites: [],
  },
  store: {},
})

const lines = async (fx: Fixture) => formatMorningReport(await runMorningRead(fixtureDeps(fx, true), opts)).split('\n')

describe('the flight 3 rules block (Search, flight day 3)', () => {
  it('prints the header, nine numbered rule lines and the proposal on a non-threshold read', async () => {
    const out = await lines(day3())
    const i = out.indexOf('F3 rules (proposals only; nothing is paused):')
    expect(i).toBeGreaterThan(-1)
    const block = out.slice(i, i + 11)
    expect(block).toEqual([
      'F3 rules (proposals only; nothing is paused):',
      'Rule 1 · placement leak: n/a (search campaign)',
      'Rule 2 · CTR: 2.22% (20 clicks / 900 impressions) | threshold at least 1.00% → PASS',
      'Rule 3 · funnel reach: armed at $35.00 | threshold at least 1 tagged sign-in ask → NOT YET',
      'Rule 4 · hard cap: $17.50 of $210.00 | threshold under $210.00 → PASS',
      'Rule 5 · tracking check: 14 complete rows, 3 sign-in ask rows | threshold 10+ complete rows need 1+ sign-in ask row → PASS',
      'Rule 6 · cost per complete row: $1.25 per complete row ($17.50 / 14 rows) | threshold at most $3.00 a complete row → PASS',
      'Rule 7 · first-move row ratio: n/a (Apps arm only)',
      'Rule 8 · traffic held: cost per complete row $1.25, CTR 2.22% (derived from rules 2 and 6) | threshold complete rows at most $3.00 each and CTR at least 1.00% → PASS',
      'Rule 9 · D+7 verdict: 0 new accounts (exact from tagged /auth/success/<provider>/new rows; Firestore new accounts not read), 3 ask rows; running, the table would say INCONCLUSIVE | threshold 5+ new accounts go, 2-4 iterate, 0-1 stop; under 20 asks inconclusive → NOT YET',
      'Proposal: CONTINUE',
    ])
  })
  it('rule 2 (CTR) is armed from day 3, rules 1 and 3 stay on the $35 spend arm, rule 9 waits for day 8', async () => {
    const out = await lines(day3())
    const rule = (n: number) => out.find((l) => l.startsWith(`Rule ${n} · `))!
    expect(rule(2)).toContain('threshold at least 1.00% → PASS')
    expect(rule(2)).toContain('2.22%')
    expect(rule(3)).toMatch(/→ NOT YET$/)
    expect(rule(8)).toMatch(/→ PASS$/)
    expect(rule(9)).toContain('running, the table would say INCONCLUSIVE')
    expect(rule(9)).toMatch(/→ NOT YET$/)
  })
  it('the block sits between the first-session lines and Thresholds', async () => {
    const out = await lines(day3())
    const at = (s: string) => out.findIndex((l) => l.startsWith(s))
    expect(at('First-session funnel')).toBeLessThan(at('F3 rules'))
    expect(at('F3 rules')).toBeLessThan(at('Thresholds:'))
  })
  it('the Tagged so far line adds cost per complete row, cumulative and yesterday', async () => {
    const out = await lines(day3())
    const tagged = out.find((l) => l.startsWith('Tagged so far'))!
    // cumulative $17.50 / 14 rows; yesterday (10-18) $9.50 / 8 rows
    expect(tagged).toContain('; cost per complete row, includes repeats $1.25 (yesterday $1.19)')
  })
  it('the first-finish WATCH line is n/a while no first-finish row exists', async () => {
    const out = await lines(day3())
    expect(out).toContain('WATCH · cost per person who finished: n/a until the app ships first-finish (0 first-finish rows so far)')
  })
  it('the first-finish WATCH line divides closed-day spend by first-finish rows of the same closed days (a today row is left out)', async () => {
    const fx = day3()
    ;(fx.beacon as { tagged: { hour: string; path: string; visitor: string; count: number }[] }).tagged.push(
      { hour: '2026-10-17T20:00:00Z', path: '/game/first-finish', visitor: 'returning', count: 3 },
      { hour: '2026-10-18T20:00:00Z', path: '/game/first-finish', visitor: 'returning', count: 1 },
      { hour: '2026-10-19T14:00:00Z', path: '/game/first-finish', visitor: 'returning', count: 4 }, // today: spend not closed yet
    )
    const out = await lines(fx)
    const line = out.find((l) => l.startsWith('WATCH · cost per person who finished'))!
    // closed-day spend $17.50 / 4 people = $4.38 ($2.19 if today's rows were wrongly included)
    expect(line).toContain('$4.38 ($17.50 closed-day spend / 4 people who finished')
    expect(out.find((l) => l.startsWith('Tagged so far'))).toContain('cost per complete row, includes repeats')
  })
  it('a tripped rule is listed in the proposal', async () => {
    const fx = day3()
    ;(fx.beacon as Extract<Fixture['beacon'], { tagged: unknown }>).tagged = (fx.beacon as Extract<Fixture['beacon'], { tagged: unknown }>).tagged.filter((r) => r.path !== '/signin-prompt/placement')
    const out = await lines(fx)
    expect(out.find((l) => l.startsWith('Rule 5 · '))).toMatch(/→ PROPOSE PAUSE$/)
    expect(out.find((l) => l.startsWith('Proposal: '))).toBe('Proposal: PROPOSE PAUSE (rule 5 tracking check)')
  })
  it('an ended campaign has nothing to pause', async () => {
    const fx = day3()
    ;(fx.ads as { status: { servingStatus: string } }).status.servingStatus = 'ENDED'
    ;(fx.beacon as Extract<Fixture['beacon'], { tagged: unknown }>).tagged = (fx.beacon as Extract<Fixture['beacon'], { tagged: unknown }>).tagged.filter((r) => r.path !== '/signin-prompt/placement')
    const out = await lines(fx)
    expect(out.find((l) => l.startsWith('Proposal: '))).toBe('Proposal: none: campaign ended, nothing to pause')
  })
})

describe('flight 2 and the retest report are unchanged', () => {
  it('the retest morning read has no F3 block and no cost-per-complete-row text', async () => {
    const fx: Fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8'))
    const text = formatMorningReport(await runMorningRead(fixtureDeps(fx, true), { ...opts, campaignId: '24279250691' }))
    expect(text).not.toContain('F3 rules')
    expect(text).not.toContain('cost per complete row')
    expect(text).not.toContain('Rule 1 · ')
    expect(text).not.toContain('Kill rules and Proposal: see the F3 rules block')
    expect(text).toContain('Kill rules (propose only; nothing is changed):')
  })
})
