// A tiny, intentionally limited "markdown-lite" for registry note/text bodies (owner
// requirement, 2026-09-26): **bold** and [label](url) links only. Never rendered via v-html
// — parseTextLite tokenizes into plain data (TextToken[]) that NoteBlock.vue/TextBlock.vue
// render through ordinary Vue template bindings (<strong>/<a>), so there is no HTML
// injection surface no matter what a registry entry or a user's custom widget text contains.
export type TextToken = { type: 'text'; value: string } | { type: 'bold'; value: string } | { type: 'link'; value: string; href: string }

const TOKEN_RE = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)]+)\)/g

export function parseTextLite(input: string): TextToken[] {
  const tokens: TextToken[] = []
  let last = 0
  let m: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((m = TOKEN_RE.exec(input))) {
    if (m.index > last) tokens.push({ type: 'text', value: input.slice(last, m.index) })
    if (m[1] !== undefined) tokens.push({ type: 'bold', value: m[1] })
    else if (m[2] !== undefined) tokens.push({ type: 'link', value: m[2], href: m[3] })
    last = TOKEN_RE.lastIndex
  }
  if (last < input.length) tokens.push({ type: 'text', value: input.slice(last) })
  return tokens
}

/** Split a longer text body into paragraphs on a blank line — TextBlock.vue renders one
 * parseTextLite() pass per paragraph. A short note/caveat is always a single paragraph. */
export function splitParagraphs(input: string): string[] {
  return input
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
}

// A var can itself hold nested vars (so "{campaign.label}" can resolve against
// { campaign: { label: 'Launch' } }) — recursive, not just string | number.
export type InterpolateVars = { [key: string]: string | number | null | undefined | InterpolateVars }

/** Data-driven values inside text (owner requirement: "{campaign.spend}" rather than baked
 * into strings) — replaces `{key}` tokens with `vars[key]`, applied BEFORE parseTextLite so
 * an interpolated value can never itself be interpreted as bold/link syntax. An unresolved
 * key is left as-is (visibly wrong rather than silently blank) so a typo'd var name is easy
 * to spot in review. */
export function interpolate(input: string, vars?: InterpolateVars): string {
  if (!vars) return input
  return input.replace(/\{(\w+(?:\.\w+)*)\}/g, (full, key: string) => {
    const v = key.split('.').reduce<any>((acc, k) => (acc == null ? acc : acc[k]), vars)
    return v == null ? full : String(v)
  })
}
