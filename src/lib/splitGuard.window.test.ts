// R-1d: the whole-ET-day window for refused rows (src/lib/splitGuard.ts refusedRowWindow /
// refusedWindowClause), all three snap modes, DST days, the exact-tie rule, the unchanged path for
// ET-midnight bounds, and the empty window. The handlers that use it are probed end to end in
// functions/api/refusedWindow.test.ts.
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  isEtMidnight,
  isSplitRefusedPath,
  isWholeEtDays,
  REFUSED_WINDOW_KEY,
  REFUSED_WINDOW_SNAP,
  refusedPathMatch,
  refusedRowWindow,
  refusedWindowClause,
  refusedWindowMoved,
  SPLIT_REFUSED_PATH_PATTERNS,
  type RefusedSnap,
} from './splitGuard'
import { addDays, etDateFast, etWallTimeMs } from './etTime'
import { REFUSED_PATH_VOCABULARY, REFUSED_SAMPLE_PATHS } from './__fixtures__/refusedPaths'

const MODES: RefusedSnap[] = ['nearest', 'outward', 'inward']
const Z = (iso: string) => Date.parse(iso)
const H = 3_600_000
const mid = (dateEt: string) => etWallTimeMs(dateEt, '00:00')

describe('the switch', () => {
  it("ships 'nearest' (Mike's ruling), and the cache-key marker names the mode", () => {
    expect(REFUSED_WINDOW_SNAP).toBe('nearest')
    expect(REFUSED_WINDOW_KEY).toMatch(new RegExp(`^refused-${REFUSED_WINDOW_SNAP}-et-days-[0-9a-z]+$`))
    // not the pre-list-hash marker, so an answer cached before the pattern list was folded in is never served
    expect(REFUSED_WINDOW_KEY).not.toBe(`refused-${REFUSED_WINDOW_SNAP}-et-days-v1`)
  })
  it('refuses a tour exit with no stage as well as a staged one', () => {
    for (const p of ['/tour/exit-at', '/tour/exit-at/hub', '/TOUR/EXIT-AT']) expect(isSplitRefusedPath(p), p).toBe(true)
    for (const p of ['/tour/exit-atx', '/tour/exit', '/tour/start']) expect(isSplitRefusedPath(p), p).toBe(false)
  })
  it('refuses any path containing a NUL, as SQLite LIKE (NUL-terminated) does', () => {
    for (const p of ['/tour/skip\u0000x', '/tour/exit-at\u0000/1', '/TOUR/SKIP\u0000', '/return/x\u0000', '\u0000', '/ordinary\u0000', '/a/\u0000/b']) expect(isSplitRefusedPath(p), JSON.stringify(p)).toBe(true)
    // no NUL: unchanged
    for (const p of ['/tour/start', '/tour/skipx', '/ordinary', '']) expect(isSplitRefusedPath(p), p).toBe(false)
  })
  it('has one refused sample path per refused pattern', () => {
    expect(REFUSED_SAMPLE_PATHS).toHaveLength(SPLIT_REFUSED_PATH_PATTERNS.length)
    for (const p of REFUSED_SAMPLE_PATHS) expect(isSplitRefusedPath(p), p).toBe(true)
    for (const pat of SPLIT_REFUSED_PATH_PATTERNS) {
      const hits = (q: string, p: string) => (q.endsWith('%') ? p.startsWith(q.slice(0, -1)) : p === q)
      const own = REFUSED_SAMPLE_PATHS.filter((p) => hits(pat, p) && !SPLIT_REFUSED_PATH_PATTERNS.some((o) => o !== pat && o.length > pat.length && hits(o, p)))
      expect(own, pat).toHaveLength(1)
    }
  })
  it('has a refused-path vocabulary that covers every pattern and holds only refused paths', () => {
    for (const p of REFUSED_PATH_VOCABULARY) expect(isSplitRefusedPath(p), p).toBe(true)
    for (const pat of SPLIT_REFUSED_PATH_PATTERNS) {
      const prefix = pat.endsWith('%') ? pat.slice(0, -1) : pat
      expect(REFUSED_PATH_VOCABULARY.filter((p) => p.startsWith(prefix)).length, pat).toBeGreaterThan(pat.endsWith('%') ? 100 : 0)
    }
  })
})

