// capture-facts — READ-ONLY. Plans the representative Overview batch (overviewBatch.ts) exactly
// as POST /api/metrics does, runs each planned fact's SELECT against the REMOTE databases with
// `wrangler d1 execute <db> --remote --json --command "<SELECT>"` (never --file, never a write:
// scripts/ads-reads/d1.ts assertReadOnlySql refuses anything else before wrangler starts), and
// reports each statement's D1 `rows_read` (docs/capacity.md §7). With --out it also saves the
// fact rows — anonymous aggregates only — as a seed for profile-metrics.ts.
//
//   npx tsx scripts/metrics/capture-facts.ts --cf-token-file <path> [--out <seed.json>] [--now <iso>] [--legacy-scorecard]
//                                            [--batch overview|campaigns]
//
// --batch campaigns: the Campaigns page's cards (presetBatch.ts), and its two arrivals charts'
// /api/geo statements (hour of day, flight day), each run read-only the same way.
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
import { CAMPAIGNS_PAGE_PRESETS, presetBatch } from './presetBatch'

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

  const which = arg('--batch') ?? 'overview'
  const requests = which === 'campaigns' ? presetBatch(CAMPAIGNS_PAGE_PRESETS, nowMs) : overviewBatch(nowMs)
  const batch = validateMetricsRequest(JSON.stringify({ v: 1, requests }))
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

  // --batch campaigns: the page's two standard charts, as /api/geo builds them (the handler runs
  // against a recording stand-in for D1, then each statement runs remotely, read-only).
  if (which === 'campaigns') {
    const { onRequestPost: geoPost } = await import('../../functions/api/geo')
    const { hourOfDayWidget, flightDayWidget } = await import('../../src/lib/defaults')
    const realNow = Date.now
    Date.now = () => nowMs
    let geoTotal = 0
    for (const w of [hourOfDayWidget({ x: 0, y: 0, w: 1, h: 1 }), flightDayWidget({ x: 0, y: 0, w: 1, h: 1 })]) {
      const f = w.filters!
      const recorded: { sql: string; binds: unknown[] }[] = []
      const rec = { prepare: (sql: string) => ({ bind: (...binds: unknown[]) => ({ all: async () => (recorded.push({ sql, binds }), { results: [] }) }) }) }
      const body = { dimension: w.dimension, breakdown: w.breakdown, dims: [w.dimension, w.breakdown], since: f.since, until: f.until, limit: w.limit, sites: [], constraints: (f.drill ?? []).map((d) => ({ field: d.key, value: d.value })), excludeOwnVisits: false, includeEventBeacons: true }
      ;(globalThis as any).caches = { default: { match: async () => undefined, put: async () => {} } }
      await geoPost({ request: new Request('https://x/api/geo', { method: 'POST', body: JSON.stringify(body) }), env: { gss_geo: rec }, waitUntil: () => {} } as any)
      for (const st of recorded) {
        const final = inlineBinds(st.sql, st.binds)
        assertReadOnlySql(final)
        const res = await run(['d1', 'execute', 'gss-geo', '--remote', '--json', '--command', final])
        if (res.code !== 0) throw new Error(`wrangler d1 execute failed for ${w.id} (exit ${res.code})`)
        const start = /^\[/m.exec(res.stdout)?.index ?? -1
        const first = JSON.parse(res.stdout.slice(start))[0]
        const rr = typeof first.meta?.rows_read === 'number' ? first.meta.rows_read : 0
        geoTotal += rr
        process.stdout.write(`geo ${w.id.padEnd(13)} ${w.dimension} × ${w.breakdown} rows=${String((first.results ?? []).length).padStart(5)} rows_read=${rr}\n`)
      }
    }
    Date.now = realNow
    process.stdout.write(`geo charts total rows_read=${geoTotal}\npage total rows_read=${total + geoTotal}\n`)
  }

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
