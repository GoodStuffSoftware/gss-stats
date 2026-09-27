// capture-facts — READ-ONLY. Plans the representative Overview batch (overviewBatch.ts) exactly
// as POST /api/metrics does, runs each planned fact's SELECT against the REMOTE databases with
// `wrangler d1 execute <db> --remote --json --command "<SELECT>"` (never --file, never a write:
// scripts/ads-reads/d1.ts assertReadOnlySql refuses anything else before wrangler starts), and
// reports each statement's D1 `rows_read` (docs/capacity.md §7). With --out it also saves the
// fact rows — anonymous aggregates only — as a seed for profile-metrics.ts.
//
//   npx tsx scripts/metrics/capture-facts.ts --cf-token-file <path> [--out <seed.json>] [--now <iso>] [--legacy-scorecard]
//
// The token is read into memory and passed to wrangler's environment only; it is never printed.

import fs from 'node:fs'
import { createWranglerRunner } from '../ads-reads/wrangler'
import { assertReadOnlySql, inlineBinds } from '../ads-reads/d1'
import { buildFact, planBatch } from '../../src/lib/metrics/engine'
import { validateMetricsRequest } from '../../src/lib/metrics/validate'
import { factKey, type FactId, type FactParams } from '../../src/lib/metrics/facts'
import { CAMPAIGNS } from '../../src/lib/campaigns'
import { etDateFromMs } from '../../src/lib/popupEvents'
import { overviewBatch } from './overviewBatch'

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

export interface SeedFact {
  key: string
  id: string
  sql: string
  binds: unknown[]
  rows: Record<string, unknown>[]
  rowsRead: number | null
}
export interface Seed {
  nowMs: number
  facts: SeedFact[]
}

async function main() {
  const tokenFile = arg('--cf-token-file')
  if (!tokenFile) throw new Error('--cf-token-file <path> is required')
  const cfToken = fs.readFileSync(tokenFile, 'utf8').trim()
  const nowMs = arg('--now') ? Date.parse(arg('--now')!) : Date.now()
  const run = createWranglerRunner({ cfToken, timeoutMs: 120_000 })

  const batch = validateMetricsRequest(JSON.stringify({ v: 1, requests: overviewBatch(nowMs) }))
  if (!batch.ok) throw new Error(batch.error)
  const plan = planBatch(batch.requests.flatMap((r) => (r.ok ? [r.req] : [])), { context: batch.context, nowMs, todayEt: etDateFromMs(nowMs), hasAdsDb: true })

  const read = async (id: FactId, params: FactParams): Promise<SeedFact> => {
    const stmt = buildFact({ id, params }, nowMs)
    const final = inlineBinds(stmt.sql, stmt.binds)
    assertReadOnlySql(final)
    const database = stmt.db === 'gss_geo' ? 'gss-geo' : 'gss-stats-ads'
    const res = await run(['d1', 'execute', database, '--remote', '--json', '--command', final])
    if (res.code !== 0) throw new Error(`wrangler d1 execute failed for ${id} (exit ${res.code})`)
    const start = /^\[/m.exec(res.stdout)?.index ?? -1
    const first = JSON.parse(res.stdout.slice(start))[0]
    return { key: JSON.stringify(factKey(id, params)), id, sql: stmt.sql, binds: stmt.binds, rows: first.results ?? [], rowsRead: typeof first.meta?.rows_read === 'number' ? first.meta.rows_read : null }
  }
  const line = (f: SeedFact) => `${f.id.padEnd(20)} ${JSON.stringify(JSON.parse(f.key).params).padEnd(34)} rows=${String(f.rows.length).padStart(5)} rows_read=${f.rowsRead}\n`

  const facts: SeedFact[] = []
  for (const f of plan.facts) facts.push(await read(f.id, f.params))
  const total = facts.reduce((a, f) => a + (f.rowsRead ?? 0), 0)
  process.stdout.write(`now=${new Date(nowMs).toISOString()} requests=${batch.requests.length} facts=${plan.facts.length} statements=${plan.statements}\n`)
  for (const f of facts) process.stdout.write(line(f))
  process.stdout.write(`total rows_read=${total}\n`)

  // --legacy-scorecard: the two statements /api/overview's scorecard runs for EVERY campaign on
  // every load (its query 1 and query 2 have exactly these facts' WHERE clauses, so the same
  // rows_read), for comparison. The planner skips the ones a campaign's config already rules out.
  if (process.argv.includes('--legacy-scorecard')) {
    let legacy = 0
    process.stdout.write('legacy scorecard equivalents (every campaign, uncached):\n')
    for (const c of CAMPAIGNS) {
      for (const id of ['campaignPathVisitor', 'campaignReturns'] as const) {
        const f = facts.find((x) => x.key === JSON.stringify(factKey(id, { campaignId: c.id }))) ?? (await read(id, { campaignId: c.id }))
        legacy += f.rowsRead ?? 0
        process.stdout.write('  ' + line(f))
      }
    }
    process.stdout.write(`legacy scorecard total rows_read=${legacy}\n`)
  }
  const out = arg('--out')
  if (out) fs.writeFileSync(out, JSON.stringify({ nowMs, facts } satisfies Seed))
}

main().catch((e) => {
  process.stderr.write(String(e?.message ?? e) + '\n')
  process.exit(1)
})
