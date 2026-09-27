// The KV backup that functions/api/config.ts takes before a newer layout version overwrites an
// older stored config (see its header). A Map stands in for the STATS_CONFIG namespace.
import { describe, expect, it } from 'vitest'
import { onRequestPut, backupKeyFor } from './config'
import { CONFIG_VERSION } from '../../src/lib/defaults'

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

  it('refuses a save from an OLDER layout version with 409 and a clear message, without touching KV', async () => {
    const newer = JSON.stringify(cfg(9, 'migrated'))
    const { kv, store, puts } = fakeKv({ 'dashboard:default': newer })
    const res = await put(kv, cfg(8, 'old tab'))
    expect(res.status).toBe(409)
    const body: any = await res.json()
    expect(body.message).toMatch(/out of date, reload/)
    expect(puts).toEqual([])
    expect(store.get('dashboard:default')).toBe(newer)
  })

  it('fails closed: if the backup write fails, the stored layout is left untouched', async () => {
    const old = JSON.stringify(cfg(8, 'old'))
    const store = new Map([['dashboard:default', old]])
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        if (k.includes(':backup:')) throw new Error('KV write failed')
        store.set(k, v)
      },
    }
    await expect(put(kv, cfg(9, 'new'))).rejects.toThrow()
    expect(store.get('dashboard:default')).toBe(old)
  })

  it('refuses a version above the code\'s CONFIG_VERSION with 400, so a crafted body cannot lock tabs out', async () => {
    const current = JSON.stringify(cfg(CONFIG_VERSION))
    const { kv, store, puts } = fakeKv({ 'dashboard:default': current })
    const res = await put(kv, { ...cfg(1e9), version: 1e9 })
    expect(res.status).toBe(400)
    expect(puts).toEqual([])
    expect(store.get('dashboard:default')).toBe(current)
    // and a real tab can still save afterwards
    expect((await put(kv, cfg(CONFIG_VERSION, 'real'))).status).toBe(200)
  })

  it('still rejects a body with no pages or widgets, without touching KV', async () => {
    const { kv, puts } = fakeKv({ 'dashboard:default': JSON.stringify(cfg(8)) })
    const res = await put(kv, { version: 9 })
    expect(res.status).toBe(400)
    expect(puts).toEqual([])
  })
})

describe('the v9 → v10 upgrade (metric cards)', () => {
  it('this code writes layout version 10', () => {
    expect(CONFIG_VERSION).toBe(10)
  })
  it('the first v10 save over a stored v9 layout backs it up to backup:v9, once', async () => {
    const v9 = JSON.stringify(cfg(9, 'v9 layout'))
    const { kv, store } = fakeKv({ 'dashboard:default': v9 })
    expect((await put(kv, cfg(10, 'first v10'))).status).toBe(200)
    expect(backupKeyFor(9)).toBe('dashboard:default:backup:v9')
    expect(store.get('dashboard:default:backup:v9')).toBe(v9)
    await put(kv, cfg(10, 'second v10'))
    expect(store.get('dashboard:default:backup:v9')).toBe(v9) // never overwritten
    expect(JSON.parse(store.get('dashboard:default')!).pages[0].tag).toBe('second v10')
  })
  it('a v9 tab saving over a stored v10 layout gets 409; a v11 body gets 400', async () => {
    const { kv, puts } = fakeKv({ 'dashboard:default': JSON.stringify(cfg(10)) })
    expect((await put(kv, cfg(9, 'old tab'))).status).toBe(409)
    expect((await put(kv, cfg(11, 'crafted'))).status).toBe(400)
    expect(puts).toEqual([])
  })
})
