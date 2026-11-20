// Merchant key: the stable identity rules attach to. Derived from the normalized description only.
// Generic: processor and peer-to-peer prefixes are listed by their payment-rail names; no store or
// chain is named here (store-specific behaviour is seed data).

/** Card-processor style prefixes that wrap the real merchant (`SQ *NAME`, `TST* NAME`). */
const PROCESSOR_PREFIXES = new Set(['SQ', 'TST', 'SP', 'PP', 'PAYPAL'])
/** Person-to-person rails: the payee is a person, so no merchant is visible. */
const P2P_PREFIXES = new Set(['VENMO', 'ZELLE', 'CASH APP'])

export interface MerchantKey { key: string; name: string; aggregator: boolean }

/** Rail wording that is not a payee: skipped when looking for the name after a person-to-person prefix. */
const P2P_FILLER = new Set(['PAYMENT', 'PMT', 'PYMT', 'PURCHASE', 'CASHOUT', 'CASH', 'OUT', 'TRANSFER', 'DEPOSIT', 'ACH', 'WEB', 'FROM', 'TO'])

/**
 * A token with digits that is still a name: `EXAMPLE4US`, `7ELEVEN`, `1-800-EXAMPLE.COM`. It has at least four
 * letters, at most four digits in runs of at most three, and no `*`/bullet (a bullet starts a masked number
 * glued to the name). Store numbers, terminal codes and phone or id runs do not pass.
 */
function digitName(tok: string): boolean {
  if (/[*•#]/.test(tok)) return false
  const letters = (tok.match(/[A-Z]/g) ?? []).length
  const digits = (tok.match(/\d/g) ?? []).length
  const longestRun = Math.max(0, ...(tok.match(/\d+/g) ?? []).map((r) => r.length))
  return letters >= 4 && digits <= 4 && longestRun <= 3
}

function words(s: string, max = 3): string[] {
  const out: string[] = []
  for (const tok of s.split(/\s+/)) {
    if (out.length >= max) break
    if (!tok || tok.includes('#')) { if (tok.includes('#')) break; continue }
    const w = tok.replace(/[^A-Z0-9]/g, '')
    if (!w) continue
    if (/\d/.test(w)) {
      if (digitName(tok)) { out.push(w); continue }
      // A digit-bearing token is a store number or address: it ends the name, unless it is the very first
      // token and short (a name that starts with a number).
      if (out.length === 0 && /^\d{1,3}$/.test(w)) { out.push(w); continue }
      if (out.length === 0) continue
      break
    }
    out.push(w)
  }
  return out
}

function title(ws: string[]): string {
  return ws.map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ')
}

function kebab(ws: string[]): string {
  return ws.join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
}

/**
 * A transfer to an account that is not one of the household's has no merchant to name, so its key carries
 * the counterparty's last four: a rule can then say "transfers to this account are X" (shared by every
 * transfer wording, so one account is one key per wording).
 */
export function withCounterparty(m: MerchantKey, last4: string): MerchantKey {
  return { ...m, key: `${m.key}-${last4}` }
}

/**
 * `clean` is the output of normalizeDescription. Prefixes, marketplace `*token` suffixes, store numbers
 * and locations are dropped; the first one to three words remain. `aggregator` is true when no
 * merchant is visible (a bare processor prefix, a person-to-person rail, or an empty name).
 */
export function merchantKey(clean: string): MerchantKey {
  let s = clean.toUpperCase().trim()
  let prefix: string | null = null
  const star = /^([A-Z][A-Z0-9 ]{0,20}?)(\s*)\*\s*(.*)$/.exec(s)
  if (star) {
    const head = star[1].trim()
    const spaceBefore = star[2].length > 0
    if (PROCESSOR_PREFIXES.has(head) || P2P_PREFIXES.has(head) || spaceBefore) {
      prefix = head
      s = star[3]
    }
  }
  if (!prefix) {
    // Bare person-to-person rail without a star ("<RAIL> PAYMENT ...").
    for (const p of P2P_PREFIXES) {
      if (s === p || s.startsWith(p + ' ')) { prefix = p; s = s.slice(p.length).trim(); break }
    }
  }
  // Marketplace tokens: NAME*TOKEN keeps NAME.
  s = s.replace(/\*\S*/g, ' ')
  // A refund line names the merchant it came from: the lead word is not part of the name.
  const unlead = s.replace(/^\s*(?:REFUND|RETURN|REVERSAL|CREDIT)\b(?:\s+(?:OF|FROM))?\s*/, '')
  if (unlead.trim()) s = unlead
  if (prefix && P2P_PREFIXES.has(prefix)) {
    // The payee is the first name word after the rail. Later words are cut off by the fixed-width field and
    // glued to network boilerplate, so they would give one payee several keys. The merchant stays hidden
    // (aggregator), but a rule can now be made per payee.
    const rail = prefix.split(' ')
    const payee = words(s, 6).find((w) => !P2P_FILLER.has(w))
    const ws = payee ? [...rail, payee] : rail
    return { key: kebab(ws), name: title(ws), aggregator: true }
  }
  const ws = words(s)
  if (ws.length === 0) {
    // A processor prefix alone hides the merchant; any other "NAME *" is the merchant itself.
    if (prefix) { const p = prefix.split(' '); return { key: kebab(p), name: title(p), aggregator: PROCESSOR_PREFIXES.has(prefix) } }
    return { key: 'unknown', name: 'Unknown', aggregator: true }
  }
  return { key: kebab(ws), name: title(ws), aggregator: false }
}
