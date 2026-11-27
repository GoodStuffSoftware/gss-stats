import { describe, expect, it } from 'vitest'
import { sanitizeJpeg, MAX_DIMENSION, MAX_SEGMENTS, MIN_OUTPUT_BYTES } from '../src/imageSanitize'

// All bytes are built in code; no real image or EXIF data.
const u = (...n: number[]) => Uint8Array.from(n)
const cat = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((a, b) => a + b.length, 0))
  let at = 0
  for (const x of p) { out.set(x, at); at += x.length }
  return out
}
const seg = (code: number, body: Uint8Array) => cat(u(0xff, code, (body.length + 2) >> 8, (body.length + 2) & 0xff), body)
const text = (s: string) => new TextEncoder().encode(s)
const SOI = u(0xff, 0xd8)
const EOI = u(0xff, 0xd9)
const sof = (w = 64, h = 48, comps = 3, code = 0xc0) => {
  const body = [8, h >> 8, h & 255, w >> 8, w & 255, comps]
  for (let i = 0; i < comps; i++) body.push(i + 1, 0x11, 0)
  return seg(code, Uint8Array.from(body))
}
const sos = (comps = 3) => {
  const body = [comps]
  for (let i = 0; i < comps; i++) body.push(i + 1, 0)
  body.push(0, 63, 0)
  return seg(0xda, Uint8Array.from(body))
}
const scanData = (n = 1500) => {
  const d = new Uint8Array(n)
  for (let i = 0; i < n; i++) d[i] = (i * 31 + 7) % 251 // never 0xff
  d[10] = 0xff; d[11] = 0x00 // a stuffed byte
  return d
}
const DQT = seg(0xdb, new Uint8Array(65).fill(3))
const DHT = seg(0xc4, new Uint8Array(20).fill(1))
interface Parts { pre?: Uint8Array[]; w?: number; h?: number; comps?: number; sofCode?: number; tail?: Uint8Array; scan?: Uint8Array }
function jpeg(p: Parts = {}) {
  return cat(SOI, ...(p.pre ?? []), DQT, sof(p.w, p.h, p.comps, p.sofCode), DHT, sos(p.comps), p.scan ?? scanData(), EOI, p.tail ?? new Uint8Array())
}
const has = (hay: Uint8Array, needle: string) => Buffer.from(hay).includes(needle)
const BAD = { ok: false, code: 'bad_image' }

