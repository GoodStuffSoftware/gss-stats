// Gmail message payload -> bounded plain text for the extraction call (plan: email-receipts section 5, "Body to text").
// Pure and synchronous. Never returns HTML. The text exists only in Worker memory for one call.
//
// Steps: MIME walk (multipart/alternative prefers text/plain, else HTML) -> decode base64url, quoted-printable and
// the declared charset -> HTML to text with a linear scanner (script, style, head and hidden elements dropped) ->
// invisible characters out -> URLs out -> quoted replies and footers cut -> digit runs masked -> whitespace
// collapsed -> capped. Every stage is length-bounded so hostile input cannot make it slow or large.
import { maskDigits } from '../../../src/lib/budget/mask'

export interface GmailHeader {
  name?: string
  value?: string
}
export interface GmailPart {
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { size?: number; data?: string; attachmentId?: string }
  parts?: GmailPart[]
}

/** Characters kept in the text handed to the model. */
export const BODY_TEXT_MAX_CHARS = 12_000
const MAX_PART_B64_CHARS = 1_500_000 // per part, before decoding (about 1.1 MB of bytes)
const MAX_PARTS = 60
const MAX_DEPTH = 10
const PRE_MASK_CHARS = 40_000
const MAX_TAG_CHARS = 4096
const MAX_OPEN_ELEMENTS = 500

// ---------- decoding ----------

function b64urlToBytes(data: string): Uint8Array {
  const s = data.slice(0, MAX_PART_B64_CHARS).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '')
  const padded = s.length % 4 === 1 ? s.slice(0, -1) : s // a lone trailing char cannot be decoded
  try {
    const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return new Uint8Array(0)
  }
}

function header(part: GmailPart, name: string): string {
  const h = part.headers?.find((x) => (x.name ?? '').toLowerCase() === name)
  return (h?.value ?? '').slice(0, 500).toWellFormed()
}

function charsetOf(part: GmailPart): string {
  const m = /charset\s*=\s*"?([A-Za-z0-9_.:-]{1,40})/i.exec(header(part, 'content-type'))
  return m ? m[1] : 'utf-8'
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

/** Quoted-printable over a byte-string (latin1 view). Invalid escapes are left as they are. */
function qpToBytes(bytes: Uint8Array): Uint8Array {
  const out: number[] = []
  const hex = (c: number): number =>
    c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]
    if (c === 61 /* = */) {
      if (bytes[i + 1] === 13 && bytes[i + 2] === 10) {
        i += 2
        continue
      }
      if (bytes[i + 1] === 10) {
        i += 1
        continue
      }
      const h = hex(bytes[i + 1] ?? -1)
      const l = hex(bytes[i + 2] ?? -1)
      if (h >= 0 && l >= 0) {
        out.push(h * 16 + l)
        i += 2
        continue
      }
    }
    out.push(c)
  }
  return Uint8Array.from(out)
}

/** The decoded text of one text/* part. Gmail already undoes the transfer encoding in `body.data`; the headers are
 *  still honoured when the data arrives encoded (quoted-printable, or base64 inside base64url). */
function partText(part: GmailPart): string {
  const data = part.body?.data
  if (!data) return ''
  let bytes = b64urlToBytes(data)
  const cte = header(part, 'content-transfer-encoding').trim().toLowerCase()
  if (cte === 'quoted-printable') {
    bytes = qpToBytes(bytes)
  } else if (cte === 'base64') {
    const asText = new TextDecoder('latin1').decode(bytes.subarray(0, 200_000))
    if (/^[A-Za-z0-9+/=\s]{16,}$/.test(asText) && bytes.length === asText.length) bytes = b64urlToBytes(asText)
  }
  return decodeBytes(bytes, charsetOf(part))
}

// ---------- HTML to text ----------

const RAW_TEXT = new Set(['script', 'style', 'head', 'title', 'noscript', 'template', 'svg', 'iframe', 'object', 'math', 'canvas', 'select', 'textarea'])
const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'wbr', 'area', 'base', 'col', 'embed', 'source', 'track', 'param'])
const BLOCK = new Set(['p', 'div', 'tr', 'li', 'ul', 'ol', 'table', 'section', 'article', 'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'br', 'hr', 'dd', 'dt', 'dl', 'center'])
const CELL = new Set(['td', 'th'])

const HIDDEN_STYLE =
  /display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all|opacity\s*:\s*0(?![.\d])|(?:^|;)\s*(?:max-)?(?:height|width)\s*:\s*0(?:px|pt|em|%)?\s*(?:;|$)|font-size\s*:\s*0(?:px|pt|em|%)?\s*(?:;|$)|(?:^|;)\s*(?:text-indent|left|top)\s*:\s*-\d{3,}/i

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', bull: '*', middot: '.',
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', copy: '(c)', reg: '(R)', trade: '(TM)', euro: 'EUR ', pound: 'GBP ', yen: 'JPY ', cent: 'c',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z]{2,8});/g, (m, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return ''
      return String.fromCodePoint(cp)
    }
    return NAMED[body.toLowerCase()] ?? m
  })
}

