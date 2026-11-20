// Turns a raw statement description into a stable, comparable one plus the facts hiding in it.
// Pure and generic: no bank, merchant or store is named here (those live in the private seed rules).

export interface NormalizedDesc {
  /** Upper-case, single-spaced, boilerplate and ids removed. The input of merchant keys and dedupe keys. */
  clean: string
  /** 'MM-DD' of the purchase when the line says so (card-swipe `DATE 11-05`, `ON 11/05`), else null. */
  purchaseMmdd: string | null
  /** Digits after `#`, exactly as printed (leading zeros kept), else null. */
  storeNo: string | null
  /** What followed the store number, or a trailing city and state code. */
  location: string | null
  /** Last four of a masked or spelled-out counterparty account (`X1234`, `ACCT 12345678`), else null. */
  counterpartyLast4: string | null
  /** A confirmation or reference token embedded in the line, else null. */
  confirmation: string | null
}

const STATE_CODES = new Set(('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY ' +
  'NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC AB BC MB NB NL NS NT NU ON PE QC SK YT').split(' '))

function mmdd(m: string, d: string): string | null {
  const mm = Number(m), dd = Number(d)
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
  return `${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
}

function take(s: string, re: RegExp, fn: (m: RegExpExecArray) => void): string {
  const m = re.exec(s)
  if (!m) return s
  fn(m)
  return s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)
}

export function normalizeDescription(raw: string): NormalizedDesc {
  let s = ' ' + raw.toUpperCase().replace(/\s+/g, ' ').trim() + ' '
  let counterpartyLast4: string | null = null
  let purchaseMmdd: string | null = null
  let confirmation: string | null = null
  let storeNo: string | null = null
  let location: string | null = null

  // Card-swipe prefix `POINT OF SALE DEBIT|CREDIT L### ...`: the terminal code goes, a credit line becomes a
  // REFUND lead word (merchantKey drops it; classifyKind reads it), and the rest of the line is the merchant.
  s = s.replace(/\bPOINT OF SALE\s+CREDIT\b(?:\s+L\d{2,4}\b)?/g, ' REFUND ')
    .replace(/\bPOINT OF SALE\b(?:\s+DEBIT\b)?(?:\s+L\d{2,4}\b)?/g, ' ')
    .replace(/\bL\d{3}\b(?=\s+(?:TIME|DATE)\b)/g, ' ')

  // Counterparty account: masked (X1234, XXXX1234, ****1234, •1234), "ENDING IN 1234", or spelled out.
  s = take(s, /(?:[^A-Z0-9]|^)(?:X+|[*•]+)(\d{4})(?!\d)/, (m) => { counterpartyLast4 = m[1] })
  if (!counterpartyLast4) s = take(s, /\bENDING(?: IN)?\s*(\d{4})(?!\d)/, (m) => { counterpartyLast4 = m[1] })
  if (!counterpartyLast4) {
    s = take(s, /\b(?:ACCT|ACCOUNT|CARD|LOAN)\s*(?:NO\.?|NUMBER|#)?\s*:?\s*(\d{5,})(?!\d)/, (m) => { counterpartyLast4 = m[1].slice(-4) })
  }

  // Purchase date printed in the line (card-swipe boilerplate).
  s = take(s, /\bDATE\s*(\d{1,2})[-/](\d{1,2})(?![\d/])/, (m) => { purchaseMmdd = mmdd(m[1], m[2]) })
  if (!purchaseMmdd) s = take(s, /\bON\s*(\d{1,2})\/(\d{1,2})(?![\d/])/, (m) => { purchaseMmdd = mmdd(m[1], m[2]) })

  // Confirmation / reference tokens.
  s = take(s, /\b(?:CONF(?:IRMATION)?|REF(?:ERENCE)?)\s*(?:NO\.?|NUM(?:BER)?|#)?\s*[:#]?\s*([A-Z0-9]*\d[A-Z0-9]*)\b/, (m) => { confirmation = m[1] })

  // Times, embedded dates, ACH trace and id runs.
  s = s.replace(/\bTIME\s*\d{1,2}[.:]\d{2}(?:[.:]\d{2})?(?:\s*[AP]M\b)?/g, ' ')
    .replace(/\bAT\s*\d{1,2}:\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b(?:ACH\s+)?TRACE\s*(?:NO\.?|NUM(?:BER)?|#)?\s*[:#]?\s*\d+/g, ' ')
    .replace(/\b(?:TRN|IDN|ORIG ID|CO ID|ID)\b\s*[:#]?\s*(?=[A-Z0-9]*\d)[A-Z0-9]{5,}/g, ' ')
  if (!purchaseMmdd) s = take(s, /(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/, (m) => { purchaseMmdd = mmdd(m[1], m[2]) })

  // Card-swipe boilerplate.
  s = s.replace(/\b(?:DEBIT CARD|DEBIT|CHECK ?CARD|CARD)\s+PURCHASE\b/g, ' ')
    .replace(/\bPOS\s+(?:PURCHASE|PUR|DEBIT)\b/g, ' ')
    .replace(/\bPURCHASE\s+AUTHORIZED\s+ON\b/g, ' ')
    .replace(/\bCHECK ?CARD\b/g, ' ')
    .replace(/\bPOS\b/g, ' ')
    .replace(/\bTERM(?:INAL)?\s*(?:ID)?\s*[:#]?\s*[A-Z0-9]*\d[A-Z0-9]*\b/g, ' ')
  s = s.replace(/^\s*PURCHASE\b/, ' ')

  // Phone and domain tails, then any other long digit run (ids).
  s = s.replace(/\(\d{3}\)\s?\d{3}-\d{4}/g, ' ')
    .replace(/\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/g, ' ')
    .replace(/\b\d{6,}\b/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  if (/\s/.test(s)) s = s.replace(/\s+(?:WWW\.)?[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.(?:COM|NET|ORG|CO|CA|IO|US|APP)(?:\/\S*)?$/, '')

  // Store number as printed, and what follows it.
  const sm = /#\s*(\d+)/.exec(s)
  if (sm) {
    storeNo = sm[1]
    const before = s.slice(0, sm.index).trim()
    const after = s.slice(sm.index + sm[0].length).trim()
    if (before) { s = before; location = after || null } else s = after
  } else if (s.indexOf('#') > 0) {
    // A store marker without a number ("NAME # CITY ST"): what follows is the location, not part of the name.
    const at = s.indexOf('#')
    const after = s.slice(at + 1).trim()
    s = s.slice(0, at).trim()
    location = after || null
  } else {
    // Trailing state code: the word before it is taken as the city when enough words remain.
    const words = s.split(' ')
    if (words.length >= 3 && STATE_CODES.has(words[words.length - 1])) {
      const st = words.pop()!
      if (words.length >= 3) location = `${words.pop()!} ${st}`
      else location = st
      s = words.join(' ')
    }
  }
  s = s.replace(/#/g, ' ').replace(/\s+/g, ' ').replace(/[\s,;:-]+$/, '').trim()
  return { clean: s, purchaseMmdd, storeNo, location, counterpartyLast4, confirmation }
}
