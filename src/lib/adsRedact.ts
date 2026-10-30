// Secret hygiene for everything the ads-read code prints (the local CLIs in scripts/ads-reads/
// and the gss-stats-sync Worker). Runtime-agnostic: no Node imports. Secrets live in memory
// only (see secrets.ts); any string that might carry one — an HTTP error body, a child
// process's stderr — goes through redact() before it reaches stdout, stderr or the JSON
// block. Two layers: exact known secret values, then anything shaped like a credential.

import { stripLocalPaths } from './adsRules'

const known = new Set<string>()

/** Register a secret value so redact() masks it anywhere it appears. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6) known.add(value)
}

/** For tests only. */
export function clearRegisteredSecrets(): void {
  known.clear()
}

// Credential-shaped runs: OAuth access/refresh tokens (ya29., 1//), bearer values, and any
// long unbroken run of token characters. Deliberately greedy — over-masking an error message
// costs a little debuggability, under-masking leaks a key.
const PATTERNS: RegExp[] = [
  /ya29\.[A-Za-z0-9_\-.]+/g,
  /1\/\/[A-Za-z0-9_\-.]+/g,
  /(bearer\s+)[A-Za-z0-9_\-.=+/]+/gi,
  /(developer-token["'\s:=]+)[A-Za-z0-9_\-]+/gi,
  /(refresh_token["'\s:=]+)[A-Za-z0-9_\-./]+/gi,
  /(client_secret["'\s:=]+)[A-Za-z0-9_\-]+/gi,
  /(access_token["'\s:=]+)[A-Za-z0-9_\-.]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /[A-Za-z0-9_\-+/=]{40,}/g,
]

export function redact(input: unknown): string {
  let s = typeof input === 'string' ? input : input instanceof Error ? input.message : String(input)
  for (const v of known) s = s.split(v).join('<redacted>')
  for (const re of PATTERNS) {
    // For the patterns with a capture group, group 1 is the harmless label ("bearer ", …);
    // for the rest the second callback argument is a numeric offset.
    s = s.replace(re, (_m: string, p1: unknown) => (typeof p1 === 'string' ? `${p1}<redacted>` : '<redacted>'))
  }
  return s
}

/** A short, useful reason for a failure summary (review L9): the error's first line without
 * its "<read label>: " prefix, redacted, local paths stripped, whitespace collapsed, capped.
 * Safe to put in a push or a bus copy. */
export function summarizeError(e: unknown, max = 70): string {
  const text = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)
  const line = (text.split(/\r?\n/).find((l) => l.trim()) ?? '').trim()
  const noLabel = line.replace(/^(?:ads|beacon|store|firebase)[\w ()-]*?: /i, '')
  const clean = stripLocalPaths(redact(noLabel)).replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean || 'unknown error'
}

/** First line of a child process's stderr, redacted and capped — enough to say what failed. */
export function redactedFirstLine(text: string, max = 240): string {
  const line = (text || '').split(/\r?\n/).find((l) => l.trim().length > 0) ?? ''
  return redact(line.trim()).slice(0, max)
}

// Known wrangler noise that precedes the real failure on stderr: the "▲ [WARNING] …" banners
// (for example "Proxy environment variables detected") and their indented continuation lines.
const WARNING_HEADER = /^\W*\[?WARNING\]?\b/i
// The version banner (" wrangler 4.x.y") and its dashed rule, printed before anything else.
const BANNER = /^(?:\W*wrangler\b[ \d.]*|[-=]{3,})$/i
const ERROR_HEADER = /^\W*\[?ERROR\]?\b/i
// Cloudflare ids that sit in a failing API path: 32-hex account ids and UUID database ids.
const CF_ID_PATTERNS: RegExp[] = [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, /\b[0-9a-f]{32}\b/gi]

/** The first REAL error line of a failed child process (wrangler): `texts` are tried in order
 * (stderr, then stdout), "[WARNING]" banner blocks and blank lines are skipped, and a bare
 * "[ERROR] …" headline gets the detail line under it appended (the D1 limit text lives there:
 * "… failed.\n\n D1 … daily limit … [code: 7500]"). Redacted, Cloudflare ids masked, capped. Falls
 * back to the first non-blank line when everything is warning noise. */
export function redactedErrorLine(texts: readonly (string | null | undefined)[], max = 240): string {
  let fallback = ''
  for (const text of texts) {
    const lines = (text || '').split(/\r?\n/)
    let inWarning = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) {
        inWarning = false
        continue
      }
      if (BANNER.test(line)) continue
      if (!fallback) fallback = line
      if (WARNING_HEADER.test(line)) {
        inWarning = true
        continue
      }
      if (inWarning && /^\s/.test(lines[i])) continue // the indented body of a warning block
      inWarning = false
      let out = line
      if (ERROR_HEADER.test(line)) {
        const next = lines.slice(i + 1).map((l) => l.trim()).find((l) => l.length > 0)
        if (next && !WARNING_HEADER.test(next)) out = `${line} ${next}`
      }
      return maskIds(redact(out)).slice(0, max)
    }
  }
  return maskIds(redact(fallback)).slice(0, max)
}
function maskIds(s: string): string {
  return CF_ID_PATTERNS.reduce((acc, re) => acc.replace(re, '<id>'), s)
}
