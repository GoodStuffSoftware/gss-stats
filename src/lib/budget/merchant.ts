// Merchant key: the stable identity rules attach to. Derived from the normalized description only.
// Generic: processor and peer-to-peer prefixes are listed by their payment-rail names; no store or
// chain is named here (store-specific behaviour is seed data).

/** Card-processor style prefixes that wrap the real merchant (`SQ *NAME`, `TST* NAME`). */
const PROCESSOR_PREFIXES = new Set(['SQ', 'TST', 'SP', 'PP', 'PAYPAL'])
/** Person-to-person rails: the payee is a person, so no merchant is visible. */
const P2P_PREFIXES = new Set(['VENMO', 'ZELLE', 'CASH APP'])

/** Payment-service rails as a segment of a kebab merchant key (the same rails PROCESSOR_PREFIXES and P2P_PREFIXES name). */
const SERVICE_SEGMENTS = new Set(['paypal', 'venmo', 'zelle', 'cashapp'])

/** True when the key belongs to a payment service (`paypal`, `ach-debit-paypal`, `venmo-<payee>`, `cash-app`): no single
 *  merchant sits behind it, so a rule on it would recategorize every merchant that pays through the service. */
export function isPaymentServiceKey(key: string): boolean {
  const segs = key.toLowerCase().split('-').filter(Boolean)
  return segs.some((s, i) => SERVICE_SEGMENTS.has(s) || (s === 'cash' && segs[i + 1] === 'app'))
}

export interface MerchantKey { key: string; name: string; aggregator: boolean }

/** Rail wording that is not a payee: skipped when looking for the name after a person-to-person prefix. */
const P2P_FILLER = new Set(['PAYMENT', 'PMT', 'PYMT', 'PURCHASE', 'CASHOUT', 'CASH', 'OUT', 'TRANSFER', 'DEPOSIT', 'ACH', 'WEB', 'FROM', 'TO'])

const TLDS = new Set(['COM', 'NET', 'ORG', 'CO', 'CA', 'IO', 'US', 'APP'])

/**
 * A token with digits that is still a name: `EXAMPLE4US`, `7ELEVEN`, `1-800-EXAMPLE.COM`. One group of at most
 * four digits (hyphens may join groups, as in `1-800`), at least five letters and seven characters, vowels in
 * a name-like share, no `*`, `#` or bullet (a bullet starts a masked number glued to the name), and a dot only
 * before a domain ending. A digit may start the token only when it opens the name (`7ELEVEN`, not `1CITY`),
 * and three digits at its end are the area code of a cut-off phone number, not part of the name.
 * Store numbers, terminal codes, phone runs and the random ids that processors append do not pass.
 */
