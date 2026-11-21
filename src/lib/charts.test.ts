import { describe, expect, it, vi } from 'vitest'
import { PALETTE, activationMarkerIndex, arcLabelsPlugin, contrastRatio, ellipsize, fitArcLabel, inkOn, placeOutsideLabels, playActivationMarkerPlugin, pointInSlice, spreadRows } from './charts'
import { PLAY_TRACKING_ACTIVATION_DATE_ET, PLAY_TRACKING_MARKER_LABEL } from './popupEvents'

// Part A: the pop-up trend chart's "tracking starts" boundary — see lib/popupEvents.ts
// TRACKING_ACTIVATION_DATE_ET and the comment on activationMarkerIndex itself.
describe('activationMarkerIndex', () => {
  const rows = [{ key: { date: '2026-09-18' } }, { key: { date: '2026-09-19' } }, { key: { date: '2026-09-20' } }, { key: { date: '2026-09-21' } }]

  it('returns -1 when there is no activation date at all', () => {
    expect(activationMarkerIndex(rows, null)).toBe(-1)
  })

  it('finds the first index on/after the activation date', () => {
    expect(activationMarkerIndex(rows, '2026-09-20')).toBe(2)
    expect(activationMarkerIndex(rows, '2026-09-19')).toBe(1)
  })

  it('activation date matching the very first plotted day → boundary at 0 (nothing pre-activation)', () => {
    expect(activationMarkerIndex(rows, '2026-09-18')).toBe(0)
  })

  it('activation date before every plotted day → boundary at 0', () => {
    expect(activationMarkerIndex(rows, '2026-01-01')).toBe(0)
  })

  it('activation date after every plotted day → boundary at rows.length (everything is still pre-activation)', () => {
    expect(activationMarkerIndex(rows, '2099-01-01')).toBe(rows.length)
  })

  it('empty rows → boundary at 0 (an empty range is trivially not pre-activation)', () => {
    expect(activationMarkerIndex([], '2026-09-20')).toBe(0)
  })

  // activationMarkerIndex is generic on its activationDateEt argument — the SAME function
  // locates the Play/Android boundary (PLAY_TRACKING_ACTIVATION_DATE_ET, a submission day,
  // not a live date — see lib/popupEvents.ts) without needing a second implementation.
  it('also locates the boundary for PLAY_TRACKING_ACTIVATION_DATE_ET, both null and set', () => {
    expect(activationMarkerIndex(rows, null)).toBe(-1)
    expect(activationMarkerIndex(rows, PLAY_TRACKING_ACTIVATION_DATE_ET)).toBe(activationMarkerIndex(rows, '2026-09-26'))
    expect(activationMarkerIndex(rows, PLAY_TRACKING_ACTIVATION_DATE_ET)).toBe(rows.length) // 2026-09-26 is after every plotted day here
  })
})

// Part 3 (v0.3.2): the Play/Android twin of the web "tracking starts" marker — draws
// PLAY_TRACKING_MARKER_LABEL, not "tracking starts" (a submission day is not an arrival —
// see lib/popupEvents.ts PLAY_TRACKING_ACTIVATION_DATE_ET), and uses its own Chart.js
// plugin id so it can coexist with the web marker on the same chart.
describe('playActivationMarkerPlugin', () => {
  function fakeChart(index: number) {
    const calls: { fillText: [string, number, number][] } = { fillText: [] }
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      measureText: vi.fn(() => ({ width: 10 })),
      fillText: vi.fn((text: string, x: number, y: number) => calls.fillText.push([text, x, y])),
      strokeStyle: '',
      lineWidth: 0,
      fillStyle: '',
      font: '',
      textAlign: '',
      textBaseline: '',
    }
    const scales = { x: { getPixelForValue: (i: number) => i * 10 } }
    const chartArea = { left: 0, right: 100, top: 0, bottom: 50 }
    return { chart: { ctx, chartArea, scales }, calls }
  }

  it('has its own plugin id, distinct from the web marker', () => {
    expect(playActivationMarkerPlugin(1).id).toBe('playActivationMarker')
  })

  it('draws PLAY_TRACKING_MARKER_LABEL (not "tracking starts") when the boundary is in view', () => {
    const { chart, calls } = fakeChart(5)
    playActivationMarkerPlugin(5).afterDraw(chart as any)
    expect(calls.fillText).toHaveLength(1)
    expect(calls.fillText[0][0]).toBe(PLAY_TRACKING_MARKER_LABEL)
  })

  it('draws nothing when the boundary falls outside the visible chart area', () => {
    const { chart, calls } = fakeChart(-1) // getPixelForValue(-1) * 10 = -10, left of chartArea.left
    playActivationMarkerPlugin(-1).afterDraw(chart as any)
    expect(calls.fillText).toHaveLength(0)
  })
})

