// The KV backup that functions/api/config.ts takes before a newer layout version overwrites an
// older stored config (see its header). A Map stands in for the STATS_CONFIG namespace.
import { describe, expect, it } from 'vitest'
import { onRequestPut, backupKeyFor } from './config'
import { CONFIG_VERSION, LAYOUT_VERSIONS } from '../../src/lib/defaults'

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

describe('the v10 → v11 upgrade (the rest of the panels as cards and charts)', () => {
  it('this code writes layout version 11 or later', () => {
    expect(CONFIG_VERSION).toBeGreaterThanOrEqual(11)
  })
  it('the first v11 save over a stored v10 layout backs it up to backup:v10, once', async () => {
    const v10 = JSON.stringify(cfg(10, 'v10 layout'))
    const { kv, store } = fakeKv({ 'dashboard:default': v10 })
    expect((await put(kv, cfg(11, 'first v11'))).status).toBe(200)
    expect(backupKeyFor(10)).toBe('dashboard:default:backup:v10')
    expect(store.get('dashboard:default:backup:v10')).toBe(v10)
    await put(kv, cfg(11, 'second v11'))
    expect(store.get('dashboard:default:backup:v10')).toBe(v10) // never overwritten
    expect(JSON.parse(store.get('dashboard:default')!).pages[0].tag).toBe('second v11')
  })
  it('production is still stored at v8: the first v11 save backs up v8, never a later version', async () => {
    const v8 = JSON.stringify(cfg(8, 'v8 layout'))
    const { kv, store } = fakeKv({ 'dashboard:default': v8 })
    expect((await put(kv, cfg(11, 'first v11'))).status).toBe(200)
    expect(store.get('dashboard:default:backup:v8')).toBe(v8)
    expect([...store.keys()].filter((k) => k.includes('backup'))).toEqual(['dashboard:default:backup:v8'])
  })
  it('a v10 tab saving over a stored v11 layout gets 409; a body above CONFIG_VERSION gets 400', async () => {
    const { kv, puts } = fakeKv({ 'dashboard:default': JSON.stringify(cfg(11)) })
    expect((await put(kv, cfg(10, 'old tab'))).status).toBe(409)
    expect((await put(kv, cfg(CONFIG_VERSION + 1, 'crafted'))).status).toBe(400)
    expect(puts).toEqual([])
  })
})

describe('the v11 → v12 upgrade (the Overview small-sample note takes one grid row)', () => {
  it('this code writes layout version 12 or later', () => {
    expect(CONFIG_VERSION).toBeGreaterThanOrEqual(12)
  })
  it('the first v12 save over a stored v11 layout backs it up to backup:v11; a v11 tab then gets 409', async () => {
    const v11 = JSON.stringify(cfg(11, 'v11 layout'))
    const { kv, store } = fakeKv({ 'dashboard:default': v11 })
    expect((await put(kv, cfg(12, 'first v12'))).status).toBe(200)
    expect(store.get('dashboard:default:backup:v11')).toBe(v11)
    expect((await put(kv, cfg(11, 'old tab'))).status).toBe(409)
    expect((await put(kv, cfg(CONFIG_VERSION + 1, 'crafted'))).status).toBe(400)
  })
})

// Layout version 13 (page navigation: groups, drill parents, icons; the active page per viewer).
// The live dashboard is stored at v12 when this ships: the first v13 save backs it up, and any tab
// still running v12 code must fail safely from then on — refused with 409, KV untouched — never
// overwrite the v13 layout (which would silently undo the migration for everyone).
describe('the v12 → v13 upgrade (page navigation)', () => {
  it('this code writes layout version 13 or later', () => {
    expect(CONFIG_VERSION).toBeGreaterThanOrEqual(LAYOUT_VERSIONS.navigation)
  })
  it('the first v13 save over the stored v12 layout backs it up to backup:v12, once', async () => {
    const v12 = JSON.stringify(cfg(12, 'live v12 layout'))
    const { kv, store, puts } = fakeKv({ 'dashboard:default': v12 })
    expect((await put(kv, cfg(13, 'first v13'))).status).toBe(200)
    expect(puts).toEqual(['dashboard:default:backup:v12', 'dashboard:default'])
    expect(store.get('dashboard:default:backup:v12')).toBe(v12)
    await put(kv, cfg(13, 'second v13'))
    expect(store.get('dashboard:default:backup:v12')).toBe(v12) // never overwritten
  })
  it('an old v12 tab saving over a stored v13 layout gets 409 "out of date, reload", and KV is untouched', async () => {
    const v13 = JSON.stringify(cfg(13, 'migrated'))
    const { kv, store, puts } = fakeKv({ 'dashboard:default': v13 })
    const res = await put(kv, cfg(12, 'old tab'))
    expect(res.status).toBe(409)
    const body: any = await res.json()
    expect(body).toMatchObject({ error: 'stale', storedVersion: 13, incomingVersion: 12 })
    expect(body.message).toMatch(/out of date, reload/)
    expect(puts).toEqual([])
    expect(store.get('dashboard:default')).toBe(v13)
    expect([...store.keys()]).toEqual(['dashboard:default']) // no backup written either
  })
  it('a body claiming a version above CONFIG_VERSION gets 400 and changes nothing', async () => {
    const { kv, puts } = fakeKv({ 'dashboard:default': JSON.stringify(cfg(CONFIG_VERSION)) })
    expect((await put(kv, cfg(CONFIG_VERSION + 1, 'crafted'))).status).toBe(400)
    expect(puts).toEqual([])
  })
})

// Layout version 14 (inline sparklines): a guard bump only, no layout rewrite. Page navigation
// holds 13, so a tab on the nav build (v13) must be refused once a v14 layout is stored.
describe('the v13 → v14 upgrade (inline sparklines: a guard bump, no layout rewrite)', () => {
  it('this code writes layout version 14', () => {
    expect(LAYOUT_VERSIONS.navigation).toBe(13)
    expect(LAYOUT_VERSIONS.sparklines).toBe(14)
    expect(CONFIG_VERSION).toBe(14)
  })
  it('the first v14 save over a stored v13 layout backs it up to backup:v13, once', async () => {
    const v13 = JSON.stringify(cfg(13, 'live v13 layout'))
    const { kv, store, puts } = fakeKv({ 'dashboard:default': v13 })
    expect((await put(kv, cfg(14, 'first v14'))).status).toBe(200)
    expect(puts).toEqual(['dashboard:default:backup:v13', 'dashboard:default'])
    expect(store.get('dashboard:default:backup:v13')).toBe(v13)
    expect(store.get(backupKeyFor(13))).toBe(v13)
    await put(kv, cfg(14, 'second v14'))
    expect(store.get('dashboard:default:backup:v13')).toBe(v13) // never overwritten
  })
  it('a PUT carrying version 13 over a stored v14 layout gets 409, and KV is untouched', async () => {
    const v14 = JSON.stringify(cfg(14, 'sparkline layout'))
    const { kv, store, puts } = fakeKv({ 'dashboard:default': v14 })
    const res = await put(kv, cfg(13, 'nav-build tab'))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'stale', storedVersion: 14, incomingVersion: 13 })
    expect(puts).toEqual([])
    expect(store.get('dashboard:default')).toBe(v14)
    expect([...store.keys()]).toEqual(['dashboard:default'])
    expect((await put(kv, cfg(15, 'crafted'))).status).toBe(400)
  })
})
