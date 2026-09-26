// A tiny, intentionally limited "markdown-lite" for registry note/text bodies (owner
// requirement, 2026-09-26): **bold** and [label](url) links only. Never rendered via v-html
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
function isSafeHref(href: string): boolean {
  const h = href.trim()
  if (!h) return false
  if (h.startsWith('#')) return true // in-page anchor
  if (h.startsWith('//')) return false // protocol-relative — inherits whatever scheme the page loads over, but still leaves the app; reject
  if (h.startsWith('/')) return true // absolute path, same origin
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return h.toLowerCase().startsWith('https://') // an explicit scheme — https only
  return true // no scheme, no leading slash: a plain relative path/filename
}

/** Tokenize a template into plain data — no interpolation happens here (see
 * tokenizeAndInterpolate below for the safe combined operation). An unsafe link href (see
 * isSafeHref) is neutralised to a plain text token carrying just the link's visible label,
 * never its href — the dangerous URL is dropped, not merely de-activated. */
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
      tokens.push(isSafeHref(m[3]) ? { type: 'link', value: m[2], href: m[3] } : { type: 'text', value: m[2] })
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

/** The ONE safe way to combine markup + data-driven values (owner requirement:
 * "{campaign.spend}" rather than baked into strings). HIGH security fix (2026-09-26 delta
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
  const tokens = parseTextLite(input)
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