// On-slice labels (the pie's name / amount / share text; the nested doughnut shares the plugin).
describe('arcLabelsPlugin', () => {
  // One arc of `span` radians on a ring 60..100 around (100,100); every character is 5 px wide.
  function draw(span: number, items: { name: string; sub: string | string[] }[], fill: string, look?: Parameters<typeof arcLabelsPlugin>[1]) {
    const texts: string[] = []
    const inks: string[] = []
    const ctx: any = {
      save() {},
      restore() {},
      translate() {},
      rotate() {},
      measureText: (t: string) => ({ width: t.length * 5 }),
      fillText: (t: string) => {
        texts.push(t)
        inks.push(ctx.fillStyle)
      },
    }
    const arc = { startAngle: 0, endAngle: span, x: 100, y: 100, innerRadius: 60, outerRadius: 100 }
    const chart: any = { ctx, data: { datasets: [{ backgroundColor: [fill] }] }, getDatasetMeta: () => ({ data: [arc] }) }
    arcLabelsPlugin({ 0: items }, look).afterDatasetsDraw(chart)
    return { text: texts.join(''), inks }
  }

  it('draws the name and the first alternative that fits; none when the name does not fit', () => {
    const subs = ['$1,200.00 · 25%', '$1,200.00', '25%']
    const roomy = draw(1.2, [{ name: 'Rent', sub: subs }], '#6A994E')
    expect(roomy.text).toContain('Rent')
    expect(roomy.text).toContain('$1,200.00')
    // a narrower arc: the long alternatives do not fit, the short one does
    const narrow = draw(0.5, [{ name: 'Rent', sub: subs }], '#6A994E')
    expect(narrow.text).toContain('Rent')
    expect(narrow.text).toContain('25%')
    expect(narrow.text).not.toContain('$')
    // too narrow for the name: nothing at all (no orphan number)
    expect(draw(0.25, [{ name: 'A long merchant name', sub: ['25%'] }], '#6A994E').text).toBe('')
  })

  it('a sliver (under about 11 degrees) is never labelled', () => {
    expect(draw(0.15, [{ name: 'A', sub: ['1%'] }], '#6A994E').text).toBe('')
  })

  it('a plain string sub still works (the nested doughnut passes one)', () => {
    expect(draw(1.2, [{ name: 'Ab', sub: '5 · 9%' }], '#6A994E').text).toContain('9%')
  })

  it('the default ink is the nested doughnut brightness cut; bestContrast picks by WCAG contrast', () => {
    expect(draw(1.2, [{ name: 'Ab', sub: [] }], '#8A8278').inks[0]).toBe('#ffffff')
    expect(draw(1.2, [{ name: 'Ab', sub: [] }], '#E9C46A', { bestContrast: true }).inks[0]).toBe(inkOn('#E9C46A'))
  })
})