describe('ET midnights', () => {
  it('finds them on 24 h, 23 h (2026-03-08) and 25 h (2026-11-01) days', () => {
    expect(mid('2026-10-01')).toBe(Z('2026-10-01T04:00:00Z'))
    expect(mid('2026-03-08')).toBe(Z('2026-03-08T05:00:00Z'))
    expect(mid('2026-03-09')).toBe(Z('2026-03-09T04:00:00Z'))
    expect(mid('2026-11-01')).toBe(Z('2026-11-01T04:00:00Z'))
    expect(mid('2026-11-02')).toBe(Z('2026-11-02T05:00:00Z'))
    for (const d of ['2026-10-01', '2026-03-08', '2026-03-09', '2026-11-01', '2026-11-02']) expect(isEtMidnight(mid(d))).toBe(true)
    expect(isEtMidnight(mid('2026-10-01') + 1)).toBe(false)
    expect(isWholeEtDays(mid('2026-10-01'), mid('2026-10-02'))).toBe(true)
    expect(isWholeEtDays(mid('2026-10-01'), mid('2026-10-02') - 1)).toBe(false)
  })
})

describe('refusedRowWindow', () => {
  it('leaves whole ET days, reversed, empty and non-finite windows alone in every mode', () => {
    for (const m of MODES) {
      expect(refusedRowWindow(mid('2026-10-01'), mid('2026-10-04'), m)).toEqual([mid('2026-10-01'), mid('2026-10-04')])
      expect(refusedRowWindow(mid('2026-03-08'), mid('2026-03-09'), m)).toEqual([mid('2026-03-08'), mid('2026-03-09')])
      expect(refusedRowWindow(mid('2026-11-01'), mid('2026-11-02'), m)).toEqual([mid('2026-11-01'), mid('2026-11-02')])
      expect(refusedRowWindow(500, 100, m)).toEqual([500, 100])
      expect(refusedRowWindow(500, 500, m)).toEqual([500, 500])
      expect(refusedRowWindow(NaN, 100, m)).toEqual([NaN, 100])
      expect(refusedWindowMoved(mid('2026-10-01'), mid('2026-10-02'), m)).toBe(false)
    }
  })

  it('outward: the midnight at or before since, and the one at or after until', () => {
    const w = refusedRowWindow(Z('2026-10-01T14:00:00Z'), Z('2026-10-01T15:00:00Z'), 'outward')
    expect(w).toEqual([mid('2026-10-01'), mid('2026-10-02')])
    // An aligned bound stays put while the other moves.
    expect(refusedRowWindow(mid('2026-10-01'), Z('2026-10-02T06:00:00Z'), 'outward')).toEqual([mid('2026-10-01'), mid('2026-10-03')])
    // DST days.
    expect(refusedRowWindow(Z('2026-03-08T12:00:00Z'), Z('2026-03-08T13:00:00Z'), 'outward')).toEqual([mid('2026-03-08'), mid('2026-03-09')])
    expect(refusedRowWindow(Z('2026-11-01T12:00:00Z'), Z('2026-11-01T13:00:00Z'), 'outward')).toEqual([mid('2026-11-01'), mid('2026-11-02')])
  })

  it('inward: the first midnight at or after since, and the last at or before until; a sub-day window is empty', () => {
    expect(refusedRowWindow(Z('2026-10-01T14:00:00Z'), Z('2026-10-01T15:00:00Z'), 'inward')).toEqual([mid('2026-10-02'), mid('2026-10-01')])
    expect(refusedRowWindow(Z('2026-09-30T14:00:00Z'), Z('2026-10-03T15:00:00Z'), 'inward')).toEqual([mid('2026-10-01'), mid('2026-10-03')])
    expect(refusedRowWindow(Z('2026-03-08T06:00:00Z'), Z('2026-03-10T03:00:00Z'), 'inward')).toEqual([mid('2026-03-09'), mid('2026-03-09')])
    expect(refusedRowWindow(Z('2026-10-31T06:00:00Z'), Z('2026-11-02T06:00:00Z'), 'inward')).toEqual([mid('2026-11-01'), mid('2026-11-02')])
  })

  it('nearest: the closer midnight by absolute distance; an exact tie goes to the later one (24 h day)', () => {
    // 2026-10-01 ET runs 04:00Z to 04:00Z next day; its midpoint is 16:00Z (12:00 ET).
    const n = (iso: string) => refusedRowWindow(Z(iso), Z(iso) + 1, 'nearest')[0]
    expect(n('2026-10-01T15:59:59.999Z')).toBe(mid('2026-10-01'))
    expect(n('2026-10-01T16:00:00.000Z')).toBe(mid('2026-10-02')) // the tie
    expect(n('2026-10-01T05:00:00Z')).toBe(mid('2026-10-01'))
    expect(n('2026-10-02T03:00:00Z')).toBe(mid('2026-10-02'))
  })

  it('nearest on the 23 h spring-forward day (2026-03-08): the midpoint is 16:30Z, not wall-clock noon', () => {
    // 05:00Z to 04:00Z next day: 23 h, midpoint 05:00Z + 11.5 h = 16:30Z (12:30 EDT).
    const n = (ms: number) => refusedRowWindow(ms, ms + 1, 'nearest')[0]
    expect(mid('2026-03-09') - mid('2026-03-08')).toBe(23 * H)
    expect(n(Z('2026-03-08T16:30:00Z') - 1)).toBe(mid('2026-03-08'))
    expect(n(Z('2026-03-08T16:30:00Z'))).toBe(mid('2026-03-09')) // the tie
    expect(n(Z('2026-03-08T16:00:00Z'))).toBe(mid('2026-03-08')) // wall-clock noon EDT is still nearer the start
  })

  it('nearest on the 25 h fall-back day (2026-11-01): the midpoint is 16:30Z', () => {
    // 04:00Z to 05:00Z next day: 25 h, midpoint 04:00Z + 12.5 h = 16:30Z (11:30 EST).
    const n = (ms: number) => refusedRowWindow(ms, ms + 1, 'nearest')[0]
    expect(mid('2026-11-02') - mid('2026-11-01')).toBe(25 * H)
    expect(n(Z('2026-11-01T16:30:00Z') - 1)).toBe(mid('2026-11-01'))
    expect(n(Z('2026-11-01T16:30:00Z'))).toBe(mid('2026-11-02')) // the tie
    expect(n(Z('2026-11-01T17:00:00Z'))).toBe(mid('2026-11-02')) // wall-clock noon EST is nearer the end
  })

  it('nearest maps a date-picker day (UTC 00:00 to 23:59:59.999Z) to the same-date ET day', () => {
    for (const d of ['2026-10-01', '2026-03-08', '2026-11-01', '2026-01-15', '2026-07-04']) {
      const w = refusedRowWindow(Z(`${d}T00:00:00.000Z`), Z(`${d}T23:59:59.999Z`), 'nearest')
      expect(w, d).toEqual([mid(d), mid(addDays(d, 1))])
    }
    // A picked week too.
    expect(refusedRowWindow(Z('2026-09-25T00:00:00.000Z'), Z('2026-10-01T23:59:59.999Z'), 'nearest')).toEqual([mid('2026-09-25'), mid('2026-10-02')])
  })

  it('every snapped window is whole ET days or empty, for every mode, over a sweep of windows', () => {
    const start = Z('2026-10-30T00:00:00Z') // spans the 2026-11-01 fall-back
    for (const m of MODES) {
      for (let a = 0; a < 96; a += 5) {
        for (let len = 1; len < 80; len += 7) {
          const since = start + a * H + 17 * 60_000
          const until = since + len * H
          const [from, to] = refusedRowWindow(since, until, m)
          if (from >= to) continue
          expect(isEtMidnight(from) && isEtMidnight(to), `${m} ${since} ${until}`).toBe(true)
          expect(etDateFast(from) < etDateFast(to)).toBe(true)
        }
      }
    }
  })
})

