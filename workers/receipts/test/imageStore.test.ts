import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_KEEP_DAYS, keepDays, kvImageStore, r2ImageStore, selectImageStore } from '../src/imageStore'

// Made-up bytes; in-memory fakes only.
const ab = (v: Uint8Array) => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)
function fakeR2() {
  const m = new Map<string, Uint8Array>()
  const spy = {
    put: vi.fn(async (k: string, v: Uint8Array, _o?: unknown) => { m.set(k, v) }),
    get: vi.fn(async (k: string) => { const v = m.get(k); return v ? { arrayBuffer: async () => ab(v) } : null }),
    delete: vi.fn(async (k: string) => { m.delete(k) }),
  }
  return { bucket: spy as unknown as R2Bucket, spy }
}
function fakeKv() {
  const m = new Map<string, Uint8Array>()
  const spy = {
    put: vi.fn(async (k: string, v: Uint8Array, _o?: unknown) => { m.set(k, v) }),
    get: vi.fn(async (k: string, _t?: string) => { const v = m.get(k); return v ? ab(v) : null }),
    delete: vi.fn(async (k: string) => { m.delete(k) }),
  }
  return { kv: spy as unknown as KVNamespace, spy }
}
const B = Uint8Array.of(1, 2, 3, 255)

describe('selectImageStore', () => {
  it('is null when nothing is bound (the route answers 503)', () => {
    expect(selectImageStore({})).toBeNull()
  })
  it('prefers R2 over KV', async () => {
    const r = fakeR2(); const k = fakeKv()
    const s = selectImageStore({ RECEIPT_IMAGES: r.bucket, RECEIPT_IMAGES_KV: k.kv })!
    await s.put('img/a.jpg', B)
    expect(r.spy.put).toHaveBeenCalled()
    expect(k.spy.put).not.toHaveBeenCalled()
  })
  it('falls back to KV', async () => {
    const k = fakeKv()
    await selectImageStore({ RECEIPT_IMAGES_KV: k.kv })!.put('img/a.jpg', B)
    expect(k.spy.put).toHaveBeenCalled()
  })
})

describe('r2ImageStore', () => {
  it('puts, gets, deletes, and returns null for a missing key', async () => {
    const r = fakeR2(); const s = r2ImageStore(r.bucket)
    await s.put('img/x.jpg', B)
    expect(r.spy.put.mock.calls[0][2]).toEqual({ httpMetadata: { contentType: 'image/jpeg' } })
    expect([...(await s.get('img/x.jpg'))!]).toEqual([...B])
    await s.delete('img/x.jpg')
    expect(await s.get('img/x.jpg')).toBeNull()
  })
})

describe('kvImageStore', () => {
  it('round-trips with an expirationTtl from the keep days', async () => {
    const k = fakeKv(); const s = kvImageStore(k.kv, 30)
    await s.put('img/x.jpg', B)
    expect(k.spy.put.mock.calls[0][2]).toEqual({ expirationTtl: 30 * 86_400 })
    expect([...(await s.get('img/x.jpg'))!]).toEqual([...B])
    await s.delete('img/x.jpg')
    expect(await s.get('img/x.jpg')).toBeNull()
  })
  it('never goes under the 60 s KV minimum', async () => {
    const k = fakeKv(); await kvImageStore(k.kv, 0).put('a', B)
    expect((k.spy.put.mock.calls[0][2] as { expirationTtl: number }).expirationTtl).toBeGreaterThanOrEqual(60)
  })
})

describe('keepDays', () => {
  it('parses, floors and defaults', () => {
    expect(keepDays('30')).toBe(30)
    expect(keepDays('2.9')).toBe(2)
    for (const v of [undefined, '', ' ', 'abc', '0', '-5']) expect(keepDays(v)).toBe(DEFAULT_KEEP_DAYS)
  })
})
