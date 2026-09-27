// profile-metrics — LOCAL CPU estimate for one POST /api/metrics Overview batch, in Node (the same
// V8 as workerd, so relative costs carry over; absolute numbers differ). The same approach as
// scripts/ads-reads/profile-worker.ts: no network, no credential. The real handler
// (functions/api/metrics.ts) runs end to end — body read, validation, planning, per-fact cache
// lookups, derivation, the JSON response — against a fake D1 that answers each planned statement
// from a seed of fact rows, re-parsed from JSON on every call as a D1 result would be.
//
//   npx tsx scripts/metrics/profile-metrics.ts [--seed <seed.json>] [--reps 50]
//                                              [--profile-cold <cold.cpuprofile>] [--profile <warm.cpuprofile>] [--print]
//
// --seed: fact rows captured from production by capture-facts.ts (anonymous aggregates). Without
// it, the rows come from the synthetic test fixture (functions/_lib/testing/bskFixture.ts).
// Two cache modes: "miss" (a fresh cache per call, every fact read from "D1" — the worst case)
// and "hit" (every fact served from the Cache API). performance.now() wall time: with no real I/O
// it tracks CPU closely (process.cpuUsage ticks at ~16 ms on Windows, too coarse for this).

import fs from 'node:fs'
import type { Seed } from './capture-facts'
import { overviewBatch } from './overviewBatch'

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

async function syntheticSeed(nowMs: number): Promise<Seed> {
  const { openHitsDb, insertHits } = await import('../../functions/_lib/testing/hitsDb')
  const { bskFixture } = await import('../../functions/_lib/testing/bskFixture')
  const { planBatch } = await import('../../src/lib/metrics/engine')
  const { validateMetricsRequest } = await import('../../src/lib/metrics/validate')
  const { FACTS } = await import('../../src/lib/metrics/facts')
  const { etDateFromMs } = await import('../../src/lib/popupEvents')
  const db = openHitsDb()
  insertHits(db, bskFixture())
  const batch = validateMetricsRequest(JSON.stringify({ v: 1, requests: overviewBatch(nowMs) }))
  if (!batch.ok) throw new Error(batch.error)
  const plan = planBatch(batch.requests.flatMap((r) => (r.ok ? [r.req] : [])), { context: batch.context, nowMs, todayEt: etDateFromMs(nowMs), hasAdsDb: false })
  return {
    nowMs,
    // No ads store in the synthetic case: spend falls back to CAMPAIGN_SPEND without a query.
    facts: plan.facts.filter((f) => f.id !== 'adsSpend').map((f) => {
      const stmt = FACTS[f.id].build(f.params, nowMs)
      return { key: f.key, id: f.id, sql: stmt.sql, binds: stmt.binds, rows: db.prepare(stmt.sql).all(...(stmt.binds as (string | number)[])) as Record<string, unknown>[], rowsRead: null }
    }),
  }
}

function fakeD1(seed: Seed) {
  const bySql = new Map(seed.facts.map((f) => [f.sql + '\u0000' + JSON.stringify(f.binds), JSON.stringify(f.rows)]))
  return {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async all() {
              const rows = bySql.get(sql + '\u0000' + JSON.stringify(binds))
              if (rows === undefined) throw new Error('statement not in the seed: ' + sql.slice(0, 80))
              return { results: JSON.parse(rows), success: true, meta: {} }
            },
          }
        },
      }
    },
  }
}

