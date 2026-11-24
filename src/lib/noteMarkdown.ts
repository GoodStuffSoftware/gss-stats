// Markdown for budget notes: a small, closed grammar tokenized into plain data (never HTML), rendered
// by components/MarkdownText.vue through ordinary Vue template bindings. Same pattern as
// lib/textLite.ts (ADR 0003: no v-html, no HTML string is ever built), so raw HTML in a note is just
// text by construction.
//
// Supported: paragraphs (blank line) and line breaks; bullet (- * +) and numbered (1. 1)) lists, only
// in a note of two or more lines; **bold**; *italic* / _italic_ only at word edges (so 2*3*4 and a_b_c
// stay literal); `code`; [label](url) and bare http(s) URLs. Not supported, so literal text: headings,
// images, tables, HTML, nesting (a span's content is plain text).
//
// Links: the notes policy is http: and https: only, no relative, no other scheme. The href goes
// through the same normalize-then-allowlist step as textLite.ts's safeHref (strip every control and
// whitespace character from anywhere, classify the normalized value, render the normalized value).
// A link that fails shows as its label text.

export type NoteInline =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; value: string; href: string }

export type NoteBlock =
  | { type: 'p'; lines: NoteInline[][] }
  | { type: 'ul' | 'ol'; items: NoteInline[][] }

/** Normalize a link target for a note: control and whitespace characters stripped from anywhere, then
 * only an `http://` or `https://` address with a host is allowed. Returns the normalized href or null. */
export function safeNoteHref(rawHref: string): string | null {
  const h = rawHref.replace(/[\u0000-\u001F\u007F\s]/g, '')
  if (!/^https?:\/\/[^/?#\\@]/i.test(h)) return null
  if (/[<>"'\\]/.test(h)) return null
  return h
}

const WORD = /[\p{L}\p{N}_]/u
const isWord = (c: string | undefined): boolean => c !== undefined && WORD.test(c)
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c)

// Trailing punctuation that belongs to the sentence, not the address.
const URL_TRAIL = /[.,;:!?)\]}'"]+$/

/** Parse one line (or joined run) of inline markup into tokens. */
export function parseNoteInline(input: string): NoteInline[] {
  const out: NoteInline[] = []
  let buf = ''
  const flush = () => {
    if (buf) out.push({ type: 'text', value: buf })
    buf = ''
  }
  let i = 0
  while (i < input.length) {
    const c = input[i]

    if (c === '`') {
      const m = /^`([^`\n]+)`/.exec(input.slice(i))
      if (m) {
        flush()
        out.push({ type: 'code', value: m[1] })
        i += m[0].length
        continue
      }
    }

    if (c === '[') {
      const m = /^\[([^\]\n]+)\]\(((?:[^()\n]|\([^()\n]*\))+)\)/.exec(input.slice(i))
      if (m) {
        flush()
        const href = safeNoteHref(m[2])
        if (href) out.push({ type: 'link', value: m[1], href })
        else out.push({ type: 'text', value: m[1] })
        i += m[0].length
        continue
      }
    }

    if (c === '*' && input[i + 1] === '*') {
      const m = /^\*\*(?=\S)([^\n]+?)(?<=\S)\*\*/.exec(input.slice(i))
      if (m && !m[1].startsWith('*')) {
        flush()
        out.push({ type: 'bold', value: m[1] })
        i += m[0].length
        continue
      }
    }

    if ((c === '*' || c === '_') && input[i + 1] !== c && input[i - 1] !== c && !isWord(input[i - 1]) && !isSpace(input[i + 1])) {
      let end = -1
      for (let j = i + 2; j < input.length && input[j] !== '\n'; j++) {
        if (input[j] === c && input[j - 1] !== c && !isSpace(input[j - 1]) && input[j + 1] !== c && !isWord(input[j + 1])) {
          end = j
          break
        }
      }
      if (end !== -1) {
        flush()
        out.push({ type: 'italic', value: input.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }

    if ((c === 'h' || c === 'H') && !isWord(input[i - 1])) {
      const m = /^https?:\/\/[^\s\u0000-\u001F\u007F<>]+/i.exec(input.slice(i))
      if (m) {
        const text = m[0].replace(URL_TRAIL, '')
        const href = safeNoteHref(text)
        if (href) {
          flush()
          out.push({ type: 'link', value: text, href })
          i += text.length
          continue
        }
      }
    }

    buf += c
    i++
  }
  flush()
  return out
}

const BULLET_RE = /^\s{0,3}[-*+]\s+(\S.*)$/
const NUMBER_RE = /^\s{0,3}\d{1,9}[.)]\s+(\S.*)$/

/** Parse a whole note into blocks. Lists are recognised only when the note has two or more lines, so a
 * one-line note such as "- x" or "1. x" stays literal text. */
export function parseNoteMarkdown(input: string): NoteBlock[] {
  const text = input.replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '')
  if (!text) return []
  const lines = text.split('\n')
  const multi = lines.length >= 2
  const blocks: NoteBlock[] = []
  let para: NoteInline[][] | null = null
  let list: { type: 'ul' | 'ol'; items: NoteInline[][] } | null = null

  for (const line of lines) {
    if (!line.trim()) {
      para = null
      list = null
      continue
    }
    const bullet = multi ? BULLET_RE.exec(line) : null
    const num = multi && !bullet ? NUMBER_RE.exec(line) : null
    const item = bullet ?? num
    if (item) {
      const kind = bullet ? 'ul' : 'ol'
      if (!list || list.type !== kind) {
        list = { type: kind, items: [] }
        blocks.push(list)
      }
      list.items.push(parseNoteInline(item[1]))
      para = null
      continue
    }
    list = null
    if (!para) {
      const p: NoteBlock = { type: 'p', lines: [] }
      blocks.push(p)
      para = p.lines
    }
    para.push(parseNoteInline(line.trim()))
  }
  return blocks
}