interface Tag {
  name: string
  closing: boolean
  selfClosing: boolean
  hidden: boolean
  end: number // index just after '>'
}

/** Parse the tag that starts at html[i] === '<'. Null when it is not a tag or never ends within bounds. */
function parseTag(html: string, i: number): Tag | null | 'unterminated' {
  let j = i + 1
  const closing = html[j] === '/'
  if (closing) j++
  const nameStart = j
  while (j < html.length && j - nameStart < 20 && /[A-Za-z0-9:-]/.test(html[j])) j++
  if (j === nameStart || !/[A-Za-z]/.test(html[nameStart])) return null
  const name = html.slice(nameStart, j).toLowerCase()
  // scan to '>' outside quotes, bounded
  let quote = ''
  const limit = Math.min(html.length, i + MAX_TAG_CHARS)
  let k = j
  for (; k < limit; k++) {
    const c = html[k]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '>') break
  }
  if (k >= limit) return 'unterminated'
  const attrs = html.slice(j, k)
  const selfClosing = attrs.trimEnd().endsWith('/')
  let hidden = false
  if (!closing && attrs.length > 0) {
    if (/(?:^|\s)hidden(?=[\s=/]|$)/i.test(attrs) || /aria-hidden\s*=\s*["']?true/i.test(attrs)) hidden = true
    else {
      const sm = /style\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
      const style = sm ? (sm[1] ?? sm[2] ?? '') : ''
      if (style && HIDDEN_STYLE.test(style.slice(0, 2000))) hidden = true
    }
  }
  return { name, closing, selfClosing, hidden, end: k + 1 }
}

/** HTML to text. Linear scanner: no backtracking regex over the whole input. */
export function htmlToText(html: string): string {
  const src = html.length > 1_500_000 ? html.slice(0, 1_500_000) : html
  const lower = src.toLowerCase()
  const out: string[] = []
  const hiddenStack: string[] = []
  let outLen = 0
  const push = (t: string) => {
    if (!t) return
    out.push(t)
    outLen += t.length
  }
  let i = 0
  while (i < src.length && outLen < PRE_MASK_CHARS * 2) {
    const lt = src.indexOf('<', i)
    if (lt === -1) {
      if (!hiddenStack.length) push(decodeEntities(src.slice(i)))
      break
    }
    if (lt > i && !hiddenStack.length) push(decodeEntities(src.slice(i, lt)))
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      if (end === -1) break
      i = end + 3
      continue
    }
    if (src[lt + 1] === '!' || src[lt + 1] === '?') {
      const end = src.indexOf('>', lt)
      if (end === -1 || end - lt > MAX_TAG_CHARS) break
      i = end + 1
      continue
    }
    const tag = parseTag(src, lt)
    if (tag === 'unterminated') break
    if (tag === null) {
      if (!hiddenStack.length) push('<')
      i = lt + 1
      continue
    }
    i = tag.end
    if (tag.closing) {
      const at = hiddenStack.lastIndexOf(tag.name)
      if (at !== -1) hiddenStack.length = at
      else if (!hiddenStack.length) {
        if (BLOCK.has(tag.name)) push('\n')
        else if (CELL.has(tag.name)) push(' ')
      }
      continue
    }
    if (RAW_TEXT.has(tag.name)) {
      if (!tag.selfClosing) {
        const close = lower.indexOf('</' + tag.name, i)
        if (close === -1) break // never closed: drop the rest
        const gt = src.indexOf('>', close)
        i = gt === -1 ? src.length : gt + 1
      }
      continue
    }
    if (VOID.has(tag.name) || tag.selfClosing) {
      if (!hiddenStack.length && BLOCK.has(tag.name)) push('\n')
      continue
    }
    if (hiddenStack.length || tag.hidden) {
      if (hiddenStack.length >= MAX_OPEN_ELEMENTS) break
      hiddenStack.push(tag.name)
      continue
    }
    if (BLOCK.has(tag.name)) push('\n')
    else if (CELL.has(tag.name)) push(' ')
  }
  return out.join('')
}

// ---------- MIME walk ----------