// The strict fit (look.fit): every glyph box must lie inside its slice. Made-up slices on a ring 80..140 px around
// (200,200); every character is 6 px wide whatever the font. Angles: 0 = 3 o'clock, clockwise, 12 o'clock = -pi/2.
describe('fitArcLabel', () => {
  const FONTS = { name: '600 12px Inter', sub: '700 11px Grotesk' }
  const measure = (_font: string, t: string) => t.length * 6
  const geom = (mid: number, span: number) => ({ cx: 200, cy: 200, innerRadius: 80, outerRadius: 140, startAngle: mid - span / 2, endAngle: mid + span / 2 })
  const SUBS = ['$1,200.00 · 25%', '$1,200.00', '25%']
  const TOP = -Math.PI / 2
  const BOTTOM = Math.PI / 2
  const LEFT = Math.PI

  // An independent check of the geometry, by polar coordinates of every corner of every glyph box.
  function insideBy(g: ReturnType<typeof geom>, placed: NonNullable<ReturnType<typeof fitArcLabel>>, margin: number) {
    const mid = (g.startAngle + g.endAngle) / 2
    const half = (g.endAngle - g.startAngle) / 2
    for (const p of placed) {
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const lx = (sx * p.w) / 2
        const ly = (sy * p.h) / 2
        const x = p.x + lx * Math.cos(p.rot) - ly * Math.sin(p.rot) - g.cx
        const y = p.y + lx * Math.sin(p.rot) + ly * Math.cos(p.rot) - g.cy
        const rho = Math.hypot(x, y)
        let off = Math.atan2(y, x) - mid
        off = Math.atan2(Math.sin(off), Math.cos(off)) // -pi..pi
        if (rho < g.innerRadius + margin - 1e-9 || rho > g.outerRadius - margin + 1e-9) return false
        if (rho * Math.sin(half - Math.abs(off)) < margin - 1e-9 || Math.abs(off) > half) return false
      }
    }
    return true
  }
  const upright = (placed: NonNullable<ReturnType<typeof fitArcLabel>>) =>
    placed.every((p) => Math.cos(p.rot) > -1e-9) // the text direction points right (or straight up/down), never leftwards
  const textOf = (placed: NonNullable<ReturnType<typeof fitArcLabel>>) => placed.map((p) => p.text).join('')

  it('a thick slice shows the name and the full amount line, inside the slice', () => {
    const g = geom(BOTTOM, 1.6)
    const placed = fitArcLabel(g, { name: 'Rent', sub: SUBS }, FONTS, measure)!
    expect(placed).not.toBeNull()
    expect(textOf(placed)).toBe('Rent$1,200.00 · 25%')
    expect(insideBy(g, placed, 4)).toBe(true)
    expect(upright(placed)).toBe(true)
  })

  it('a thin slice gets no label, and none that pokes out', () => {
    expect(fitArcLabel(geom(TOP, 0.1), { name: 'Rent', sub: SUBS }, FONTS, measure)).toBeNull()
    // a thin slice that fits only a short name: the name alone, inside
    const g = geom(BOTTOM, 0.5)
    const placed = fitArcLabel(g, { name: 'Gas', sub: SUBS }, FONTS, measure)
    if (placed) expect(insideBy(g, placed, 4)).toBe(true)
  })

  it('a 6% slice at 9 o clock drops the amount that would run past the slice and keeps what fits, across the arc', () => {
    const g = geom(LEFT, 0.377)
    const item = { name: 'Fees', sub: ['$7,400.58 · 6%', '$7,400.58', '6%'] }
    const placed = fitArcLabel(g, item, FONTS, measure)!
    expect(placed).not.toBeNull()
    expect(textOf(placed)).not.toContain('$7,400.58') // 54 px of amount in a 60 px ring with 4 px margins: no
    expect(textOf(placed)).toContain('Fees')
    expect(insideBy(g, placed, 4)).toBe(true)
    expect(upright(placed)).toBe(true)
    // across the arc at 9 o'clock is horizontal text: one rotation for the whole label, and it is level
    expect(new Set(placed.map((p) => p.rot.toFixed(6))).size).toBe(1)
    expect(Math.abs(Math.sin(placed[0].rot))).toBeLessThan(1e-6)
  })

  it('a long name is wrapped on two lines when that is what fits', () => {
    const g = geom(BOTTOM, 0.63)
    const placed = fitArcLabel(g, { name: 'Home and garden', sub: ['10%'] }, FONTS, measure)!
    expect(placed).not.toBeNull()
    expect(textOf(placed)).toContain('Home and')
    expect(textOf(placed)).toContain('garden')
    expect(textOf(placed)).not.toContain('Home and garden')
    expect(insideBy(g, placed, 4)).toBe(true)
  })

  it('a name that fits nowhere gets no label at all, not a clipped one', () => {
    expect(fitArcLabel(geom(LEFT, 0.377), { name: 'Entertainment', sub: SUBS }, FONTS, measure)).toBeNull()
  })

  it('a slice that crosses 12 o clock fits the same as one at 6 o clock, with the angles taken either way round', () => {
    const base = fitArcLabel(geom(BOTTOM, 1.6), { name: 'Rent', sub: SUBS }, FONTS, measure)!
    const g1 = geom(TOP, 1.6) // -pi/2 -/+ 0.8
    const g2 = { ...g1, startAngle: g1.startAngle + 2 * Math.PI, endAngle: g1.endAngle + 2 * Math.PI } // 3pi/2 -/+ 0.8
    for (const g of [g1, g2]) {
      const placed = fitArcLabel(g, { name: 'Rent', sub: SUBS }, FONTS, measure)!
      expect(placed).not.toBeNull()
      expect(textOf(placed)).toBe(textOf(base))
      expect(insideBy(g, placed, 4)).toBe(true)
      expect(upright(placed)).toBe(true)
    }
  })

  it('pointInSlice: inside, past each edge, and past each radius', () => {
    const g = geom(TOP, 1)
    const at = (r: number, a: number) => pointInSlice(g, 200 + r * Math.cos(a), 200 + r * Math.sin(a), 2)
    expect(at(110, TOP)).toBe(true)
    expect(at(110, TOP + 0.5)).toBe(false) // on the end edge: within the margin
    expect(at(110, TOP - 0.7)).toBe(false) // beyond the start edge
    expect(at(81, TOP)).toBe(false) // inside the inner margin
    expect(at(139, TOP)).toBe(false) // inside the outer margin
  })

  it('the plugin with fit draws only what fits (the 9 o clock case) and keeps the fitted ink', () => {
    const calls: { text: string; ink: string }[] = []
    const ctx: any = {
      save() {},
      restore() {},
      translate() {},
      rotate() {},
      measureText: (t: string) => ({ width: t.length * 6 }),
      fillText: (t: string) => calls.push({ text: t, ink: ctx.fillStyle }),
    }
    const arc = { ...geom(LEFT, 0.377), x: 200, y: 200 }
    const chart: any = { ctx, data: { datasets: [{ backgroundColor: ['#E9C46A'] }] }, getDatasetMeta: () => ({ data: [arc] }) }
    arcLabelsPlugin({ 0: [{ name: 'Fees', sub: ['$7,400.58 · 6%', '$7,400.58', '6%'] }] }, { fit: true, bestContrast: true, nameFont: FONTS.name, subFont: FONTS.sub }).afterDatasetsDraw(chart)
    const text = calls.map((c) => c.text).join('')
    expect(text).toContain('Fees')
    expect(text).not.toContain('$7,400.58')
    expect(new Set(calls.map((c) => c.ink))).toEqual(new Set([inkOn('#E9C46A')]))
  })
})

