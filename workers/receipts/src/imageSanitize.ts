// Receipt photo upload: the server-side JPEG rebuild (plan: receipt image upload, section 4).
// An ALLOWLIST rebuild, stricter than a blocklist stripper: the output holds only SOI, the kept segments (SOF0/1/2, DQT,
// DHT, DRI, SOS) with their scan data, and one EOI. Every APPn (Exif/GPS, XMP, ICC, IPTC), COM and unknown marker is
// dropped, and so is everything after the first EOI (appended HTML, ZIP or script polyglots). Every length is bounds
// checked. No decoding: a malformed scan is not detected here, only malformed structure.
// Never logs; a result carries a fixed code only.

export type SanitizeCode = 'bad_type' | 'bad_image'
export type SanitizeResult = { ok: true; bytes: Uint8Array; width: number; height: number } | { ok: false; code: SanitizeCode }

export const MAX_DIMENSION = 4096
export const MAX_SEGMENTS = 200
export const MIN_OUTPUT_BYTES = 1024

const bad = (): SanitizeResult => ({ ok: false, code: 'bad_image' })

/** Markers whose segments are kept, verbatim. */
const KEEP = new Set([0xc4 /* DHT */, 0xdb /* DQT */, 0xdd /* DRI */])
/** SOF markers allowed: baseline, extended sequential (8-bit only, checked below), progressive. Huffman only. */
const SOF_OK = new Set([0xc0, 0xc1, 0xc2])
/** Every other SOFn (lossless, differential, arithmetic): rejected, not dropped. */
const SOF_REJECT = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

export function sanitizeJpeg(input: Uint8Array): SanitizeResult {
  const n = input.length
  if (n < 4 || input[0] !== 0xff || input[1] !== 0xd8 || input[2] !== 0xff) return { ok: false, code: 'bad_type' }

  const out: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)]
  let pos = 2
  let segments = 0
  let sofSeen = false
  let sosSeen = false
  let width = 0
  let height = 0
  let components = 0
  let eoi = false

  while (pos < n) {
    // A marker: FF, any number of FF fill bytes, then the marker code.
    if (input[pos] !== 0xff) return bad()
    let m = pos + 1
    while (m < n && input[m] === 0xff) m++
    if (m >= n) return bad()
    const code = input[m]
    const start = m - 1 // the FF directly before the code
    if (code === 0x00) return bad()
    if (code === 0xd9) { eoi = true; break }
    if (code === 0xd8 || code === 0x01 || (code >= 0xd0 && code <= 0xd7)) return bad() // no standalone marker belongs here
    if (++segments > MAX_SEGMENTS) return bad()
    if (m + 2 >= n) return bad()
    const len = (input[m + 1] << 8) | input[m + 2]
    if (len < 2 || m + 1 + len > n) return bad()
    const end = m + 1 + len // exclusive
    const body = m + 3 // first byte after the length

    if (SOF_REJECT.has(code)) return bad()
    if (SOF_OK.has(code)) {
      if (sofSeen || sosSeen || len < 8) return bad()
      const precision = input[body]
      height = (input[body + 1] << 8) | input[body + 2]
      width = (input[body + 3] << 8) | input[body + 4]
      components = input[body + 5]
      if (precision !== 8) return bad()
      if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) return bad()
      if ((components !== 1 && components !== 3) || len !== 8 + 3 * components) return bad()
      sofSeen = true
      out.push(input.subarray(start, end))
      pos = end
    } else if (code === 0xda) {
      // SOS: needs a frame first; its component count must fit the frame; then the entropy-coded data up to the next marker.
      if (!sofSeen || len < 6) return bad()
      const ns = input[body]
      if (ns < 1 || ns > components || len !== 6 + 2 * ns) return bad()
      sosSeen = true
      let j = end
      while (j < n) {
        const f = input.indexOf(0xff, j)
        if (f === -1) { j = n; break }
        const next = f + 1 < n ? input[f + 1] : -1
        if (next === -1) return bad()
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { j = f + 2; continue }
        if (next === 0xff) { j = f + 1; continue } // fill byte: the real marker follows
        j = f
        break
      }
      if (j >= n) return bad() // the scan ran off the end: truncated
      out.push(input.subarray(start, j))
      pos = j
    } else if (KEEP.has(code)) {
      out.push(input.subarray(start, end))
      pos = end
    } else {
      pos = end // APPn, COM, DNL, JPGn, anything unknown: dropped
    }
  }

  if (!eoi || !sofSeen || !sosSeen) return bad()
  out.push(Uint8Array.of(0xff, 0xd9))
  let total = 0
  for (const p of out) total += p.length
  if (total < MIN_OUTPUT_BYTES || total > n) return bad()
  const bytes = new Uint8Array(total)
  let at = 0
  for (const p of out) { bytes.set(p, at); at += p.length }
  return { ok: true, bytes, width, height }
}
