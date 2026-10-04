// A tiny, intentionally limited "markdown-lite" for registry note/text bodies and chart captions
// (Widget.caption): **bold** and [label](url) links only, plus `{=…}` value tokens (shown as a dash
// until slice 1d fills them). Never rendered via v-html
// — parseTextLite tokenizes into plain data (TextToken[]) that NoteBlock.vue/TextBlock.vue
// render through ordinary Vue template bindings (<strong>/<a>), so there is no HTML
// injection surface no matter what a registry entry or a user's custom widget text contains.
export type TextToken = { type: 'text'; value: string } | { type: 'bold'; value: string } | { type: 'link'; value: string; href: string }

const TOKEN_RE = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)]+)\)/g

// HIGH security fix (2026-09-26 delta review): a link href with no scheme allowlist renders
// ANY scheme as a live, clickable anchor — including `javascript:`/`vbscript:` (arbitrary
// script execution on click), `data:` (can smuggle an inline HTML/script document), and a
// protocol-relative `//host` (silently leaves the site). Only https: and same-origin
// relative targets (an absolute path, a hash, or a plain relative path with no scheme) are
// ever rendered as a real `<a href>` — everything else, including plain `http:` (registry
// text should never need it), is neutralised to plain text: the link survives as readable
// content, but is never a clickable/navigable element pointing somewhere unsafe.
//
// HIGH follow-up fix (2026-09-26, second review): the first version above did a scheme
// check on the TRIMMED-only href, and `.trim()` only strips whitespace from the two ends —
// it does nothing to a C0 control character (\u0000-\u001F, \u007F) or to one embedded in
// the MIDDLE of the string. Browsers strip ASCII tab/newline/CR from a URL before parsing
// its scheme (a WHATWG URL-parsing quirk), so `[x](java\tscript:alert(1))` or
// `[x](java\nscript:alert(1))` read as inert text to a naive `/^[a-z][a-z0-9+.-]*:/i` check
// but are a live `javascript:` URL to the browser; a leading \u0001 or an embedded CR is the
// same trick. Rewritten as strip-then-strict-allowlist instead of an unsafe-pattern
// blocklist: normalize the ENTIRE string first (strip every control character and every
// whitespace character from anywhere in it, not just the ends), then classify the
// NORMALIZED value against an explicit allowlist, and render that normalized value — never
// the raw one — so a control character can never survive into the actual `href` either.
//
// Value tokens (slice 1c review, NIT-3): an href holding `{` or `}`, or the marker that
// tokenizeAndInterpolate puts where a `{=…}` stood (VALUE_TOKEN_MARK), is never a link. A value
// token therefore cannot reach an href by construction, whatever slice 1d substitutes.
function safeHref(rawHref: string): string | null {
  const h = rawHref.replace(/[\u0000-\u001F\u007F\s]/g, '')
  if (!h) return null
  if (/[{}]/.test(h) || h.includes(VALUE_TOKEN_MARK)) return null
  if (h.toLowerCase().startsWith('https://')) return h // https: only, and only the real double-slash form (bare "https:evil.com" is NOT this — some URL parsers normalize it to https://evil.com, so it must fail every branch below too)
  if (h.startsWith('#')) return h // in-page anchor
  if (h.startsWith('/')) {
    // Anything slash-prefixed is EITHER a safe same-origin absolute path, or an attempt at
    // a protocol-relative (//host) or backslash-confusable (/\host, which some URL parsers
    // also treat as protocol-relative) target — decide it right here and never let it fall
    // through to the more permissive bare-relative-path branch below, which would otherwise
    // wrongly accept "//evil.com" (its characters are all individually charset-legal).
    return h.startsWith('//') || h.startsWith('/\\') ? null : h
  }
  // A bare relative path/filename: no leading slash, no scheme at all. Reject up front if a
  // ':' appears before the first path delimiter (catches a disguised/partial scheme even
  // before the charset check below would); then require the WHOLE value to be built only
  // from an explicit safe charset — no ':', no '\', nothing left that any parser could
  // reinterpret as a scheme or a protocol-relative target.
  const firstDelim = h.search(/[/?#]/)
  const schemeCandidate = firstDelim === -1 ? h : h.slice(0, firstDelim)
  if (schemeCandidate.includes(':')) return null
  return /^[A-Za-z0-9._~/-]+$/.test(h) ? h : null
}

/** Tokenize a template into plain data — no interpolation happens here (see
 * tokenizeAndInterpolate below for the safe combined operation). An unsafe link href (see
 * safeHref) is neutralised to a plain text token carrying just the link's visible label,
 * never its href — the dangerous URL is dropped, not merely de-activated. A SAFE href is
 * rendered as the value safeHref returned (the normalized one), never the raw captured
 * group — a control character or stray whitespace inside an otherwise-safe URL must not
 * survive into the actual `href` either. */
export function parseTextLite(input: string): TextToken[] {
  const tokens: TextToken[] = []
  let last = 0
  let m: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((m = TOKEN_RE.exec(input))) {
    if (m.index > last) tokens.push({ type: 'text', value: input.slice(last, m.index) })
    if (m[1] !== undefined) {
      tokens.push({ type: 'bold', value: m[1] })
    } else if (m[2] !== undefined) {
      const href = safeHref(m[3])
      tokens.push(href !== null ? { type: 'link', value: m[2], href } : { type: 'text', value: m[2] })
    }
    last = TOKEN_RE.lastIndex
  }
  if (last < input.length) tokens.push({ type: 'text', value: input.slice(last) })
  return tokens
}

/** Split a longer text body into paragraphs on a blank line — TextBlock.vue tokenizes each
 * paragraph separately. A short note/caveat is always a single paragraph. Pure whitespace
 * splitting on the RAW template, before any tokenizing/interpolation — safe regardless. */
export function splitParagraphs(input: string): string[] {
  return input
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
}

// A var can itself hold nested vars (so "{campaign.label}" can resolve against
// { campaign: { label: 'Launch' } }) — recursive, not just string | number.
export type InterpolateVars = { [key: string]: string | number | null | undefined | InterpolateVars }

function substituteVars(str: string, vars: InterpolateVars): string {
  return str.replace(/\{(\w+(?:\.\w+)*)\}/g, (full, key: string) => {
    const v = key.split('.').reduce<any>((acc, k) => (acc == null ? acc : acc[k]), vars)
    return v == null ? full : String(v)
  })
}

/** A value token (`{=…}`, notes plan slice 1d "Insert value"). This build has no values to put
 * there yet, so every token shows VALUE_TOKEN_PLACEHOLDER: a caption written by a newer build
 * shows a dash here, never the raw token text. */
export const VALUE_TOKEN_RE = /\{=[^{}]*\}/g
export const VALUE_TOKEN_PLACEHOLDER = '—'
/** Where a value token stood, between tokenizing and rendering: a private-use character that holds
 * no markup. tokenizeAndInterpolate swaps every `{=…}` for it in the RAW input, before
 * parseTextLite, so a token that wraps markup (`{=**x**}`, `{=[a](https://x)}`) stays one unit
 * and never shows as raw text; safeHref refuses an href holding it; and each token's visible text
 * then shows VALUE_TOKEN_PLACEHOLDER in its place. */
const VALUE_TOKEN_MARK = ''

/** The ONE safe way to combine markup + data-driven values ("{campaign.spend}" rather than
 * values baked into strings). HIGH security fix (2026-09-26 delta
 * review): this used to interpolate {vars} into the RAW STRING first and tokenize the
 * result second — so a var whose VALUE happened to contain "**x**" or
 * "[y](javascript:...)" became live markup, exactly the injection parseTextLite's own
 * token-based rendering exists to prevent. Reversed: tokenize the template FIRST (so the
 * markup structure is fixed before any variable data is considered), then substitute
 * {vars} placeholders ONLY inside plain 'text' tokens — never inside a bold/link token's
 * own captured value/href, and never by re-scanning the substituted result for new markup.
 * A registry/custom-text author therefore cannot put a variable inside **bold** or a
 * [link](...) — an accepted limitation; no current registry entry needs that, and it's the
 * only way to make "a variable's value can never introduce markup" categorically true
 * rather than best-effort. */
export function tokenizeAndInterpolate(input: string, vars?: InterpolateVars): TextToken[] {
  // Value tokens first, on the raw input and before {vars}: each `{=…}` becomes one marker that
  // holds no markup (VALUE_TOKEN_MARK), so a token wrapping markup cannot split, and a link whose
  // URL held one is plain text (safeHref). The marker then shows as the placeholder in every
  // token's visible text (a bold or a link label too). A var's own value is never rewritten.
  // The marker is reserved: a literal one in the input (pasted private-use text) is dropped first,
  // so it can never show as the placeholder.
  const marked = input.split(VALUE_TOKEN_MARK).join('').replace(VALUE_TOKEN_RE, VALUE_TOKEN_MARK)
  const tokens = parseTextLite(marked).map((t) => ({ ...t, value: t.value.split(VALUE_TOKEN_MARK).join(VALUE_TOKEN_PLACEHOLDER) }))
  if (!vars) return tokens
  return tokens.map((t) => (t.type === 'text' ? { ...t, value: substituteVars(t.value, vars) } : t))
}

/** Plain-text rendering for call sites that can't render TextToken[] (a `:title`
 * attribute, a bare `{{ }}` interpolation, a table cell) — tokenizes + interpolates via
 * tokenizeAndInterpolate, then flattens back to a plain string with every markup
 * character/href stripped (a bold segment keeps only its text; a link keeps only its
 * visible label, never its href). This is how registry text with bold/link markup reaches
 * a plain-string context without ever leaking raw markup syntax as literal on-screen text. */
export function toPlainText(input: string, vars?: InterpolateVars): string {
  return tokenizeAndInterpolate(input, vars)
    .map((t) => t.value)
    .join('')
}