describe('inkOn', () => {
  it('reaches readable contrast on every palette colour, the folded-bucket grey and both extremes', () => {
    for (const fill of [...PALETTE, '#C9C3B8', '#FFFFFF', '#000000', '#808080']) {
      expect(contrastRatio(fill, inkOn(fill))).toBeGreaterThanOrEqual(4.4)
    }
  })

  it('is dark on light fills and white on dark ones', () => {
    expect(inkOn('#E9C46A')).not.toBe('#FFFFFF')
    expect(inkOn('#211C18')).toBe('#FFFFFF')
  })
})

// Outside labels (look.outside): a ring 80..140 px around (260, 200) in a 520 x 400 chart; every character is 6 px
// wide whatever the font. Made-up names. Angles: 0 = 3 o'clock, clockwise.
describe('outside labels', () => {
  const FONTS = { name: '500 11px Inter', tail: '700 11px Grotesk' }
  const measure = (_f: string, t: string) => t.length * 6
  const SIZE = { w: 520, h: 400 }
  const slice = (mid: number, span: number, index = 0, name = 'Insurance', tail = '4%') => ({
    index,
    name,
    tail,
    geom: { cx: 260, cy: 200, innerRadius: 80, outerRadius: 140, startAngle: mid - span / 2, endAngle: mid + span / 2 },
  })
  const rectOf = (l: ReturnType<typeof placeOutsideLabels>[number]) => {
    const w = l.nameW + (l.tail ? 4 + l.tailW : 0)
    const x0 = l.side === 1 ? l.x : l.x - w
    return { x0, x1: x0 + w, y0: l.y - 6.5, y1: l.y + 6.5 }
  }
  // An independent check: no two boxes overlap, every box is inside the chart and clear of the ring.
  function expectClean(labels: ReturnType<typeof placeOutsideLabels>) {
    const rects = labels.map(rectOf)
    rects.forEach((r, i) => {
      expect(r.x0).toBeGreaterThanOrEqual(0)
      expect(r.x1).toBeLessThanOrEqual(SIZE.w)
      expect(r.y0).toBeGreaterThanOrEqual(0)
      expect(r.y1).toBeLessThanOrEqual(SIZE.h)
      // the point of the box nearest the ring's centre is clear of the ring
      const nx = Math.min(Math.max(260, r.x0), r.x1)
      const ny = Math.min(Math.max(200, r.y0), r.y1)
      expect(Math.hypot(nx - 260, ny - 200)).toBeGreaterThanOrEqual(140)
      rects.slice(i + 1).forEach((o) => {
        const apart = r.x1 <= o.x0 || o.x1 <= r.x0 || r.y1 <= o.y0 || o.y1 <= r.y0
        expect(apart).toBe(true)
      })
    })
  }

  it('ellipsize: whole when it fits, cut with an ellipsis, null when not even two letters fit', () => {
    const m = (t: string) => t.length * 6
    expect(ellipsize('Dining', 36, m)).toBe('Dining')
    expect(ellipsize('Home & garden', 60, m)).toBe('Home & ga…')
    expect(ellipsize('Home & garden', 17, m)).toBeNull()
  })

  it('spreadRows: rows keep their ideal place when apart, pool around the mean when colliding, and stay in bounds', () => {
    expect(spreadRows([20, 60, 100], 15, 10, 200)).toEqual([20, 60, 100])
    const pooled = spreadRows([50, 52, 54], 15, 10, 200)!
    expect(pooled.map((y, i) => (i ? y - pooled[i - 1] : 15))).toEqual([15, 15, 15])
    expect(pooled[1]).toBeCloseTo(52, 6) // centred on the mean of the ideals
    expect(spreadRows([2, 3], 15, 10, 200)).toEqual([10, 25]) // pushed in from the top edge
    expect(spreadRows([198, 199], 15, 10, 200)).toEqual([185, 200]) // and from the bottom
    expect(spreadRows([1, 2, 3, 4], 15, 10, 50)).toBeNull() // 4 rows need 45 px, 40 are there
    expect(spreadRows([], 15, 10, 50)).toEqual([])
  })

  it('a small slice on each side gets its name and share on a leader that starts on its edge', () => {
    const labels = placeOutsideLabels([slice(-0.5, 0.1, 0, 'Insurance', '4%'), slice(Math.PI + 0.5, 0.1, 1, 'Fuel', '3%')], SIZE, FONTS, measure)
    expect(labels.map((l) => [l.index, l.side, l.name, l.tail])).toEqual([[0, 1, 'Insurance', '4%'], [1, -1, 'Fuel', '3%']])
    for (const l of labels) {
      const [start] = l.line
      expect(Math.hypot(start[0] - 260, start[1] - 200)).toBeCloseTo(141, 6) // starts at the ring's outer edge
      expect(l.line[l.line.length - 1][1]).toBe(l.y) // ends level with its text
    }
    expectClean(labels)
  })

  it('many tiny slices on one side: none overlaps, and the smallest are dropped when there is no room', () => {
    const cands = Array.from({ length: 40 }, (_, i) => slice(-0.45 + i * 0.022, 0.01 + i * 0.0001, i, `Store ${i}`, '1%'))
    const labels = placeOutsideLabels(cands, SIZE, FONTS, measure)
    expect(labels.length).toBeGreaterThan(5)
    expect(labels.length).toBeLessThan(40)
    expectClean(labels)
    // what was dropped is the smaller part: the kept slices are on average the bigger
    const kept = new Set(labels.map((l) => l.index))
    const span = (i: number) => cands[i].geom.endAngle - cands[i].geom.startAngle
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const dropped = cands.map((_, i) => i).filter((i) => !kept.has(i))
    expect(mean([...kept].map(span))).toBeGreaterThan(mean(dropped.map(span)))
  })

  it('a name too long for the room is cut with an ellipsis; no room even for that drops the label', () => {
    const narrow = { w: 470, h: 400 } // 70 px beyond the ring at 3 o'clock
    const [l] = placeOutsideLabels([slice(0, 0.1, 0, 'Home & garden', '4%')], narrow, FONTS, measure)
    expect(l.name.endsWith('…')).toBe(true)
    expect(l.name.length).toBeLessThan('Home & garden'.length)
    expect(l.x + l.nameW + 4 + l.tailW).toBeLessThanOrEqual(narrow.w)
    expect(placeOutsideLabels([slice(0, 0.1, 0, 'Home & garden', '4%')], { w: 430, h: 400 }, FONTS, measure)).toEqual([])
  })

  it('the share goes first: the whole name is shown when it fits without the share, and is cut only when even it does not', () => {
    const name = 'Home & garden' // 78 px; the share adds 16 more
    const wide = { w: 495, h: 400 } // 82 px of room: the name fits, the name and the share do not
    const [bare] = placeOutsideLabels([slice(0, 0.1, 0, name, '4%')], wide, FONTS, measure)
    expect(bare.name).toBe(name)
    expect(bare.tail).toBe('')
    expect(bare.tailW).toBe(0)
    expect(bare.x + bare.nameW).toBeLessThanOrEqual(wide.w)
    const roomy = { w: 520, h: 400 } // room for both: nothing is dropped
    const [both] = placeOutsideLabels([slice(0, 0.1, 0, name, '4%')], roomy, FONTS, measure)
    expect([both.name, both.tail]).toEqual([name, '4%'])
    const tight = { w: 485, h: 400 } // 72 px: not even the bare name fits, so it is cut and keeps its share
    const [cut] = placeOutsideLabels([slice(0, 0.1, 0, name, '4%')], tight, FONTS, measure)
    expect(cut.name.endsWith('…')).toBe(true)
    expect(cut.tail).toBe('4%')
  })

  it('a full pie of small slices stays clean', () => {
    const n = 18
    const cands = Array.from({ length: n }, (_, i) => slice(-Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / n, (2 * Math.PI) / n, i, `Name ${i}`, '5%'))
    expectClean(placeOutsideLabels(cands, SIZE, FONTS, measure))
  })

  describe('the plugin', () => {
    function draw(items: { name: string; sub: string[]; tail?: string }[], arcs: object[], outside: object | undefined, width = SIZE.w) {
      const texts: string[] = []
      let strokes = 0
      const ctx: any = {
        save() {},
        restore() {},
        translate() {},
        rotate() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke: () => strokes++,
        measureText: (t: string) => ({ width: t.length * 6 }),
        fillText: (t: string) => texts.push(t),
      }
      const chart: any = { ctx, width, height: SIZE.h, data: { datasets: [{ backgroundColor: arcs.map(() => '#E9C46A') }] }, getDatasetMeta: () => ({ data: arcs }) }
      arcLabelsPlugin({ 0: items }, { fit: true, nameFont: FONTS.name, subFont: FONTS.tail, ...(outside ? { outside } : {}) } as never).afterDatasetsDraw(chart)
      return { texts: texts.join('|'), strokes }
    }
    const arc = (mid: number, span: number) => ({ x: 260, y: 200, innerRadius: 80, outerRadius: 140, startAngle: mid - span / 2, endAngle: mid + span / 2 })
    const OUT = { ink: '#111111', line: '#555555' }
    const items = [
      { name: 'Rent', sub: ['$1,200.00 · 50%', '$1,200.00', '50%'], tail: '50%' },
      { name: 'Insurance', sub: ['$80.00 · 3%', '$80.00', '3%'], tail: '3%' },
    ]
    const arcs = [arc(-Math.PI / 2 + 1.5, 3), arc(-0.1, 0.1)]

    it('draws an outside label (name, share, a leader) for the slice with none inside, and only for it', () => {
      const r = draw(items, arcs, OUT)
      expect(r.texts).toContain('R|e|n|t') // inside, as before (drawn letter by letter)
      expect(r.texts).toContain('Insurance|3%') // outside: name, then the tail
      expect(r.strokes).toBe(1)
    })

    it('draws the whole name alone when only the share would not fit with it', () => {
      const long = [{ name: 'Home & garden', sub: ['$80.00 · 3%', '$80.00', '3%'], tail: '3%' }]
      expect(draw(long, [arc(-0.1, 0.1)], OUT, 495).texts).toContain('Home & garden')
      expect(draw(long, [arc(-0.1, 0.1)], OUT, 495).texts).not.toContain('3%')
      expect(draw(long, [arc(-0.1, 0.1)], OUT, 520).texts).toContain('Home & garden|3%')
    })

    it('without the option nothing is drawn outside, and while not ready nothing is', () => {
      expect(draw(items, arcs, undefined).strokes).toBe(0)
      expect(draw(items, arcs, undefined).texts).not.toContain('Insurance')
      const waiting = draw(items, arcs, { ...OUT, ready: () => false })
      expect(waiting.strokes).toBe(0)
      expect(waiting.texts).not.toContain('Insurance')
      expect(draw(items, arcs, { ...OUT, ready: () => true }).strokes).toBe(1)
    })

    it('the tail defaults to the last alternative of the sub text', () => {
      const r = draw([{ name: 'Insurance', sub: ['$80.00 · 3%', '$80.00', '3%'] }], [arc(-0.1, 0.1)], OUT)
      expect(r.texts).toContain('Insurance|3%')
    })
  })
})
