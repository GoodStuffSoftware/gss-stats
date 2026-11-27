import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insideGitWorkTree, parseArgs, run } from './build-load-sql'
import { CARD_ROWS, CHECKING_ROWS, SAVINGS_ROWS, SEED, withoutBankGuard } from '../../src/lib/budget/__fixtures__/synthetic'

const MIGRATION = readFileSync('migrations/gss-budget/0001_init.sql', 'utf8')

let root: string
let seedFile: string
let reqDir: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'budget-tool-'))
  seedFile = join(root, 'seed.json')
  reqDir = join(root, 'requests')
  mkdirSync(reqDir)
  writeFileSync(seedFile, JSON.stringify(SEED))
  // Two requests that overlap in time; the second repeats a statement of the first.
  const chk = { accountId: 'chk-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: CHECKING_ROWS }
  writeFileSync(join(reqDir, 'a.json'), JSON.stringify({ importId: 'imp-a', sourceLabel: 'a', statements: [chk, { accountId: 'sav-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: SAVINGS_ROWS }] }))
  writeFileSync(join(reqDir, 'b.json'), JSON.stringify({ importId: 'imp-b', sourceLabel: 'b', statements: [chk, { accountId: 'card-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: CARD_ROWS }] }))
})
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

describe('parseArgs', () => {
  it('needs all three flags with values', () => {
    expect(parseArgs(['--seed', 's', '--requests', 'r', '--out', 'o'])).toEqual({ seed: 's', requests: 'r', out: 'o' })
    expect(() => parseArgs(['--seed', 's', '--requests', 'r'])).toThrow(/missing --out/)
    expect(() => parseArgs(['--seed', '--requests', 'r', '--out', 'o'])).toThrow(/needs a value/)
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/)
  })
})

describe('insideGitWorkTree', () => {
  it('is true under a folder holding .git, even for a path that does not exist yet', () => {
    const repo = join(root, 'fake-repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    expect(insideGitWorkTree(join(repo, 'out.sql'))).toBe(true)
    expect(insideGitWorkTree(join(repo, 'a', 'b', 'out.sql'))).toBe(true)
  })
  it('is true for a .git file, as a linked worktree has', () => {
    const wt = join(root, 'fake-worktree')
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), 'gitdir: elsewhere')
    expect(insideGitWorkTree(join(wt, 'out.sql'))).toBe(true)
  })
  it('is false outside any repo', () => {
    expect(insideGitWorkTree(join(root, 'plain', 'out.sql'))).toBe(false)
  })
})

describe('run', () => {
  it('refuses an --out inside a git work tree and writes nothing', async () => {
    const repo = join(root, 'refuse-repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    const out = join(repo, 'load.sql')
    await expect(run(['--seed', seedFile, '--requests', reqDir, '--out', out], () => {})).rejects.toThrow(/inside a git work tree/)
    expect(() => readFileSync(out)).toThrow()
  })

  it('refuses this repository too', async () => {
    const out = join(process.cwd(), 'tmp-load.budget.sql')
    await expect(run(['--seed', seedFile, '--requests', reqDir, '--out', out], () => {})).rejects.toThrow(/inside a git work tree/)
  })

  it('writes SQL that applies to the real migration, prints counts only, and a second apply adds nothing', async () => {
    const out = join(root, 'out', 'load.sql')
    const lines: string[] = []
    const sum = await run(['--seed', seedFile, '--requests', reqDir, '--out', out], (l) => lines.push(l))
    const sql = readFileSync(out, 'utf8')

    const db = new DatabaseSync(':memory:')
    db.exec(MIGRATION)
    db.exec(withoutBankGuard(sql)) // the real migration here is 0001 alone: no bank_accounts table for the guard
    const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
    expect(n('transactions')).toBe(sum.inserted)
    expect(sum.duplicates).toBeGreaterThan(0) // the repeated checking statement
    expect(sum.inserted).toBe(CHECKING_ROWS.length + SAVINGS_ROWS.length + CARD_ROWS.length)
    expect(n('imports')).toBe(2) // the two requests; the seed carries no rows, so it writes no imports row
    expect(n('merchant_rules')).toBe(SEED.rules!.length)
    expect((db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE pair_id IS NOT NULL').get() as { n: number }).n).toBe(sum.paired * 2)
    const before = n('transactions')
    db.exec(withoutBankGuard(sql))
    expect(n('transactions')).toBe(before)

    const printed = lines.join('\n')
    expect(printed).toMatch(/rows in: \d+, inserted: \d+/)
    for (const t of [...CHECKING_ROWS, ...CARD_ROWS]) expect(printed).not.toContain(t.description.slice(0, 8))
    expect(printed).not.toMatch(/-?\d{3,},\d\d|\$\d/)
  })

  it('reports an unreadable request by file name only', async () => {
    const bad = join(root, 'bad-requests')
    mkdirSync(bad)
    writeFileSync(join(bad, 'broken.json'), '{ not json SECRET')
    const err = await run(['--seed', seedFile, '--requests', bad, '--out', join(root, 'x', 'o.sql')], () => {}).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('broken.json')
    expect((err as Error).message).not.toContain('SECRET')
  })
})
