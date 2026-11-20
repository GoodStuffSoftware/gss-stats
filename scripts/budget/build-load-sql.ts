// Local tool: turn a private seed and a folder of ImportRequest JSON files into one SQL file for
//   npx wrangler d1 execute gss-budget --local --file <out.sql>      (or --remote, by the lead only)
// Usage: npx tsx scripts/budget/build-load-sql.ts --seed <seed.json> --requests <dir> --out <file.sql>
// The packages are planned in date order with ONE shared context, so rows that appear in two overlapping
// statements are written once and transfers pair across accounts. The output holds private data: it is
// refused inside any git work tree (this repo is public). Prints counts only, never text or amounts.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ImportRequest, ImportSeed, PlanContext } from '../../src/lib/budget/types'
import { extendContext, planImportDetailed } from '../../src/lib/budget/import'
import { renderPlanSql } from '../../src/lib/budget/sqlFile'

export interface Args { seed: string; requests: string; out: string }

export function parseArgs(argv: readonly string[]): Args {
  const got: Partial<Args> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--seed' || a === '--requests' || a === '--out') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`)
      got[a.slice(2) as keyof Args] = v
    } else throw new Error(`unknown argument ${a}`)
  }
  for (const k of ['seed', 'requests', 'out'] as const) if (!got[k]) throw new Error(`missing --${k}`)
  return got as Args
}

/** True when `path` (which need not exist yet) lies inside a git work tree: any ancestor holds a `.git`. */
export function insideGitWorkTree(path: string): boolean {
  let dir = resolve(dirname(path))
  while (!existsSync(dir)) {
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  try { dir = realpathSync(dir) } catch { /* keep the lexical path */ }
  for (;;) {
    if (existsSync(join(dir, '.git'))) return true
    const up = dirname(dir)
    if (up === dir) return false
    dir = up
  }
}

function readJson<T>(file: string, what: string): T {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { throw new Error(`${what}: not readable JSON (${basename(file)})`) }
}

function sortKey(r: ImportRequest, file: string): string {
  const starts = r.statements?.map((s) => s.periodStart).sort() ?? []
  const ends = r.statements?.map((s) => s.periodEnd).sort() ?? []
  return `${starts[0] ?? '9999-99-99'}|${ends[0] ?? '9999-99-99'}|${file}`
}

export interface RunSummary {
  requests: number; rowsIn: number; inserted: number; duplicates: number; paired: number; needsReview: number
  perAccount: Record<string, number>
}

export async function run(argv: readonly string[], log: (line: string) => void = console.log): Promise<RunSummary> {
  const args = parseArgs(argv)
  const out = resolve(args.out)
  if (insideGitWorkTree(out)) throw new Error('refusing --out inside a git work tree: the load file holds private data. Use a folder outside every repo.')

  const seed = readJson<ImportSeed>(resolve(args.seed), 'seed')
  const dir = resolve(args.requests)
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')).sort()
  const requests = files.map((f) => ({ file: f, req: readJson<ImportRequest>(join(dir, f), 'request') }))
  requests.sort((a, b) => (sortKey(a.req, a.file) < sortKey(b.req, b.file) ? -1 : 1))

  const nowIso = new Date().toISOString()
  const who = 'tool:build-load-sql'
  const chunks: string[] = []
  const sum: RunSummary = { requests: requests.length, rowsIn: 0, inserted: 0, duplicates: 0, paired: 0, needsReview: 0, perAccount: {} }

  // The seed goes first, as a request with no statements, so every later row sees its accounts and rules.
  let ctx: PlanContext = { accounts: [], rules: [], pairCandidates: [], existingIds: new Set() }
  const seedPlan = (await planImportDetailed({ importId: `seed-${nowIso.slice(0, 10)}`, sourceLabel: 'seed', seed, statements: [] }, ctx, who, nowIso)).plan
  chunks.push(renderPlanSql(seedPlan))
  ctx = extendContext(ctx, seedPlan)

  for (const { req } of requests) {
    const { plan, duplicates } = await planImportDetailed(req, ctx, who, nowIso)
    chunks.push(renderPlanSql(plan))
    ctx = extendContext(ctx, plan)
    sum.rowsIn += plan.rowsIn
    sum.inserted += plan.txns.length
    sum.duplicates += duplicates
    sum.paired += plan.pairs.length
    sum.needsReview += plan.txns.filter((t) => t.needsReview).length
    for (const t of plan.txns) sum.perAccount[t.accountId] = (sum.perAccount[t.accountId] ?? 0) + 1
  }

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, chunks.join(''), 'utf8')

  log(`requests: ${sum.requests}`)
  for (const id of Object.keys(sum.perAccount).sort()) log(`account ${id}: ${sum.perAccount[id]} rows`)
  log(`rows in: ${sum.rowsIn}, inserted: ${sum.inserted}, deduped: ${sum.duplicates}, paired: ${sum.paired}, needs_review: ${sum.needsReview}`)
  log(`wrote ${basename(out)}`)
  return sum
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : 'failed')
    process.exit(1)
  })
}