function digitName(tok: string, first: boolean): boolean {
  if (/[*•#]/.test(tok)) return false
  if (!first && /^\d/.test(tok)) return false
  if (/[A-Z]\d{3}$/.test(tok)) return false // a name cut off against the area code of a phone number
  if (tok.includes('.') && !TLDS.has(tok.slice(tok.lastIndexOf('.') + 1))) return false
  const groups = tok.match(/\d+(?:-\d+)*/g) ?? []
  const letters = (tok.match(/[A-Z]/g) ?? []).length
  const vowels = (tok.match(/[AEIOUY]/g) ?? []).length
  return groups.length === 1 && (tok.match(/\d/g) ?? []).length <= 4 && letters >= 5 && letters + (tok.match(/\d/g) ?? []).length >= 7
    && vowels / letters >= 0.25
}

function words(s: string, max = 3): string[] {
  const out: string[] = []
  for (const tok of s.split(/\s+/)) {
    if (out.length >= max) break
    if (!tok || tok.includes('#')) { if (tok.includes('#')) break; continue }
    const w = tok.replace(/[^A-Z0-9]/g, '')
    if (!w) continue
    if (/\d/.test(w)) {
      if (digitName(tok, out.length === 0)) { out.push(w); continue }
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

/** Bank wording after `ACH` that says how money moved, not who it went to. */
const BANK_LEAD = new Set(['DEBIT', 'CREDIT', 'DEPOSIT', 'PAYMENT', 'PMT', 'WITHDRAWAL'])
/** Wording after a processor name that is the processor's own, not a payee. */
const PROCESSOR_FILLER = new Set([...P2P_FILLER, 'RETRY', 'INST', 'XFER', 'INSTANT'])

/**
 * The name shown for a merchant, cleaned beyond what the key needs (the key never changes with it): a web
 * address becomes its brand (`WWW.NAME.COM` is `Name`), bank boilerplate (`ACH DEBIT`) and a processor prefix
 * written without a star (`SP`) are dropped, a processor followed only by its own wording is the processor,
 * and a name the fixed-width field cut off and glued to a repeat of itself keeps one copy. Names the code cannot
 * repair (cut mid-word, a city glued on) stay as printed; the seed can set a display name for those.
 */
function displayWords(s: string): string[] {
  let ws = words(s.replace(/\bWWW\./g, ' ').replace(/\.(?:COM|NET|ORG|CO|CA|IO|US|APP)\b\S*/g, ' '))
  while (ws.length > 2 && ws[0] === 'ACH' && BANK_LEAD.has(ws[1])) ws = ws.slice(2)
  if (ws.length > 1 && PROCESSOR_PREFIXES.has(ws[0]) && ws[0] !== 'PAYPAL') ws = ws.slice(1)
  if (ws.length > 1 && ws[0] === 'PAYPAL' && ws.slice(1).every((w) => PROCESSOR_FILLER.has(w))) ws = ws.slice(0, 1)
  const out: string[] = []
  for (const w0 of ws) {
    let w = w0
    // A word that carries an earlier word (five letters or more) is a truncated copy of it glued on: cut there.
    for (const prev of out) {
      const at = prev.length >= 5 ? w.indexOf(prev) : -1
      if (at >= 0) w = w.slice(0, at)
    }
    // A long word whose own first six letters come back later is the same name run into itself.
    for (let i = 6; i + 6 <= w.length; i++) {
      if (w.startsWith(w.slice(i, i + 6))) { w = w.slice(0, i); break }
    }
    if (w.length >= 3 || (w === w0 && w.length > 0)) out.push(w)
  }
  return out.slice(0, 3)
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
 * and locations are dropped; the first one to three words remain (the name shown is cleaned further, see displayWords). `aggregator` is true when no
 * merchant is visible (a bare processor prefix, a person-to-person rail, or an empty name).
 */
export function merchantKey(clean: string): MerchantKey {
  let s = clean.toUpperCase().trim()
  let prefix: string | null = null
  let bareStar = false
  const star = /^([A-Z][A-Z0-9 ]{0,20}?)(\s*)\*\s*(.*)$/.exec(s)
  if (star) {
    const head = star[1].trim()
    const spaceBefore = star[2].length > 0
    if (PROCESSOR_PREFIXES.has(head) || P2P_PREFIXES.has(head) || spaceBefore) {
      prefix = head
      s = star[3]
      bareStar = s.trim() === ''
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
    // The key keeps the payee, so a rule can target one payee; the name is the rail, so one slice is not made per
    // person (the payee stays in the row's description).
    return { key: kebab(ws), name: title(rail), aggregator: true }
  }
  const ws = words(s)
  if (ws.length === 0) {
    // A processor prefix alone hides the merchant; any other "NAME *" with nothing after the star is the merchant itself.
    if (prefix) { const p = prefix.split(' '); return { key: kebab(p), name: title(p), aggregator: PROCESSOR_PREFIXES.has(prefix) || !bareStar } }
    return { key: 'unknown', name: 'Unknown', aggregator: true }
  }
  const shown = displayWords(s)
  return { key: kebab(ws), name: title(shown.length ? shown : ws), aggregator: false }
}
