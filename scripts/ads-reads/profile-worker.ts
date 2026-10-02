// profile-worker — LOCAL CPU estimate for the gss-stats-sync Worker's paths, in Node (same V8 as
// workerd, so relative costs carry over; absolute numbers differ). Seeds a migrated in-memory
// SQLite from a JSON export of the remote rows and answers the Ads API from those rows, so no
// network and no credential is involved.
//
//   npx tsx scripts/ads-reads/profile-worker.ts <seed.json> <mode> [--now <iso>]
//   mode: import | noop | cron-noop | day1 | full
//
// Prints the milliseconds of module import, of the first (cold) call and the mean of 20 warm
// calls, each on a freshly seeded database. performance.now() wall time: with an in-memory
// database and an in-process fake Ads API there is no real I/O, so it tracks CPU closely
// (process.cpuUsage ticks at ~16 ms on Windows, too coarse for this).

const t0 = process.cpuUsage()
const seedPath = process.argv[2]
const mode = process.argv[3] ?? 'noop'
const nowArg = process.argv.indexOf('--now')
const nowMs = nowArg > 0 ? Date.parse(process.argv[nowArg + 1]) : Date.parse('2026-09-26T18:30:00Z')

const ms = (u: NodeJS.CpuUsage) => ((u.user + u.system) / 1000).toFixed(1)

async function main() {
  const fs = await import('node:fs')
  const { openMigratedSqlite, sqliteD1 } = await import('./sqliteDb')
  const tImport = performance.now()
  const worker = await import('../../workers/sync/src/index')
  const importMs = performance.now() - tImport
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as Record<string, Record<string, unknown>[]>
  const freshDb = () => {
    const db = openMigratedSqlite()
    const colsOf = new Set<string>()
    for (const [table, rows] of Object.entries(seed)) {
      const have = new Set((db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name))
      for (const r of rows) {
        const cols = Object.keys(r).filter((c) => have.has(c))
        cols.forEach((c) => colsOf.add(c))
        db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(cols.map((c) => r[c]) as (string | number | null)[]))
      }
    }
    return db
  }
  const daily = seed.ads_daily_metrics
  const placements = seed.ads_placement_daily
  const fetchImpl = async (url: string, init: { body?: string }) => {
    if (url.includes('oauth2')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ya29.local-profile-token', expires_in: 3599, token_type: 'Bearer' }) }
    const query = JSON.parse(init.body!).query as string
    const id = /campaign\.id = (\d+)/.exec(query)![1]
    const [, since, until] = /BETWEEN '([\d-]+)' AND '([\d-]+)'/.exec(query)!
    const results = query.includes('group_placement_view')
      ? placements
          .filter((p) => p.campaign_id === id && String(p.date) >= since && String(p.date) <= until && Number(p.cost_micros) > 0)
          .map((p) => ({ segments: { date: p.date }, groupPlacementView: { placement: p.placement, displayName: p.display_name, targetUrl: p.target_url, placementType: p.placement_type }, metrics: { costMicros: String(p.cost_micros), impressions: String(p.impressions), clicks: String(p.clicks) } }))
      : daily
          .filter((d) => d.campaign_id === id && String(d.date) >= since && String(d.date) <= until && Number(d.cost_micros) > 0)
          .map((d) => ({ segments: { date: d.date }, metrics: { costMicros: String(d.cost_micros), impressions: String(d.impressions), clicks: String(d.clicks) } }))
    return { ok: true, status: 200, text: async () => JSON.stringify({ results }) }
  }
  const secret = (v: string) => ({ get: async () => v })
  const envFor = () =>
    ({
      gss_stats_ads: sqliteD1(freshDb()),
      ADS_CLIENT_ID: secret('profile-client-id'),
      ADS_CLIENT_SECRET: secret('profile-client-secret'),
      ADS_REFRESH_TOKEN: secret('profile-refresh-token'),
      ADS_DEVELOPER_TOKEN: secret('profile-developer-token'),
    }) as unknown as import('../../workers/sync/src/index').Env
  // day1 profiles one campaign's first day: the registry's first closed play-direct flight (no literal id here).
  const { CAMPAIGNS } = await import('../../src/lib/campaigns')
  const day1Id = CAMPAIGNS.find((c) => c.status === 'closed' && c.kind === 'play-direct')?.id
  const body: Record<string, unknown> =
    mode === 'full' ? { full: true } : mode === 'day1' ? { full: true, campaignIds: day1Id ? [day1Id] : [], maxDays: 1 } : {}
  const once = async () => {
    const env = envFor()
    const t = performance.now()
    let out: unknown
    if (mode === 'cron-noop') {
      out = await worker.handleScheduled({ scheduledTime: nowMs, cron: '5 * * * *' }, env, { fetchImpl, nowMs })
    } else if (mode !== 'import') {
      const res = await worker.handleFetch(new Request('https://gss-stats-sync/sync', { method: 'POST', body: JSON.stringify(body) }), env, nowMs, { fetchImpl })
      out = await res.json()
    }
    return { ms: performance.now() - t, out }
  }
  // --profile <file>: a V8 CPU profile of the cold call only (node:inspector).
  const profArg = process.argv.indexOf('--profile')
  let session: import('node:inspector').Session | null = null
  if (profArg > 0) {
    const { Session } = await import('node:inspector')
    session = new Session()
    session.connect()
    const post = (m: string, p?: object) => new Promise<any>((res, rej) => session!.post(m, p ?? {}, (e, r) => (e ? rej(e) : res(r))))
    await post('Profiler.enable')
    await post('Profiler.setSamplingInterval', { interval: 20 })
    await post('Profiler.start')
  }
  const cold = await once()
  if (session) {
    const { profile } = await new Promise<any>((res, rej) => session!.post('Profiler.stop', (e, r) => (e ? rej(e) : res(r))))
    fs.writeFileSync(process.argv[profArg + 1], JSON.stringify(profile))
    session.disconnect()
  }
  let warm = 0
  const reps = process.argv.includes('--once') ? 0 : 20
  for (let i = 0; i < reps; i++) warm += (await once()).ms
  const summary = cold.out && typeof cold.out === 'object' ? JSON.stringify(cold.out).slice(0, 240) : String(cold.out)
  process.stdout.write(`mode=${mode} import=${importMs.toFixed(1)}ms cold=${cold.ms.toFixed(2)}ms warm(mean of 20)=${(warm / 20).toFixed(2)}ms (process cpu ${ms(process.cpuUsage(t0))}ms)\n${summary}\n`)
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + '\n')
  process.exit(1)
})
