// The gss-stats-sync Worker (workers/sync/) runs on Workers Free (10 ms CPU per invocation),
// and an hourly cron usually lands on a cold isolate. Building an Intl formatter at module load
// costs ~15 ms of start-up CPU (ICU time-zone data), which is why 44ac8d0 made every such
// formatter lazy (docs/adr/0001-ads-read-store.md). This guard loads the Worker entry and every
// module it bundles from scratch and fails if anything constructs an Intl object or calls a
// toLocale*String on the way — #27 slipped one back in through a module-scope note.
import { afterEach, describe, expect, it, vi } from 'vitest'

const INTL_CTORS = ['DateTimeFormat', 'NumberFormat', 'Collator', 'PluralRules', 'RelativeTimeFormat', 'ListFormat', 'DisplayNames', 'Segmenter'] as const
const LOCALE_METHODS: [object, string][] = [
  [Date.prototype, 'toLocaleString'],
  [Date.prototype, 'toLocaleDateString'],
  [Date.prototype, 'toLocaleTimeString'],
  [Number.prototype, 'toLocaleString'],
]

describe('gss-stats-sync Worker module load', () => {
  const restore: (() => void)[] = []
  afterEach(() => {
    while (restore.length) restore.pop()!()
  })

  it('constructs no Intl formatter and calls no toLocale*String', async () => {
    const calls: string[] = []
    const intl = Intl as unknown as Record<string, unknown>
    for (const name of INTL_CTORS) {
      const Orig = intl[name] as (new (...a: unknown[]) => unknown) | undefined
      if (typeof Orig !== 'function') continue
      const Spy = function (this: unknown, ...a: unknown[]) {
        calls.push(`Intl.${name}`)
        return new Orig(...a)
      } as unknown as typeof Orig
      Object.assign(Spy, Orig)
      Spy.prototype = Orig.prototype
      intl[name] = Spy
      restore.push(() => {
        intl[name] = Orig
      })
    }
    for (const [proto, m] of LOCALE_METHODS) {
      const spy = vi.spyOn(proto as Record<string, (...a: unknown[]) => unknown>, m)
      restore.push(() => spy.mockRestore())
    }

    vi.resetModules()
    await import('../../workers/sync/src/index')

    for (const [proto, m] of LOCALE_METHODS) {
      const n = (proto as Record<string, { mock?: { calls: unknown[] } }>)[m].mock?.calls.length ?? 0
      for (let i = 0; i < n; i++) calls.push(`${proto === Date.prototype ? 'Date' : 'Number'}.prototype.${m}`)
    }
    expect(calls).toEqual([])
  })
})