function looksLikeHtml(s: string): boolean {
  return /<\s*(?:html|body|table|div|p|span|br|td|tr|center|font)[\s>/]/i.test(s.slice(0, 20_000))
}

function isAttachment(part: GmailPart): boolean {
  if (part.filename) return true
  return /^\s*attachment/i.test(header(part, 'content-disposition'))
}

interface Walk {
  parts: number
}

function walk(part: GmailPart, depth: number, w: Walk): string {
  if (depth > MAX_DEPTH || w.parts >= MAX_PARTS) return ''
  w.parts++
  const mime = (part.mimeType ?? '').toLowerCase()
  if (mime.startsWith('multipart/') || (!mime && part.parts)) {
    const kids = (part.parts ?? []).slice(0, MAX_PARTS)
    if (mime === 'multipart/alternative') {
      const plain = kids.find((k) => (k.mimeType ?? '').toLowerCase() === 'text/plain' && !isAttachment(k))
      if (plain) {
        const t = walk(plain, depth + 1, w)
        if (t.trim()) return t
      }
      for (const k of kids) {
        if (k === plain) continue
        const t = walk(k, depth + 1, w)
        if (t.trim()) return t
      }
      return ''
    }
    return kids.map((k) => walk(k, depth + 1, w)).filter((t) => t.trim()).join('\n')
  }
  if (isAttachment(part)) return ''
  if (mime === 'text/plain' || (!mime && part.body?.data)) {
    const t = partText(part)
    return looksLikeHtml(t) ? htmlToText(t) : t
  }
  if (mime === 'text/html') return htmlToText(partText(part))
  return ''
}

// ---------- cleanup ----------

// Control characters, zero-width and bidi controls, soft hyphen, variation selectors, language tags (U+E0000 block,
// used to smuggle hidden instructions), and the private use area. Built from code point ranges (no raw invisible
// characters in the source).
const INVISIBLE_RANGES: Array<[number, number]> = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c],
  [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f],
  [0x3164, 0x3164], [0xe000, 0xf8ff], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff9, 0xfffb],
  [0xe0000, 0xe01ef], [0xf0000, 0x10ffff],
]
const hex = (n: number) => '\\u{' + n.toString(16) + '}'
const INVISIBLE = new RegExp('[' + INVISIBLE_RANGES.map(([a, b]) => hex(a) + '-' + hex(b)).join('') + ']', 'gu')

const URLS = /(?:https?:\/\/|www\.)[^\s<>"')\]]*/gi

const REPLY_MARKERS = [
  /^-{2,}\s*(?:original message|forwarded message)\s*-{2,}\s*$/im,
  /^on .{5,120} wrote:\s*$/im,
]
const FOOTER_MARKERS = [
  /^.{0,60}\bunsubscribe\b/im,
  /^.{0,60}you are receiving this (?:email|message)/im,
  /^.{0,60}manage (?:your )?(?:email )?(?:preferences|subscriptions)/im,
  /^.{0,60}this (?:email|message) was sent to\b/im,
]
const MIN_BEFORE_FOOTER = 200

function cutAtMarkers(text: string): string {
  let cut = text.length
  for (const re of REPLY_MARKERS) {
    const m = re.exec(text)
    if (m && m.index < cut) cut = m.index
  }
  for (const re of FOOTER_MARKERS) {
    const m = re.exec(text)
    if (m && m.index >= MIN_BEFORE_FOOTER && m.index < cut) cut = m.index
  }
  return text.slice(0, cut)
}

function collapse(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Plain text of one Gmail message payload, at most BODY_TEXT_MAX_CHARS characters. Empty string when the message
 *  has no readable text part. Never throws on malformed input. */
export function extractBodyText(payload: GmailPart | null | undefined): string {
  if (!payload || typeof payload !== 'object') return ''
  let raw: string
  try {
    raw = walk(payload, 0, { parts: 0 })
  } catch {
    return ''
  }
  let text = raw.replace(INVISIBLE, '')
  text = text.replace(URLS, '')
  // Entity-decoded markup ("&lt;script&gt;") or tags left in a plain part: never hand tag-like text on.
  text = text.replace(/<\/?[A-Za-z!?][^<>]{0,200}>/g, ' ')
  text = collapse(text.slice(0, PRE_MASK_CHARS * 2))
  text = cutAtMarkers(text).slice(0, PRE_MASK_CHARS)
  text = collapse(maskDigits(text))
  // Every cut above counts UTF-16 units and can split an emoji pair; a lone surrogate makes a strict JSON parser reject the whole request.
  return (text.length > BODY_TEXT_MAX_CHARS ? text.slice(0, BODY_TEXT_MAX_CHARS) : text).toWellFormed()
}