describe('refusedWindowClause', () => {
  it('ET-midnight bounds: exactly the plain pair, the request bounds, not moved (byte-identical path)', () => {
    for (const m of MODES) {
      expect(refusedWindowClause(mid('2026-10-01'), mid('2026-10-02'), m)).toEqual({
        terms: ['ts >= ?', 'ts < ?'],
        binds: [mid('2026-10-01'), mid('2026-10-02')],
        moved: false,
      })
    }
  })

  it('moved: still two binds; the outer pair spans both windows; both windows are inlined integers', () => {
    const since = Z('2026-10-01T15:00:00Z')
    const until = Z('2026-10-01T17:00:00Z')
    const c = refusedWindowClause(since, until, 'nearest') // -> [10-01, 10-02) ET for refused rows
    expect(c.moved).toBe(true)
    expect(c.binds).toEqual([mid('2026-10-01'), mid('2026-10-02')])
    expect(c.terms.slice(0, 2)).toEqual(['ts >= ?', 'ts < ?'])
    expect(c.terms).toHaveLength(3)
    expect(c.terms[2]).toBe(
      `(CASE WHEN ${refusedPathMatch().sql} THEN (ts >= ${mid('2026-10-01')} AND ts < ${mid('2026-10-02')}) ` +
        `ELSE (ts >= ${since} AND ts < ${until}) END)`,
    )
    expect(c.terms[2]).not.toContain('?')
  })

  it('an empty refused window keeps the request pair and drops refused rows (NOT match)', () => {
    const since = Z('2026-10-01T14:00:00Z')
    const until = Z('2026-10-01T15:00:00Z')
    for (const m of ['nearest', 'inward'] as const) {
      expect(refusedWindowClause(since, until, m)).toEqual({ terms: ['ts >= ?', 'ts < ?', `NOT ${refusedPathMatch().sql}`], binds: [since, until], moved: true })
    }
  })

  it('on SQLite: refused rows count whole ET days (or zero), every other row the exact window, in every mode', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE hits (ts INTEGER, path TEXT)')
    const ins = db.prepare('INSERT INTO hits (ts, path) VALUES (?, ?)')
    const day = mid('2026-10-01')
    // One refused and one ordinary row in each half hour of 2026-10-01 ET, plus neighbours.
    for (let i = 0; i < 48; i++) {
      ins.run(day + i * 1_800_000 + 60_000, REFUSED_SAMPLE_PATHS[i % REFUSED_SAMPLE_PATHS.length])
      ins.run(day + i * 1_800_000 + 60_000, '/game')
    }
    ins.run(day - 60_000, '/return/x/d1')
    ins.run(mid('2026-10-02') + 60_000, '/return/x/d1')
    const count = (since: number, until: number, m: RefusedSnap) => {
      const c = refusedWindowClause(since, until, m)
      const r = db
        .prepare(`SELECT SUM(CASE WHEN ${refusedPathMatch().sql} THEN 1 ELSE 0 END) AS refused, SUM(CASE WHEN path = '/game' THEN 1 ELSE 0 END) AS game FROM hits WHERE ${c.terms.join(' AND ')}`)
        .get(...c.binds) as { refused: number | null; game: number | null }
      return { refused: r.refused ?? 0, game: r.game ?? 0 }
    }
    for (const m of MODES) {
      for (let a = 0; a < 48; a++) {
        for (let b = a + 1; b <= 48; b++) {
          if (a === 0 && b === 48) continue // whole day: the unchanged path
          const since = day + a * 1_800_000
          const until = day + b * 1_800_000
          const got = count(since, until, m)
          expect([0, 48], `${m} [${a}, ${b})`).toContain(got.refused)
          expect(got.game, `${m} [${a}, ${b})`).toBe(b - a) // exact window
          if (m === 'outward') expect(got.refused).toBe(48)
          if (m === 'inward') expect(got.refused).toBe(0)
        }
      }
    }
    expect(count(day, mid('2026-10-02'), 'nearest')).toEqual({ refused: 48, game: 48 })
    db.close()
  })
})
