// The KV backup that functions/api/config.ts takes before a newer layout version overwrites an
// older stored config (see its header). A Map stands in for the STATS_CONFIG namespace.
import { describe, expect, it } from 'vitest'
import { onRequestPut, backupKeyFor } from './config'

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const puts: string[] = []
  return {
    store,
    puts,
    kv: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        puts.push(k)
        store.set(k, v)
      },
    },
  }
}
async function put(kv: any, body: unknown) {
  const ctx = { request: { text: async () => JSON.stringify(body) }, env: { STATS_CONFIG: kv } } as any
  return onRequestPut(ctx)
}
const cfg = (version: number, tag = '') => ({ version, activePageId: 'x', pages: [{ id: 'x', tag }] })

describe('config PUT backs up the stored config on a version bump', () => {
  it('copies the older config to its backup key before saving the newer one', async () => {
    const old = JSON.stringify(cfg(8, 'old'))
    const { kv, store } = fakeKv({ 'dashboard:default': old })
    const res = await put(kv, cfg(9, 'new'))
    expect(res.status).toBe(200)
    expect(store.get(backupKeyFor(8))).toBe(old)
    expect(JSON.parse(store.get('dashboard:default')!).version).toBe(9)
  })

  it('never overwrites an existing backup, and does nothing on a same-version save', async () => {
    const { kv, store, puts } = fakeKv({ 'dashboard:default': JSON.stringify(cfg(8, 'second')), [backupKeyFor(8)]: 'first' })
    await put(kv, cfg(9))
    expect(store.get(backupKeyFor(8))).toBe('first')
    puts.length = 0
    await put(kv, cfg(9, 'edit'))
    expect(puts).toEqual(['dashboard:default'])
  })

  it('no stored config: just saves', async () => {
    const { kv, puts } = fakeKv()
    await put(kv, cfg(9))
    expect(puts).toEqual(['dashboard:default'])
  })

  it('still rejects a body with no pages or widgets, without touching KV', async () => {
    const { kv, puts } = fakeKv({ 'dashboard:default': JSON.stringify(cfg(8)) })
    const res = await put(kv, { version: 9 })
    expect(res.status).toBe(400)
    expect(puts).toEqual([])
  })
})