async function main() {
  const tImport0 = performance.now()
  const { onRequestPost } = await import('../../functions/api/metrics')
  const { memoryCache, installCaches, pagesContext } = await import('../../functions/_lib/testing/hitsDb')
  const importMs = performance.now() - tImport0

  const seedPath = arg('--seed')
  const seed: Seed = seedPath ? JSON.parse(fs.readFileSync(seedPath, 'utf8')) : await syntheticSeed(Date.parse('2026-09-26T21:00:00Z'))
  const realNow = Date.now
  Date.now = () => seed.nowMs // the KPI fact binds "now"; replay the instant the seed was read at
  const reps = Number(arg('--reps')) || 50
  const body = JSON.stringify({ v: 1, requests: overviewBatch(seed.nowMs) })
  const env = { gss_geo: fakeD1(seed), ...(seed.facts.some((f) => f.id === 'adsSpend') ? { gss_stats_ads: fakeD1(seed) } : {}) }

  const call = async (cache: ReturnType<typeof memoryCache>) => {
    const undo = installCaches(cache)
    const waited: Promise<unknown>[] = []
    const t = performance.now()
    const res = await onRequestPost(pagesContext(new Request('https://stats.goodstuff.software/api/metrics', { method: 'POST', body }), env as never, waited))
    const text = await res.text()
    const ms = performance.now() - t
    await Promise.all(waited)
    undo()
    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    return { ms, meta: JSON.parse(text).meta, bytes: text.length, text }
  }
  const stats = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b)
    return `mean ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)} ms, p50 ${s[Math.floor(s.length / 2)].toFixed(2)} ms, max ${s[s.length - 1].toFixed(2)} ms`
  }

  // --profile-cold <file>: a V8 CPU profile of the first (cold) call only; --profile <file>: of
  // `reps` warm cache-miss calls (node:inspector, 20 µs sampling).
  const profiled = async <T>(file: string | undefined, fn: () => Promise<T>): Promise<T> => {
    if (!file) return fn()
    const { Session } = await import('node:inspector')
    const session = new Session()
    session.connect()
    const post = (m: string, p?: object) => new Promise<any>((res, rej) => session.post(m, p ?? {}, (e, r) => (e ? rej(e) : res(r))))
    await post('Profiler.enable')
    await post('Profiler.setSamplingInterval', { interval: 20 })
    await post('Profiler.start')
    const out = await fn()
    const { profile } = await post('Profiler.stop')
    fs.writeFileSync(file, JSON.stringify(profile))
    session.disconnect()
    return out
  }

  // Node loads its fetch implementation (undici) lazily, ~20 ms on first use of Request/Response;
  // workerd's are native. Touch them once first so "first call" measures OUR code's cold cost
  // (lazy compilation, Intl formatters), not Node's.
  await new Request('https://warm.up/', { method: 'POST', body: '{}' }).text()
  await new Response(new Response('{}').body).json()
  const cold = await profiled(arg('--profile-cold'), () => call(memoryCache()))
  const miss: number[] = []
  for (let i = 0; i < reps; i++) miss.push((await call(memoryCache())).ms)
  const warmCache = memoryCache()
  await call(warmCache)
  const hit: number[] = []
  for (let i = 0; i < reps; i++) hit.push((await call(warmCache)).ms)
  await profiled(arg('--profile'), async () => {
    for (let i = 0; i < reps; i++) await call(memoryCache())
  })
  const profileNote = [arg('--profile-cold') && `\ncold-call profile: ${arg('--profile-cold')}`, arg('--profile') && `\nwarm profile (${reps} cache-miss calls): ${arg('--profile')}`].filter(Boolean).join('')
  Date.now = realNow
  if (process.argv.includes('--print')) process.stdout.write(JSON.stringify(JSON.parse(cold.text).results, null, 1) + '\n')

  const rows = seed.facts.reduce((a, f) => a + f.rows.length, 0)
  process.stdout.write(
    `seed=${seedPath ? 'captured' : 'synthetic'} requests=${JSON.parse(body).requests.length} facts=${cold.meta.facts} fact rows=${rows} response=${cold.bytes} B\n` +
      `import ${importMs.toFixed(1)} ms · first call ${cold.ms.toFixed(2)} ms\n` +
      `cache miss (every fact from D1), ${reps} calls: ${stats(miss)}\n` +
      `cache hit  (every fact cached),  ${reps} calls: ${stats(hit)}` +
      profileNote +
      '\n',
  )
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + '\n')
  process.exit(1)
})
