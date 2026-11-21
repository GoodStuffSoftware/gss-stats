import { describe, expect, it } from 'vitest'
import { arcLabelsPlugin } from './charts'
import { MOTION_MS, pieFrame, pieMotionPlugin } from './pieMotion'

const TAU = Math.PI * 2
const TOP = -Math.PI / 2
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 9)

describe('pieFrame', () => {
  it('none is the final pie at every progress', () => {
    for (const p of [0, 0.5, 1]) expect(pieFrame({ kind: 'none' }, p)).toEqual({ start: TOP, span: TAU })
  })

  it('every motion ends on the final pie', () => {
    for (const m of [{ kind: 'expand', from: 0.2, to: 0.45 }, { kind: 'unfurl', mid: 0.3 }, { kind: 'unfurl', mid: 0 }] as const) {
      const f = pieFrame(m, 1)
      near(f.start, TOP)
      near(f.span, TAU)
    }
  })

  it('expand starts squeezed into the picked slice wedge, where it sat', () => {
    const f = pieFrame({ kind: 'expand', from: 0.25, to: 0.5 }, 0)
    near(f.start, TOP + 0.25 * TAU)
    near(f.span, 0.25 * TAU)
    // and grows monotonically
    let last = f.span
    for (const p of [0.2, 0.4, 0.6, 0.8, 1]) {
      const next = pieFrame({ kind: 'expand', from: 0.25, to: 0.5 }, p).span
      expect(next).toBeGreaterThan(last)
      last = next
    }
  })

  it('unfurl keeps the slice you came from where it ends up while the circle grows', () => {
    const mid = 0.3
    const finalMid = TOP + mid * TAU
    for (const p of [0, 0.1, 0.5, 0.9, 1]) {
      const f = pieFrame({ kind: 'unfurl', mid }, p)
      near(f.start + mid * f.span, finalMid)
    }
    near(pieFrame({ kind: 'unfurl', mid }, 0).span, 0)
  })

  it('an unfurl around the top is a clockwise sweep from 12 o clock', () => {
    const f = pieFrame({ kind: 'unfurl', mid: 0 }, 0.5)
    near(f.start, TOP)
    expect(f.span).toBeGreaterThan(0)
    expect(f.span).toBeLessThan(TAU)
  })

  it('durations sit in the 400-700 ms band', () => {
    expect(MOTION_MS.expand).toBeGreaterThanOrEqual(400)
    expect(MOTION_MS.expand).toBeLessThanOrEqual(700)
    expect(MOTION_MS.unfurl).toBeGreaterThanOrEqual(400)
    expect(MOTION_MS.unfurl).toBeLessThanOrEqual(700)
  })
})

// A stand-in for a Chart.js chart: one dataset of arcs (shares of a circle that starts at the top), a ctx that
// records where labels are drawn, and a `draw` that runs the plugin hooks the way Chart.js orders them.
function fakeChart(shares: number[], plugins: any[]) {
  let run = 0
  const arcs = shares.map((s) => {
    const startAngle = TOP + run * TAU
    run += s
    return { startAngle, endAngle: TOP + run * TAU, circumference: s * TAU, x: 100, y: 100, innerRadius: 60, outerRadius: 100 }
  })
  const labels: { text: string; at: number }[] = []
  const ctx: any = {
    save() {},
    restore() {},
    textAlign: '',
    textBaseline: '',
    font: '',
    fillStyle: '',
    measureText: (t: string) => ({ width: t.length * 5 }),
    pos: [0, 0] as [number, number],
    translate(x: number, y: number) {
      ctx.pos = [x, y]
    },
    rotate() {},
    fillText(text: string) {
      // where on the circle (centre 100,100) the character went, 0..2pi
      const a = Math.atan2(ctx.pos[1] - 100, ctx.pos[0] - 100)
      labels.push({ text, at: (a + TAU) % TAU })
    },
  }
  const seen: { start: number; end: number }[][] = []
  const chart: any = {
    ctx,
    data: { datasets: [{ backgroundColor: shares.map(() => '#E0722C') }] },
    getDatasetMeta: () => ({ data: arcs }),
    draws: 0,
    draw() {
      chart.draws++
      for (const p of plugins) p.beforeDatasetsDraw?.(chart)
      seen.push(arcs.map((a) => ({ start: a.startAngle, end: a.endAngle })))
      for (const p of plugins) p.afterDatasetsDraw?.(chart)
    },
  }
  return { chart, arcs, seen, labels }
}

