import { beforeAll, describe, expect, it } from 'vitest'
import { ImportError, extendContext, planImport, planImportDetailed } from './import'
import { ACCOUNTS, CARD_ROWS, CHECKING_ROWS, SEED, emptyContext, row, seedRules, syntheticRequest } from './__fixtures__/synthetic'
import { dedupeKey } from './dedupe'
import { hasLongDigitRun } from './mask'
import { normalizeDescription } from './normalize'
import { SPENDING_KINDS, type ImportRequest, type MerchantRule, type TxnInsert } from './types'

const NOW = '2026-12-05T10:00:00.000Z'
let rules: MerchantRule[]
beforeAll(async () => { rules = await seedRules() })

const plan = (req = syntheticRequest(), ctx = emptyContext()) => planImport(req, ctx, 'tester@example.com', NOW)
const find = (txns: TxnInsert[], account: string, date: string, cents: number, text?: string) =>
  txns.find((t) => t.accountId === account && t.postedDate === date && t.amountCents === cents && (!text || t.description.includes(text)))!

describe('planImport on the synthetic statements', () => {
  it('turns every row into a transaction and carries the facts and the seed', async () => {
    const p = await plan()
    expect(p.rowsIn).toBe(CHECKING_ROWS.length + 2 + CARD_ROWS.length)
    expect(p.txns.length).toBe(p.rowsIn)
    expect(p.statements).toHaveLength(3)
    expect(p.statements[2]).toMatchObject({ accountId: 'card-a', closingBalanceCents: 18_000, dueDate: '2026-12-29' })
    expect(p.statements[0]).not.toHaveProperty('rows')
    expect(p.people).toEqual(SEED.people)
    expect(p.rules).toHaveLength(SEED.rules!.length)
    expect(p.createdBy).toBe('tester@example.com')
    expect(new Set(p.txns.map((t) => t.id)).size).toBe(p.txns.length)
    for (const t of p.txns) expect(t.id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('masks descriptions: no run of 5+ digits survives', async () => {
    const p = await plan()
    for (const t of p.txns) expect(hasLongDigitRun(t.description)).toBe(false)
    expect(find(p.txns, 'chk-a', '2026-11-10', 250_000).description).toBe('PAYROLL EXAMPLE EMPLOYER ID: •3210')
  })

  it('masks a grouped account number in the stored description and leaves the id and merchant alone', async () => {
    const one = (desc: string): ImportRequest => ({ importId: 'imp-g', sourceLabel: 's', seed: SEED, statements: [
      { accountId: 'chk-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: [row('2026-11-12', -700, desc)] }] })
    const grouped = (await plan(one('PAYMENT TO ACCT 1234 5678 9012 3456'))).txns[0]
    expect(grouped.description).toBe('PAYMENT TO ACCT •3456')
    expect(grouped.description).not.toMatch(/1234|5678|9012/)
    // The id and merchant come from the normalized text, not the stored description: masking changes neither.
    const expected = await dedupeKey({ accountId: 'chk-a', postedDate: '2026-11-12', amountCents: -700,
      clean: normalizeDescription('PAYMENT TO ACCT 1234 5678 9012 3456').clean, occurrence: 0 })
    expect(grouped.id).toBe(expected)
    expect(grouped.merchantKey).not.toMatch(/\d/)
    expect(grouped.merchantName).not.toMatch(/\d/)
  })

  it('numbers same-day repeats so they get distinct ids', async () => {
    const p = await plan()
    const coffees = p.txns.filter((t) => t.accountId === 'chk-a' && t.postedDate === '2026-11-20')
    expect(coffees).toHaveLength(2)
    expect(coffees[0].id).not.toBe(coffees[1].id)
  })

  it('infers the purchase year from the posted date, across Dec/Jan', async () => {
    const p = await plan()
    expect(find(p.txns, 'card-a', '2026-12-01', -1200).txnDate).toBe('2026-11-28')
    const jan: ImportRequest = { importId: 'imp-jan', sourceLabel: 'synthetic', statements: [
      { accountId: 'card-a', periodStart: '2026-12-05', periodEnd: '2027-01-04', rows: [row('2027-01-03', -800, 'DATE 12-30 POS DEBIT BRAMBLEWOOD MARKET #0412'),
        row('2027-01-04', -900, 'DATE 01-02 POS DEBIT BRAMBLEWOOD MARKET #0412')] }] }
    const q = await plan(jan)
    expect(q.txns.map((t) => t.txnDate)).toEqual(['2026-12-30', '2027-01-02'])
  })

  it('chain X: the store number picks fuel or groceries, an unknown store is flagged', async () => {
    const p = await plan()
    const fuel = find(p.txns, 'chk-a', '2026-11-03', -6200)
    const groc = find(p.txns, 'chk-a', '2026-11-04', -8400)
    const unknown = find(p.txns, 'chk-a', '2026-11-05', -1850)
    expect(fuel).toMatchObject({ merchantKey: 'chain-x', storeNo: '1001', categoryId: 'fuel', categorySource: 'rule', needsReview: false, merchantName: 'Chain X Fuel' })
    expect(groc).toMatchObject({ storeNo: '2002', categoryId: 'groceries', categorySource: 'rule', needsReview: false })
    expect(unknown).toMatchObject({ storeNo: '9999', categoryId: 'groceries', needsReview: true, reviewReason: 'ambiguous_store' })
    expect(unknown.confidence).toBeLessThan(fuel.confidence)
  })

  it('chain X amount band: inside is fuel, outside falls back and is flagged', async () => {
    const p = await plan()
    expect(find(p.txns, 'chk-a', '2026-11-07', -9000)).toMatchObject({ categoryId: 'fuel', needsReview: false })
    expect(find(p.txns, 'chk-a', '2026-11-06', -300)).toMatchObject({ needsReview: true })
    const out = find(p.txns, 'chk-a', '2026-11-19', -45_000)
    expect(out).toMatchObject({ categoryId: 'other', needsReview: true, reviewReason: 'amount_out_of_band' })
    expect(find(p.txns, 'chk-a', '2026-11-18', -3000)).toMatchObject({ categoryId: 'shopping', needsReview: false })
  })

  it('a rule with set_kind spend and a debt account makes a debt payment spending in its category', async () => {
    const p = await plan()
    const t = find(p.txns, 'chk-a', '2026-11-15', -120_000)
    expect(t).toMatchObject({ kind: 'spend', kindSource: 'rule', categoryId: 'housing', categorySource: 'rule', debtAccountId: 'mtg', needsReview: false })
    expect(SPENDING_KINDS).toContain(t.kind)
  })

  it('transfers, overdraft moves and card payments never land in SPENDING_KINDS; refunds stay refunds', async () => {
    const p = await plan()
    const out = [find(p.txns, 'chk-a', '2026-11-12', -20_000), find(p.txns, 'card-a', '2026-11-12', 20_000), find(p.txns, 'chk-a', '2026-11-14', -50_000),
      find(p.txns, 'sav-a', '2026-11-14', 50_000), find(p.txns, 'chk-a', '2026-11-25', 3500), find(p.txns, 'sav-a', '2026-11-25', -3500)]
    for (const t of out) expect(SPENDING_KINDS).not.toContain(t.kind)
    expect(out.map((t) => t.kind)).toEqual(['card_payment', 'card_payment', 'transfer', 'transfer', 'overdraft_move', 'overdraft_move'])
    expect(find(p.txns, 'card-a', '2026-11-22', 2300).kind).toBe('refund')
    expect(find(p.txns, 'card-a', '2026-11-28', -1900).kind).toBe('interest_charged')
    expect(SPENDING_KINDS).not.toContain('interest_charged')
    expect(find(p.txns, 'chk-a', '2026-11-28', -1500)).toMatchObject({ kind: 'fee', categoryId: 'fees' })
  })

  it('pairs the two sides of each own-account move and nothing else', async () => {
    const p = await plan()
    expect(p.pairs).toHaveLength(3)
    const byId = new Map(p.txns.map((t) => [t.id, t]))
    for (const [a, b] of p.pairs) {
      expect(byId.get(a)!.pairId).toBe(b)
      expect(byId.get(b)!.pairId).toBe(a)
      expect(byId.get(a)!.amountCents).toBe(-byId.get(b)!.amountCents)
      expect(byId.get(a)!.accountId).not.toBe(byId.get(b)!.accountId)
    }
    expect(p.txns.filter((t) => t.pairId !== null)).toHaveLength(6)
  })

  it('flags a hidden merchant and an uncategorised spend', async () => {
    const p = await plan()
    expect(find(p.txns, 'card-a', '2026-11-29', -9900)).toMatchObject({ needsReview: true, reviewReason: 'hidden_merchant' })
    expect(find(p.txns, 'chk-a', '2026-11-02', -4500)).toMatchObject({ needsReview: true, reviewReason: 'low_confidence' })
  })

  it('a line taken for spending that pairs with a card payment becomes a transfer and drops its category', async () => {
    const req: ImportRequest = { importId: 'imp-p', sourceLabel: 'synthetic', statements: [
      { accountId: 'chk-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: [row('2026-11-12', -7777, 'PAYMENT SAMPLE CARD SERVICES')] },
      { accountId: 'card-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: [row('2026-11-13', 7777, 'PAYMENT THANK YOU')] }] }
    const p = await plan(req)
    const chk = p.txns.find((t) => t.accountId === 'chk-a')!
    expect(chk).toMatchObject({ kind: 'transfer', categoryId: null, categorySource: 'none', needsReview: false })
    expect(chk.pairId).toBe(p.txns.find((t) => t.accountId === 'card-a')!.id)
  })
})

describe('precedence: rule and manual rows are never re-paired or re-kinded', () => {
  it('a rule-kinded spend is not a pairing candidate, in one plan or the next', async () => {
    const req: ImportRequest = { importId: 'imp-r', sourceLabel: 'synthetic', seed: SEED, statements: [
      { accountId: 'chk-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: [row('2026-11-15', -120_000, 'HOMESTEAD LENDING PMT ACCT X0006')] },
      { accountId: 'loan-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: [row('2026-11-15', 120_000, 'PAYMENT RECEIVED')] }] }
    const p = await plan(req)
    expect(p.pairs).toEqual([])
    expect(p.txns.map((t) => t.pairId)).toEqual([null, null])
    expect(p.txns[0]).toMatchObject({ kind: 'spend', kindSource: 'rule' })

    // The same two rows arriving in separate plans through one shared context behave the same.
    const first = await plan({ ...req, importId: 'imp-r1', statements: [req.statements[0]] })
    const ctx = extendContext(emptyContext(), first)
    const second = await plan({ importId: 'imp-r2', sourceLabel: 'synthetic', statements: [req.statements[1]] }, { ...ctx, rules })
    expect(second.pairs).toEqual([])
    expect(second.txns[0].pairId).toBeNull()
  })

  it('open candidates from the context pair with new rows, and the new row says so', async () => {
    const ctx = emptyContext({ pairCandidates: [{ id: 'ctx-1', accountId: 'sav-a', postedDate: '2026-11-14', amountCents: 50_000, kind: 'transfer', counterpartyLast4: null, pairId: null }] })
    const req: ImportRequest = { importId: 'imp-c', sourceLabel: 'synthetic', statements: [
      { accountId: 'chk-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: [row('2026-11-14', -50_000, 'TRANSFER TO SAVINGS X0002')] }] }
    const p = await plan(req, ctx)
    expect(p.pairs).toEqual([[p.txns[0].id, 'ctx-1'].sort()])
    expect(p.txns[0].pairId).toBe('ctx-1')
  })

  it('a paired context row is left alone', async () => {
    const ctx = emptyContext({ pairCandidates: [{ id: 'ctx-1', accountId: 'sav-a', postedDate: '2026-11-14', amountCents: 50_000, kind: 'transfer', counterpartyLast4: null, pairId: 'other' }] })
    const req: ImportRequest = { importId: 'imp-c', sourceLabel: 'synthetic', statements: [
      { accountId: 'chk-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: [row('2026-11-14', -50_000, 'TRANSFER TO SAVINGS X0002')] }] }
    expect((await plan(req, ctx)).pairs).toEqual([])
  })
})

describe('de-duplication and determinism', () => {
  it('the id set does not depend on the order of rows or of statements', async () => {
    const base = await plan()
    const req = syntheticRequest()
    const shuffled: ImportRequest = { ...req, statements: [...req.statements].reverse().map((s) => ({ ...s, rows: [...s.rows].reverse() })) }
    const other = await plan(shuffled)
    expect(other.txns.map((t) => t.id).sort()).toEqual(base.txns.map((t) => t.id).sort())
    expect(other.pairs).toEqual(base.pairs)
    const kinds = (p: typeof base) => Object.fromEntries(p.txns.map((t) => [t.id, [t.kind, t.categoryId, t.needsReview, t.pairId]]))
    expect(kinds(other)).toEqual(kinds(base))
  })

  it('two overlapping statements of one account give each row once', async () => {
    const nov = CHECKING_ROWS.filter((r) => r.postedDate >= '2026-11-10')
    const early = CHECKING_ROWS.filter((r) => r.postedDate <= '2026-11-20')
    const req: ImportRequest = { importId: 'imp-o', sourceLabel: 'synthetic', seed: SEED, statements: [
      { accountId: 'chk-a', periodStart: '2026-11-01', periodEnd: '2026-11-20', rows: early },
      { accountId: 'chk-a', periodStart: '2026-11-10', periodEnd: '2026-11-30', rows: nov }] }
    const { plan: p, duplicates } = await planImportDetailed(req, emptyContext(), 'u', NOW)
    expect(p.rowsIn).toBe(early.length + nov.length)
    expect(p.txns.length).toBe(CHECKING_ROWS.length)
    expect(duplicates).toBe(p.rowsIn - CHECKING_ROWS.length)
    expect(duplicates).toBeGreaterThan(0)
    const whole = await plan({ importId: 'imp-w', sourceLabel: 'synthetic', seed: SEED, statements: [{ accountId: 'chk-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: CHECKING_ROWS }] })
    expect(p.txns.map((t) => t.id).sort()).toEqual(whole.txns.map((t) => t.id).sort())
  })

  it('a second import of the same request inserts nothing', async () => {
    const first = await plan()
    const again = await planImportDetailed(syntheticRequest('imp-synth-2'), extendContext(emptyContext(), first), 'u', NOW)
    expect(again.plan.txns).toHaveLength(0)
    expect(again.duplicates).toBe(first.rowsIn)
    expect(again.plan.pairs).toEqual([])
  })

  it('rows already in the context (existingIds) are dropped', async () => {
    const first = await plan()
    const known = new Set(first.txns.slice(0, 5).map((t) => t.id))
    const p = await planImportDetailed(syntheticRequest('imp-synth-3'), emptyContext({ existingIds: known }), 'u', NOW)
    expect(p.plan.txns).toHaveLength(first.txns.length - 5)
    expect(p.duplicates).toBe(5)
  })

  it('a row of another statement with the same account, date and amount but another id is flagged possible_duplicate', async () => {
    const a = row('2026-11-20', -1234, 'FIRST STORE')
    const b = row('2026-11-20', -1234, 'SECOND STORE TOTALLY DIFFERENT')
    const req: ImportRequest = { importId: 'imp-d', sourceLabel: 'synthetic', statements: [
      { accountId: 'chk-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: [a] },
      { accountId: 'chk-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: [b] }] }
    const p = await plan(req)
    expect(p.txns.map((t) => t.reviewReason)).toEqual(['low_confidence', 'possible_duplicate'])
  })
})

describe('validation', () => {
  const bad = (statements: ImportRequest['statements'], over: Partial<ImportRequest> = {}) =>
    planImport({ importId: 'x', sourceLabel: 's', statements, ...over }, emptyContext(), 'u', NOW)
  const st = (rows: ImportRequest['statements'][number]['rows'], accountId = 'chk-a') => ({ accountId, periodStart: '2026-11-01', periodEnd: '2026-11-30', rows })

  it('rejects unknown accounts, bad dates, non-integer cents and long ids, without echoing text', async () => {
    await expect(bad([st([], 'nope')])).rejects.toThrow(ImportError)
    await expect(bad([st([row('2026-13-01', 1, 'A')])])).rejects.toThrow(/postedDate/)
    await expect(bad([st([row('2026-11-01', 1.5, 'SECRET MERCHANT')])])).rejects.toThrow(/amountCents/)
    await expect(bad([st([row('2026-11-01', 1.5, 'SECRET MERCHANT')])])).rejects.not.toThrow(/SECRET/)
    await expect(bad([st([row('2026-11-01', 1, 'A', { kindHint: 'bogus' as never })])])).rejects.toThrow(/kindHint/)
    await expect(bad([{ ...st([]), periodStart: '2026-12-01' }])).rejects.toThrow(/period/)
    await expect(bad([], { importId: '' })).rejects.toThrow(/importId/)
    await expect(bad([], { importId: 'x'.repeat(65) })).rejects.toThrow(/importId/)
  })

  it('takes accounts that arrive in the seed', async () => {
    const seed = { accounts: [{ ...ACCOUNTS[0], id: 'new-acct', last4: '0009' }] }
    const p = await planImport({ importId: 'x', sourceLabel: 's', seed, statements: [st([row('2026-11-01', -100, 'SOME SHOP')], 'new-acct')] }, emptyContext(), 'u', NOW)
    expect(p.txns[0].accountId).toBe('new-acct')
    expect(p.accounts).toHaveLength(1)
  })

  it('a hint beats the wording and is recorded as the kind source', async () => {
    const p = await planImport({ importId: 'x', sourceLabel: 's', statements: [st([row('2026-11-01', -100, 'MONTHLY SERVICE FEE', { kindHint: 'spend' })])] }, emptyContext(), 'u', NOW)
    expect(p.txns[0]).toMatchObject({ kind: 'spend', kindSource: 'hint' })
  })

  it('carries principal, interest and bank reference through', async () => {
    const p = await planImport({ importId: 'x', sourceLabel: 's', statements: [st([row('2026-11-01', 30_000, 'PAYMENT RECEIVED', { principalCents: 25_000, interestCents: 5000, bankRef: ' R-1 ' })], 'loan-a')] }, emptyContext(), 'u', NOW)
    expect(p.txns[0]).toMatchObject({ kind: 'loan_payment', principalCents: 25_000, interestCents: 5000, bankRef: 'R-1' })
  })
})

describe('shapes seen on real statements (made-up names): one key per merchant, rules that can answer', () => {
  type SeedRule = Omit<MerchantRule, 'id' | 'source' | 'active'>
  const rl = (merchantKey: string, over: Partial<SeedRule> = {}): SeedRule =>
    ({ merchantKey, storeNo: null, accountId: null, amountMinCents: null, amountMaxCents: null, setCategoryId: null, setKind: null,
      debtAccountId: null, displayName: null, confidence: 90, review: false, reviewReason: null, ...over })
  const run = (rows: ReturnType<typeof row>[], rules: SeedRule[] = []) =>
    planImport({ importId: 'shapes', sourceLabel: 's', seed: { rules }, statements: [{ accountId: 'chk-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows }] }, emptyContext(), 'u', NOW)

  it('card swipes with and without a time, and with a credit, share the merchant key and keep the store number', async () => {
    const p = await run([
      row('2026-11-03', -1500, 'POINT OF SALE DEBIT L123 DATE 11-03 BRAMBLEWOOD MARKET #0412 SPRINGFIELD NC'),
      row('2026-11-04', -2500, 'POINT OF SALE DEBIT L124 TIME 03.02 PM DATE 11-04 BRAMBLEWOOD MARKET #0412 SPRINGFIELD NC'),
      row('2026-11-05', 700, 'POINT OF SALE CREDIT L123 DATE 11-05 BRAMBLEWOOD MARKET #0412 SPRINGFIELD NC'),
    ])
    expect(p.txns.map((t) => t.merchantKey)).toEqual(['bramblewood-market', 'bramblewood-market', 'bramblewood-market'])
    expect(p.txns.map((t) => t.storeNo)).toEqual(['0412', '0412', '0412'])
    expect(p.txns.map((t) => t.kind)).toEqual(['spend', 'spend', 'refund'])
    expect(p.txns[0].txnDate).toBe('2026-11-03')
  })

  it('a rule on an aggregator-prefixed key clears the hidden-merchant flag; without a rule the flag stays', async () => {
    const lines = [row('2026-11-03', -1500, 'POINT OF SALE DEBIT L123 DATE 11-03 PAYPAL *EXAMPLE4US 402-555-0100')]
    // The merchant after the processor prefix is visible, so it is not hidden (it is only uncategorised).
    expect((await run(lines)).txns[0]).toMatchObject({ merchantKey: 'example4us', reviewReason: 'low_confidence' })
    const hidden = row('2026-11-04', -1500, 'POINT OF SALE DEBIT L123 DATE 11-04 SQ *')
    expect((await run([hidden])).txns[0]).toMatchObject({ merchantKey: 'sq', needsReview: true, reviewReason: 'hidden_merchant' })
    expect((await run([hidden], [rl('sq', { setCategoryId: 'shopping' })])).txns[0]).toMatchObject({ needsReview: false, categoryId: 'shopping' })
  })

  it('per-payee person-to-person keys take a rule each; an unknown payee is still hidden', async () => {
    const p = await run([
      row('2026-11-03', -2000, 'POINT OF SALE DEBIT L123 VENMO *PAT EXAMPLEVISA DIRECTNY'),
      row('2026-11-04', -3000, 'POINT OF SALE DEBIT L123 VENMO *LEE SAMPLEVISA DIRECTNY'),
    ], [rl('venmo-pat', { setCategoryId: 'kids', displayName: 'Lessons' })])
    expect(p.txns[0]).toMatchObject({ merchantKey: 'venmo-pat', merchantName: 'Lessons', categoryId: 'kids', needsReview: false })
    expect(p.txns[1]).toMatchObject({ merchantKey: 'venmo-lee', needsReview: true, reviewReason: 'hidden_merchant' })
  })

  it('a toll-free-style name keeps its name', async () => {
    const p = await run([row('2026-11-03', -2000, 'POINT OF SALE DEBIT L123 DATE 11-03 1-800-EXAMPLE.COM')])
    expect(p.txns[0].merchantKey).toBe('1800examplecom')
  })

  it('a branch TRFR to an own account is a transfer; to an unknown account it is flagged, keyed by that account, and a rule can answer it', async () => {
    const own = await run([row('2026-11-03', -5000, 'BRANCH TRFR TO DDA X0002')])
    expect(own.txns[0]).toMatchObject({ kind: 'transfer', merchantKey: 'branch-trfr-to', needsReview: false })
    const unknown = await run([row('2026-11-03', -5000, 'BRANCH TRFR TO DDA X0099'), row('2026-11-04', -5000, 'BRANCH TRFR TO DDA X0098')])
    expect(unknown.txns.map((t) => t.merchantKey)).toEqual(['branch-trfr-to-0099', 'branch-trfr-to-0098'])
    expect(unknown.txns.every((t) => t.needsReview && t.reviewReason === 'transfer_to_unknown_account')).toBe(true)
    const ruled = await run([row('2026-11-03', -5000, 'BRANCH TRFR TO DDA X0099'), row('2026-11-04', -5000, 'BRANCH TRFR TO DDA X0098')],
      [rl('branch-trfr-to-0099', { setKind: 'spend', setCategoryId: 'support', displayName: 'Support' })])
    expect(ruled.txns[0]).toMatchObject({ kind: 'spend', categoryId: 'support', merchantName: 'Support', needsReview: false })
    expect(ruled.txns[1]).toMatchObject({ kind: 'transfer_external', needsReview: true })
  })
})

describe('payments to our own loans: a rule per debt, no double count', () => {
  const loanB = { ...ACCOUNTS.find((a) => a.id === 'loan-a')!, id: 'loan-b', label: 'Loan B', last4: '0008', personId: null }
  const rl = (merchantKey: string, debtAccountId: string) => ({ merchantKey, storeNo: null, accountId: null, amountMinCents: null, amountMaxCents: null,
    setCategoryId: 'transport', setKind: 'spend' as const, debtAccountId, displayName: 'Vehicle loan', confidence: 90, review: false, reviewReason: null })
  const loanPay = (day: string, cents: number, last4: string) => row(day, cents, `FUNDS TRANSFER TO LOAN X${last4}`)
  const receipt = (day: string, cents: number) => row(day, cents, 'FUNDS TRANSFER PAYMENT 90.00 PRINCIPAL AMOUNT 10.00 INTEREST CHARGE AMOUNT', { kindHint: 'loan_payment' })
  const run = (rules: ReturnType<typeof rl>[]) => planImport({ importId: 'loans', sourceLabel: 's', seed: { accounts: [loanB], rules }, statements: [
    { accountId: 'chk-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: [loanPay('2026-11-03', -10_000, '0005'), loanPay('2026-11-04', -7_500, '0008'),
      row('2026-11-05', -3_000, 'TRANSFER TO SAVINGS X0002'), row('2026-11-06', -2_000, 'ONLINE PAYMENT TO CARD X0003')] },
    { accountId: 'loan-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: [receipt('2026-11-03', 10_000)] },
    { accountId: 'loan-b', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: [receipt('2026-11-04', 7_500)] },
  ] }, emptyContext(), 'u', NOW)

  it('the key carries the loan last four, so each loan can have its own rule; other own-account moves keep their keys', async () => {
    const p = await run([])
    const mine = p.txns.filter((t) => t.accountId === 'chk-a')
    expect(mine.map((t) => t.merchantKey)).toEqual(['funds-transfer-to-0005', 'funds-transfer-to-0008', 'transfer-to-savings', 'online-payment-to'])
    expect(mine.map((t) => t.kind)).toEqual(['loan_payment', 'loan_payment', 'transfer', 'card_payment'])
  })

  it('a rule on one loan makes only its payments spending, tied to that debt; the loan-side receipt stays out and is not paired', async () => {
    const p = await run([rl('funds-transfer-to-0008', 'loan-b')])
    const a = find(p.txns, 'chk-a', '2026-11-03', -10_000), b = find(p.txns, 'chk-a', '2026-11-04', -7_500)
    expect(a).toMatchObject({ kind: 'loan_payment' })
    expect(a.pairId).not.toBeNull()
    expect(b).toMatchObject({ kind: 'spend', kindSource: 'rule', categoryId: 'transport', debtAccountId: 'loan-b', pairId: null, needsReview: false })
    const rb = find(p.txns, 'loan-b', '2026-11-04', 7_500)
    expect(rb).toMatchObject({ kind: 'loan_payment', pairId: null })
    expect(SPENDING_KINDS).not.toContain(rb.kind)
    expect(p.pairs.flat()).not.toContain(b.id)
    expect(p.pairs.flat()).not.toContain(rb.id)
  })

  it('rules on both loans: both payments are spending once, both receipts stay out', async () => {
    const p = await run([rl('funds-transfer-to-0005', 'loan-a'), rl('funds-transfer-to-0008', 'loan-b')])
    const spending = p.txns.filter((t) => SPENDING_KINDS.includes(t.kind))
    expect(spending.map((t) => [t.accountId, t.debtAccountId, t.amountCents])).toEqual([['chk-a', 'loan-a', -10_000], ['chk-a', 'loan-b', -7_500]])
  })
})