describe('sanitizeJpeg', () => {
  it('rebuilds a clean JPEG and reports dimensions', () => {
    const r = sanitizeJpeg(jpeg({ w: 640, h: 480 }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect([r.width, r.height]).toEqual([640, 480])
    expect([r.bytes[0], r.bytes[1]]).toEqual([0xff, 0xd8])
    expect([r.bytes.at(-2), r.bytes.at(-1)]).toEqual([0xff, 0xd9])
  })

  it('drops Exif with a GPS IFD, XMP, COM, APP13 and ICC', () => {
    const exif = seg(0xe1, cat(text('Exif\0\0'), text('II*\0'), text('GPSLatitude=12.345 GPSLongitude=67.89')))
    const xmp = seg(0xe1, text('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>FAKE-XMP</x:xmpmeta>'))
    const com = seg(0xfe, text('FAKE-COMMENT'))
    const app13 = seg(0xed, text('Photoshop 3.0\0FAKE-IPTC'))
    const icc = seg(0xe2, text('ICC_PROFILE\0FAKE'))
    const input = jpeg({ pre: [exif, xmp, com, app13, icc] })
    expect(has(input, 'GPSLatitude')).toBe(true)
    const r = sanitizeJpeg(input)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    for (const s of ['GPSLatitude', 'GPSLongitude', 'Exif', 'FAKE-XMP', 'xmpmeta', 'FAKE-COMMENT', 'FAKE-IPTC', 'ICC_PROFILE']) expect(has(r.bytes, s), s).toBe(false)
    expect(r.bytes.length).toBeLessThan(input.length)
  })

  it('drops everything after the first EOI', () => {
    const r = sanitizeJpeg(jpeg({ tail: text('<html><script>alert(1)</script></html>') }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(has(r.bytes, '<html>')).toBe(false)
    expect(has(r.bytes, 'script')).toBe(false)
  })

  it('keeps progressive frames and multiple scans', () => {
    const input = cat(SOI, DQT, sof(64, 48, 3, 0xc2), DHT, sos(), scanData(600), DHT, sos(), scanData(600), EOI)
    const r = sanitizeJpeg(input)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.bytes.length).toBe(input.length)
  })

  it('accepts a grayscale (1 component) image', () => {
    expect(sanitizeJpeg(jpeg({ comps: 1 })).ok).toBe(true)
  })

  it('keeps DRI and restart markers in the scan', () => {
    const scan = cat(scanData(500), u(0xff, 0xd0), scanData(500))
    const input = cat(SOI, DQT, sof(), DHT, seg(0xdd, u(0, 4)), sos(), scan, EOI)
    const r = sanitizeJpeg(input)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.bytes.length).toBe(input.length)
  })

  it('rejects a segment length running past the end', () => {
    expect(sanitizeJpeg(cat(SOI, u(0xff, 0xe1, 0xff, 0xff), text('short')))).toEqual(BAD)
  })

  it('rejects a segment length under 2', () => {
    expect(sanitizeJpeg(cat(SOI, u(0xff, 0xe1, 0, 1), jpeg().subarray(2)))).toEqual(BAD)
  })

  it('rejects a file cut off in the scan or before the EOI', () => {
    const j = jpeg()
    expect(sanitizeJpeg(j.subarray(0, j.length - 400))).toEqual(BAD)
    expect(sanitizeJpeg(j.subarray(0, j.length - 2)).ok).toBe(false)
  })

  it('rejects a missing SOF and a missing SOS', () => {
    expect(sanitizeJpeg(cat(SOI, DQT, DHT, sos(), scanData(), EOI)).ok).toBe(false)
    expect(sanitizeJpeg(cat(SOI, DQT, sof(), DHT, scanData(), EOI)).ok).toBe(false)
  })

  it('rejects odd component counts, zero and oversized dimensions', () => {
    expect(sanitizeJpeg(jpeg({ comps: 4 })).ok).toBe(false)
    expect(sanitizeJpeg(jpeg({ comps: 2 })).ok).toBe(false)
    expect(sanitizeJpeg(jpeg({ w: 0 })).ok).toBe(false)
    expect(sanitizeJpeg(jpeg({ h: 0 })).ok).toBe(false)
    expect(sanitizeJpeg(jpeg({ w: MAX_DIMENSION + 1 })).ok).toBe(false)
    expect(sanitizeJpeg(jpeg({ h: MAX_DIMENSION + 1 })).ok).toBe(false)
    expect(sanitizeJpeg(jpeg({ w: MAX_DIMENSION, h: MAX_DIMENSION })).ok).toBe(true)
  })

  it('rejects arithmetic and lossless frames', () => {
    expect(sanitizeJpeg(jpeg({ sofCode: 0xc9 })).ok).toBe(false)
    expect(sanitizeJpeg(jpeg({ sofCode: 0xc3 })).ok).toBe(false)
  })

  it('rejects more than the segment limit', () => {
    const many = Array.from({ length: MAX_SEGMENTS + 1 }, () => seg(0xfe, u(1)))
    expect(sanitizeJpeg(jpeg({ pre: many })).ok).toBe(false)
    const few = Array.from({ length: 50 }, () => seg(0xfe, u(1)))
    expect(sanitizeJpeg(jpeg({ pre: few })).ok).toBe(true)
  })

  it('rejects output under the minimum size', () => {
    expect(MIN_OUTPUT_BYTES).toBe(1024)
    expect(sanitizeJpeg(jpeg({ scan: scanData(20) })).ok).toBe(false)
  })

  it('rejects a second SOF and a SOS with more components than the frame', () => {
    expect(sanitizeJpeg(cat(SOI, DQT, sof(), sof(), DHT, sos(), scanData(), EOI)).ok).toBe(false)
    expect(sanitizeJpeg(cat(SOI, DQT, sof(64, 48, 1), DHT, sos(3), scanData(), EOI)).ok).toBe(false)
  })

  it('answers bad_type for PNG, WebP, PDF, HEIC, empty, short and text input', () => {
    const png = u(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13)
    const webp = cat(text('RIFF'), u(0, 0, 0, 0), text('WEBPVP8 '))
    const pdf = text('%PDF-1.7\n%fake')
    const heic = cat(u(0, 0, 0, 0x18), text('ftypheic'), new Uint8Array(16))
    for (const b of [png, webp, pdf, heic, new Uint8Array(), u(0xff, 0xd8), text('hello world')]) {
      expect(sanitizeJpeg(b)).toEqual({ ok: false, code: 'bad_type' })
    }
  })

  it('rejects a stray SOI or a 0xFF00 where a marker belongs', () => {
    expect(sanitizeJpeg(cat(SOI, u(0xff, 0xd8), DQT, sof(), DHT, sos(), scanData(), EOI)).ok).toBe(false)
    expect(sanitizeJpeg(cat(SOI, u(0xff, 0x00), DQT, sof(), DHT, sos(), scanData(), EOI)).ok).toBe(false)
  })

  it('handles a large (3 MB) scan without growing it', () => {
    const big = jpeg({ scan: scanData(3_000_000) })
    const r = sanitizeJpeg(big)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.bytes.length).toBeLessThanOrEqual(big.length)
  })
})