function clock() {
  const c = { t: 1000, queue: [] as (() => void)[] }
  return {
    c,
    now: () => c.t,
    schedule: (cb: () => void) => void c.queue.push(cb),
    flush() {
      const q = c.queue
      c.queue = []
      q.forEach((cb) => cb())
    },
  }
}

describe('pieMotionPlugin', () => {
  it('moves the arcs for each frame, then puts them back, and stops when the time is up', () => {
    const k = clock()
    const plugin = pieMotionPlugin({ motion: { kind: 'expand', from: 0, to: 0.5 }, now: k.now, schedule: k.schedule })
    const { chart, arcs, seen } = fakeChart([0.5, 0.3, 0.2], [plugin])
    const finals = arcs.map((a) => ({ ...a }))

    chart.draw() // first frame at t0
    near(seen[0][0].start, TOP) // the wedge 0..0.5 starts at the top
    near(seen[0][2].end, TOP + Math.PI) // all three squeezed into the picked half
    expect(arcs).toEqual(finals) // restored after the draw
    expect(k.c.queue).toHaveLength(1) // asked for the next frame

    k.c.t += 300
    k.flush()
    expect(chart.draws).toBe(2)
    expect(seen[1][2].end).toBeGreaterThan(seen[0][2].end)
    expect(seen[1][2].end).toBeLessThan(TOP + TAU)

    k.c.t += MOTION_MS.expand
    k.flush()
    near(seen[2][2].end, TOP + TAU) // the final pie
    expect(arcs).toEqual(finals)
    expect(k.c.queue).toHaveLength(0) // done: no more frames
    k.flush()
    expect(chart.draws).toBe(3)
  })

  it('none draws the final pie and never asks for another frame', () => {
    const k = clock()
    const plugin = pieMotionPlugin({ motion: { kind: 'none' }, now: k.now, schedule: k.schedule })
    const { chart, seen } = fakeChart([0.6, 0.4], [plugin])
    chart.draw()
    near(seen[0][1].end, TOP + TAU)
    expect(k.c.queue).toHaveLength(0)
  })

  it('a destroyed chart is not drawn again', () => {
    const k = clock()
    const plugin = pieMotionPlugin({ motion: { kind: 'unfurl', mid: 0 }, now: k.now, schedule: k.schedule })
    const { chart } = fakeChart([0.6, 0.4], [plugin])
    chart.draw()
    plugin.beforeDestroy?.(chart, {}, {})
    k.c.t += 100
    k.flush()
    expect(chart.draws).toBe(1)
  })

  it('labels drawn between the two hooks follow the moved arcs (no stale label)', () => {
    const k = clock()
    const motion = pieMotionPlugin({ motion: { kind: 'expand', from: 0.5, to: 1 }, now: k.now, schedule: k.schedule })
    const labels: any = arcLabelsPlugin({ 0: [{ name: 'AB', sub: [] }] })
    const { chart, labels: drawn } = fakeChart([1], [labels, motion])
    chart.draw()
    k.c.t += 560
    k.flush()
    // The label is two characters either side of the arc's middle: their mean angle is that middle.
    // Frame 0: the one arc is squeezed into the picked left half (9 o clock = pi); last frame: the whole
    // circle, whose middle is at 6 o clock (pi / 2 on a canvas, y down).
    expect(drawn).toHaveLength(4)
    expect((drawn[0].at + drawn[1].at) / 2).toBeCloseTo(Math.PI, 5)
    expect((drawn[2].at + drawn[3].at) / 2).toBeCloseTo(Math.PI / 2, 5)
  })

  it('settled() is false for every frame of a motion but the last, so labels outside the ring wait for the final pie', () => {
    const k = clock()
    const plugin = pieMotionPlugin({ motion: { kind: 'unfurl', mid: 0 }, now: k.now, schedule: k.schedule })
    const asked: boolean[] = []
    const probe = { afterDatasetsDraw: () => asked.push(plugin.settled()) } // runs before the motion plugin's own
    const { chart } = fakeChart([0.6, 0.4], [plugin])
    const hooks = [plugin, probe]
    const draw = () => {
      for (const p of hooks) (p as any).beforeDatasetsDraw?.(chart)
      for (const p of [probe, plugin]) (p as any).afterDatasetsDraw?.(chart)
    }
    draw()
    k.c.t += 200
    k.flush()
    draw()
    k.c.t += 400
    draw()
    expect(asked).toEqual([false, false, true])
    expect(pieMotionPlugin({ motion: { kind: 'none' } }).settled()).toBe(true)
  })
})
