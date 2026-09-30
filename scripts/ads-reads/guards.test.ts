// Safety guards: read-only beacon SQL, the ads-store write guard, bind inlining, secret
// redaction, and the read-only Google Ads client (no manager header, SELECT only).
import { afterEach, describe, expect, it } from 'vitest'
import { assertReadOnlySql, createD1Select, inlineBinds, parseD1Json, parseD1Response, sqlLiteral, stripSqlLiterals } from './d1'
import { assertAdsWriteSql, createD1Store } from './d1Store'
import { returnArrivalsQuery, returnRowsQuery, returnSitesQuery, siteEventsQuery, siteFirstSessionQuery, taggedRowsQuery } from './beacon'
import { DatabaseSync } from 'node:sqlite'
import { campaignSyncStatements, dailyRowUpserts, mergePlacementDayRows, placementDailyUpserts, readingInsert, syncRunInsert, thresholdStateInsert } from '../../src/lib/adsStore'
import { CAMPAIGNS, campaignById } from '../../src/lib/campaigns'
import { clearRegisteredSecrets, redact, redactedFirstLine, registerSecret, summarizeError } from '../../src/lib/adsRedact'
import { createWranglerRunner, repoRoot } from './wrangler'
import {
  buildHeaders,
  createAdsClient,
  fetchDailySpend,
  fetchDevices,
  fetchGeo,
  fetchHourly,
  fetchPlacementDaily,
  fetchRangeTotal,
  fetchRecommendations,
  fetchTargeting,
  searchUrl,
  splitPlacements,
  type FetchLike,
} from '../../src/lib/adsApi'
import { BWS_KEYS, pickAdsCredentials } from './secrets'
import type { ReadingRecord } from '../../src/lib/adsRules'

import { cohortTierQueries, countWhereBody, fencedFetch, readFirebaseCounts } from './firebase'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const retest = campaignById('24279250691')!

describe('Firestore reads: fenced, COUNT-only, degrade on a missing index', () => {
  afterEach(() => clearRegisteredSecrets())
  const base = 'https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents'
  it('the fence allows only the token exchange, GET promos/first50, the masked GET of promos_public/first50 and POST :runAggregationQuery', async () => {
    const f = fencedFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }), base)
    await expect(f('https://oauth2.googleapis.com/token', { method: 'POST', headers: {} })).resolves.toBeTruthy()
    await expect(f(`${base}/promos/first50`, { method: 'GET', headers: {} })).resolves.toBeTruthy()
    await expect(f(`${base}:runAggregationQuery`, { method: 'POST', headers: {} })).resolves.toBeTruthy()
    for (const [url, method] of [
      [`${base}:commit`, 'POST'],
      [`${base}:batchWrite`, 'POST'],
      [`${base}/promos/first50`, 'PATCH'],
      [`${base}/users/abc`, 'GET'],
      [`${base}:runQuery`, 'POST'],
      [`${base}/users/abc`, 'DELETE'],
    ]) {
      expect(() => f(url, { method, headers: {} })).toThrow(/refused/)
    }
  })
  it('every cohort query is a COUNT over users created in the window; lifetime counts as paid', () => {
    const qs = cohortTierQueries('2026-09-26T16:00:00.000Z', '2026-10-03T04:00:00.000Z', '2026-10-17T13:00:00.000Z')
    expect(qs.map(([k]) => k)).toEqual(['total', 'paid', 'accessPast', 'trialPast', 'trialPastAndPaid', 'trialPastAndAccessPast', 'promoSet'])
    for (const [, filters] of qs) {
      const body = countWhereBody(filters) as any
      expect(body.structuredAggregationQuery.aggregations).toEqual([{ alias: 'n', count: {} }])
      expect(JSON.stringify(body)).toContain('"fieldPath":"createdAt"')
    }
    expect('lifetime' > '2026-10-17T13:00:00.000Z').toBe(true) // the 'paid' GREATER_THAN includes the sentinel
  })
  it('a missing composite index yields cohortTiers null and a readable reason; plain counts still come back', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    const sa = path.join(os.tmpdir(), `gss-test-sa-${process.pid}.json`)
    fs.writeFileSync(sa, JSON.stringify({ project_id: 'p', client_email: 'x@p.iam.gserviceaccount.com', private_key: privateKey }))
    const seen: string[] = []
    try {
      const out = await readFirebaseCounts(sa, Date.parse('2026-09-26T16:00:00Z'), Date.parse('2026-10-03T04:00:00Z'), {
        cohortTiersAtMs: Date.parse('2026-10-17T13:00:00Z'),
        fetchImpl: async (url, init) => {
          seen.push(`${init.method} ${url.replace(base, '<docs>')}`)
          if (url.includes('oauth2')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ya29.test-token' }) }
          if (url.endsWith('/promos/first50')) return { ok: true, status: 200, text: async () => JSON.stringify({ fields: { cap: { integerValue: '50' }, claimed: { integerValue: '3' }, closed: { booleanValue: false } } }) }
          const filters = JSON.parse(init.body!).structuredAggregationQuery.structuredQuery.where
          const multiField = filters.compositeFilter && new Set(filters.compositeFilter.filters.map((x: any) => x.fieldFilter.field.fieldPath)).size > 1
          if (multiField) return { ok: false, status: 400, text: async () => JSON.stringify([{ error: { status: 'FAILED_PRECONDITION', message: 'The query requires an index. You can create it here: https://console.firebase.google.com/...' } }]) }
          return { ok: true, status: 200, text: async () => JSON.stringify([{ result: { aggregateFields: { n: { integerValue: '4' } } } }]) }
        },
      })
      expect(out.newAccountsInWindow).toBe(4)
      expect(out.cohortTiers).toBeNull()
      expect(out.errors.join(' ')).toMatch(/cohort paid: needs a Firestore composite index \(not created; owner step\)/)
      expect(out.errors.join(' ')).not.toMatch(/console\.firebase/)
      expect(out.first50).toEqual({ cap: 50, claimed: 3, closed: false })
      expect(seen.every((s) => /^POST https:\/\/oauth2|^POST <docs>:runAggregationQuery$|^GET <docs>\/promos\/first50$|^GET <docs>\/promos_public\/first50\?mask\.fieldPaths=open$/.test(s))).toBe(true)
    } finally {
      fs.rmSync(sa, { force: true })
    }
  })
})

describe('inlineBinds / sqlLiteral', () => {
  it('escapes quotes, keeps numbers, renders NULL, refuses other types', () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'")
    expect(sqlLiteral(1280)).toBe('1280')
    expect(sqlLiteral(null)).toBe('NULL')
    expect(() => sqlLiteral(undefined)).toThrow()
    expect(() => sqlLiteral(Number.NaN)).toThrow()
    expect(() => sqlLiteral({})).toThrow()
  })
  it('replaces placeholders outside literals only, and checks the count', () => {
    expect(inlineBinds("SELECT '?' AS q, ? AS a", [1])).toBe("SELECT '?' AS q, 1 AS a")
    expect(() => inlineBinds('SELECT ?, ?', [1])).toThrow(/more \?/)
    expect(() => inlineBinds('SELECT ?', [1, 2])).toThrow(/mismatch/)
  })
  it('an injected bind value stays inside its literal', () => {
    const sql = inlineBinds('SELECT * FROM hits WHERE campaign = ?', ["x'; DROP TABLE hits; --"])
    expect(() => assertReadOnlySql(sql)).not.toThrow()
    expect(stripSqlLiterals(sql)).toBe("SELECT * FROM hits WHERE campaign = ''")
  })
})

describe('beacon reads are read-only and apply the shared exclusions', () => {
  const queries = [taggedRowsQuery(retest), taggedRowsQuery(retest, Date.parse('2026-09-29T18:26:00Z')), siteEventsQuery(0), siteFirstSessionQuery(0, 1), returnArrivalsQuery(retest, 0, 1), returnRowsQuery(retest), returnSitesQuery(0)]
  it('with an upsell-fix instant, the tagged query flags each row exactly at it (uf), binding the instant first', () => {
    const fix = Date.parse('2026-09-29T18:26:00Z')
    const q = taggedRowsQuery(retest, fix)
    expect(q.sql).toMatch(/^SELECT CAST\(ts \/ 3600000 AS INTEGER\) AS hr, path, visitor, \(ts >= \?\) AS uf, COUNT\(\*\) AS c FROM hits WHERE .* GROUP BY hr, path, visitor, uf$/)
    expect(q.binds[0]).toBe(fix)
    expect(taggedRowsQuery(retest, null).sql).not.toMatch(/\buf\b/)
  })
  it('every beacon query passes the SELECT-only guard after inlining', () => {
    for (const q of queries) expect(() => assertReadOnlySql(inlineBinds(q.sql, q.binds))).not.toThrow()
  })
  it('every beacon query excludes household, Reston verification and lifecycle email', () => {
    for (const q of queries) {
      expect(q.binds).toContain('North Carolina')
      expect(q.binds).toContain('Reston')
      expect(q.binds).toContain('lifecycle')
    }
  })
  it('the tagged query uses the campaign attribution clause (tag + noon-ET start), never a cross-row join', () => {
    const q = taggedRowsQuery(retest)
    expect(q.binds).toContain('sudoku_funnel_retest')
    expect(q.binds).toContain(Date.parse('2026-09-26T16:00:00Z'))
    expect(q.sql).not.toMatch(/\bJOIN\b/i)
  })
  it('the site-wide first-session query names each first-session path in [since, until), arrivals as /return/<uc>/d0, and drops every other path', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE hits (site TEXT, ts INTEGER, path TEXT, visitor TEXT, medium TEXT, campaign TEXT, region TEXT, city TEXT, org TEXT, device TEXT, os TEXT, browser TEXT, screenw INTEGER)')
    const ins = db.prepare("INSERT INTO hits (site, ts, path, visitor, medium, campaign, region, city) VALUES (?, ?, ?, ?, '', '', 'Ohio', 'Columbus')")
    const since = Date.parse('2026-09-30T00:00:00Z')
    for (const [site, ts, p, v] of [
      ['bestsudoku-web', since, '/', 'new'],
      ['bestsudoku-web', since, '/game', 'new'],
      ['bestsudoku-web', since, '/game', 'returning'],
      ['bestsudoku-web', since, '/tour/start', 'returning'],
      ['bestsudoku-web', since, '/game/abandon/1-25', 'returning'],
      ['bestsudoku-web', since, '/signin-prompt/tutorial', 'returning'],
      ['bestsudoku-web', since, '/welcome-signed-in/shown', 'returning'],
      ['bestsudoku-web', since, '/settings', 'returning'],
      ['bestsudoku-web', since, '/return/sudoku_funnel_retest/d0', 'new'],
      ['bestsudoku-web', since, '/return/other_flight/d0', 'new'],
      ['bestsudoku-web', since, '/return/other_flight/d1', 'returning'],
      ['bestsudoku-web', since - 1, '/tour/start', 'new'], // before the window
      ['bestsudoku-web', since + 3_600_000, '/tour/start', 'new'], // at the (exclusive) end
      ['bestsudoku-app', since, '/tour/start', 'new'], // another site
    ] as const) ins.run(site, ts, p, v)
    const q = siteFirstSessionQuery(since, since + 3_600_000)
    const rows = db.prepare(q.sql).all(...(q.binds as (string | number)[])) as { p: string; c: number }[]
    const by = Object.fromEntries(rows.map((r) => [r.p, r.c]))
    expect(by).toEqual({
      '/game': 2,
      '/tour/start': 1,
      '/game/abandon/1-25': 1,
      '/signin-prompt/tutorial': 1,
      '/welcome-signed-in/shown': 1,
      '/return/sudoku_funnel_retest/d0': 1,
      '/return/other_flight/d0': 1,
    })
  })
  it('the tagged arrivals query counts only this campaign\'s /return/<uc>/d0 rows, web and app, in [since, until)', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE hits (site TEXT, ts INTEGER, path TEXT, visitor TEXT, medium TEXT, campaign TEXT, region TEXT, city TEXT, org TEXT, device TEXT, os TEXT, browser TEXT, screenw INTEGER)')
    const ins = db.prepare("INSERT INTO hits (site, ts, path, visitor, medium, campaign, region, city) VALUES (?, ?, ?, 'new', '', '', 'Ohio', 'Columbus')")
    const since = Date.parse('2026-09-30T00:00:00Z')
    const d0 = `/return/${retest.ucValues[0]}/d0`
    for (const [site, ts, p] of [
      ['bestsudoku-web', since, d0],
      ['bestsudoku-web', since + 5, d0],
      ['bestsudoku-app', since, d0],
      ['bestsudoku-web', since, `/return/${retest.ucValues[0]}/d1`],
      ['bestsudoku-web', since, '/return/other_flight/d0'],
      ['bestsudoku-web', since - 1, d0], // before the window
      ['bestsudoku-web', since + 3_600_000, d0], // at the (exclusive) end
    ] as const) ins.run(site, ts, p)
    const q = returnArrivalsQuery(retest, since, since + 3_600_000)
    const rows = db.prepare(q.sql).all(...(q.binds as (string | number)[])) as { path: string; c: number }[]
    expect(rows).toEqual([{ path: d0, c: 3 }])
  })
  it('the guard rejects writes, multiple statements, comments and non-SELECTs', () => {
    for (const bad of ['DELETE FROM hits', 'SELECT 1; DROP TABLE hits', 'SELECT 1 -- x', 'PRAGMA table_info(hits)', 'INSERT INTO hits VALUES (1)', 'WITH x AS (SELECT 1) DELETE FROM hits']) {
      expect(() => assertReadOnlySql(bad)).toThrow()
    }
  })
  it('createD1Select never spawns wrangler for a rejected statement', async () => {
    let spawned = false
    const sel = createD1Select(async () => {
      spawned = true
      return { code: 0, stdout: '[]', stderr: '' }
    })
    await expect(sel('DELETE FROM hits')).rejects.toThrow()
    expect(spawned).toBe(false)
  })
  it('parseD1Json reads the results array and refuses an unsuccessful response', () => {
    expect(parseD1Json('banner\n[{"results":[{"n":1}],"success":true}]')).toEqual([{ n: 1 }])
    expect(() => parseD1Json('[{"results":[],"success":false}]')).toThrow()
  })
  it('a "▲ [WARNING]" banner before the JSON is skipped, and meta.changes is read', () => {
    expect(parseD1Response('▲ [WARNING] update available\n[{"results":[],"success":true,"meta":{"changes":0}}]')).toEqual({ results: [], changes: 0 })
    expect(parseD1Response('[{"results":[],"success":true}]').changes).toBeNull()
  })
})

describe('ads store write guard', () => {
  const rec: ReadingRecord = {
    v: 1, id: 'k', campaignId: '24279250691', kind: 'threshold', readAt: 'x', etDate: '2026-09-30', spendThroughEt: null,
    cumulativeSpend: 50, thresholds: [50], complete: true, rules: null, proposal: 'CONTINUE', decision: null, counts: {}, notes: ['DROP; DELETE -- in a literal'],
  }
  it('accepts every statement the shared builders produce', () => {
    const stmts = [
      ...campaignSyncStatements(CAMPAIGNS, 'x'),
      ...dailyRowUpserts('24279250691', [{ date: '2026-09-27', costMicros: 1, impressions: 1, clicks: 0, fetchedAt: 'x', placementsFetchedAt: null }]),
      syncRunInsert({ runKey: 'k', source: 'ads-sync', startedAt: 'a', finishedAt: 'b', campaigns: ['1'], campaignsOk: [], campaignsPulled: [], daysFetched: 0, daysChanged: 0, placementRowsFetched: 0, placementRowsChanged: 0, status: 'failed', error: "DROP; it's", detail: {} }),
      ...placementDailyUpserts('24279250691', [{ date: '2026-09-27', placement: 'p', displayName: "it's", type: null, targetUrl: null, approved: true, costMicros: 1, impressions: 1, clicks: 0 }], 'x'),
      readingInsert(rec),
      thresholdStateInsert(rec)!,
    ]
    for (const s of stmts) expect(() => assertAdsWriteSql(inlineBinds(s.sql, s.binds))).not.toThrow()
  })
  it('rejects deletes, other tables, bare updates, DDL and multiple statements', () => {
    for (const bad of [
      'DELETE FROM ads_readings',
      'INSERT INTO hits (path) VALUES (1)',
      'UPDATE ads_readings SET complete = 0',
      'INSERT INTO ads_readings (id) VALUES (1); DROP TABLE ads_readings',
      'INSERT INTO ads_readings (id) SELECT 1 FROM ads_readings WHERE 1 = 1 AND UPDATE',
      'DROP TABLE ads_readings',
    ]) {
      expect(() => assertAdsWriteSql(bad)).toThrow()
    }
  })
  it('the store refuses to target the beacon database', () => {
    expect(() => createD1Store({ run: async () => ({ code: 0, stdout: '', stderr: '' }), dryRun: true, database: 'gss-geo' })).toThrow(/gss-geo/)
  })
  it('L3: the store is an allowlist — any database other than gss-stats-ads is refused', () => {
    expect(() => createD1Store({ run: async () => ({ code: 0, stdout: '', stderr: '' }), dryRun: true, database: 'gss-stats-ads-copy' })).toThrow(/only targets gss-stats-ads/)
    expect(() => createD1Store({ run: async () => ({ code: 0, stdout: '', stderr: '' }), dryRun: true })).not.toThrow()
  })
  it('L5: duplicate (date, placement) rows are summed before the upsert', () => {
    const merged = mergePlacementDayRows([
      { date: '2026-09-27', placement: 'mobileapp::2-a', displayName: 'A', type: null, targetUrl: null, approved: true, costMicros: 1_000_000, impressions: 10, clicks: 1 },
      { date: '2026-09-27', placement: 'mobileapp::2-a', displayName: 'A', type: null, targetUrl: null, approved: true, costMicros: 2_500_000, impressions: 5, clicks: 0 },
      { date: '2026-09-28', placement: 'mobileapp::2-a', displayName: 'A', type: null, targetUrl: null, approved: true, costMicros: 1, impressions: 1, clicks: 0 },
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ date: '2026-09-27', costMicros: 3_500_000, impressions: 15, clicks: 1 })
    const [st] = placementDailyUpserts('24279250691', merged.concat(merged), 'x')
    expect(st.binds.length).toBe(2 * 11) // one row per key reaches the upsert
  })
  it('--dry-run spawns no write at all', async () => {
    const calls: string[][] = []
    const store = createD1Store({
      run: async (args) => {
        calls.push(args)
        return { code: 0, stdout: '[{"results":[],"success":true}]', stderr: '' }
      },
      dryRun: true,
    })
    expect(await store.appendReadings([rec])).toEqual({ written: false, inserted: [], ignored: [] })
    expect(await store.putDailyRows('24279250691', [{ date: '2026-09-27', costMicros: 1, impressions: 1, clicks: 0, fetchedAt: 'x', placementsFetchedAt: null }])).toBe(false)
    expect(await store.appendSyncRun({ runKey: 'k', source: 'ads-sync', startedAt: 'a', finishedAt: 'b', campaigns: [], campaignsOk: [], campaignsPulled: [], daysFetched: 0, daysChanged: 0, placementRowsFetched: 0, placementRowsChanged: 0, status: 'ok', error: null, detail: {} })).toBe(false)
    expect(await store.syncCampaigns(CAMPAIGNS, 'x')).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('L8/L9/L10: timeouts, failure summaries, stored notes', () => {
  afterEach(() => clearRegisteredSecrets())
  it('a wrangler call that runs past the timeout is killed and reported as timed out', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gss-wr-'))
    const bin = path.join(root, 'node_modules', 'wrangler', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'wrangler.js'), 'setTimeout(() => {}, 30000)\n')
    try {
      const run = createWranglerRunner({ root, timeoutMs: 300 })
      const res = await run(['d1', 'execute', 'gss-geo'])
      expect(res.code).toBe(124)
      expect(res.stderr).toMatch(/^wrangler d1 execute timed out after \d+s$/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
  it('summarizeError gives a useful, redacted, path-free first line without the read label', () => {
    registerSecret('super-secret-developer-token-123')
    expect(summarizeError('ads daily: Google Ads search failed, HTTP 403: denied super-secret-developer-token-123\nstack…')).toBe('Google Ads search failed, HTTP 403: denied <redacted>')
    expect(summarizeError('beacon tagged: wrangler d1 execute failed (exit 1): at C:\\Users\\msant\\dev\\x.js')).toBe('wrangler d1 execute failed (exit 1): at <path>')
    expect(summarizeError('store write (readings): ' + 'x'.repeat(200)).length).toBeLessThanOrEqual(70)
    expect(summarizeError('')).toBe('unknown error')
  })
  it('stored reading notes never carry a local path', () => {
    const st = readingInsert({
      v: 1, id: 'k', campaignId: '24279250691', kind: 'daily', readAt: 'x', etDate: '2026-09-30', spendThroughEt: null, cumulativeSpend: null,
      thresholds: [], complete: false, rules: null, proposal: null, decision: null, counts: {}, notes: ['incomplete: wrangler not installed at C:\\Users\\msant\\dev\\gss\\node_modules\\wrangler\\bin\\wrangler.js'],
    })
    expect(JSON.parse(st.binds[14] as string)).toEqual(['incomplete: wrangler not installed at <path>'])
  })
})

describe('secret hygiene', () => {
  afterEach(() => clearRegisteredSecrets())
  it('masks registered secrets and credential-shaped strings', () => {
    registerSecret('super-secret-developer-token-123')
    expect(redact('failed with super-secret-developer-token-123 in body')).toBe('failed with <redacted> in body')
    expect(redact('Authorization: Bearer ya29.a0AfH6SMBx-abc.def')).not.toMatch(/ya29/)
    expect(redact('"refresh_token": "1//0gABCDEF-xyz"')).not.toMatch(/1\/\/0g/)
    expect(redact('x'.repeat(10) + 'A'.repeat(45))).toContain('<redacted>')
    expect(redactedFirstLine('\n  Error: token super-secret-developer-token-123 invalid\nmore')).toBe('Error: token <redacted> invalid')
  })
  it('the bws picker reports missing KEY NAMES only, never values', () => {
    const { creds, missing } = pickAdsCredentials([{ key: BWS_KEYS.clientId, value: 'cid-value' }, { key: 'unrelated', value: 'other-secret' }])
    expect(creds).toBeNull()
    expect(missing).toEqual([BWS_KEYS.clientSecret, BWS_KEYS.refreshToken, BWS_KEYS.developerToken])
    expect(JSON.stringify(missing)).not.toContain('cid-value')
    const all = Object.values(BWS_KEYS).map((key) => ({ key, value: `${key}-v` }))
    expect(pickAdsCredentials(all).creds).toEqual({
      clientId: `${BWS_KEYS.clientId}-v`,
      clientSecret: `${BWS_KEYS.clientSecret}-v`,
      refreshToken: `${BWS_KEYS.refreshToken}-v`,
      developerToken: `${BWS_KEYS.developerToken}-v`,
    })
  })
})

describe('Google Ads client: read-only, no manager header', () => {
  afterEach(() => clearRegisteredSecrets())
  const creds = { clientId: 'cid', clientSecret: 'csecret-value-xyz', refreshToken: 'rtoken-value-xyz', developerToken: 'devtoken-value-xyz' }
  function fakeFetch(pages: unknown[], opts: { tokenStatus?: number; searchStatus?: number } = {}) {
    const calls: { url: string; headers: Record<string, string>; body?: string }[] = []
    let page = 0
    const f: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body })
      if (url.includes('oauth2')) {
        return { ok: (opts.tokenStatus ?? 200) === 200, status: opts.tokenStatus ?? 200, text: async () => (opts.tokenStatus ? JSON.stringify({ error: 'invalid_grant' }) : JSON.stringify({ access_token: 'ya29.fake-access-token' })) }
      }
      if (opts.searchStatus) return { ok: false, status: opts.searchStatus, text: async () => JSON.stringify({ error: { message: 'PERMISSION_DENIED devtoken-value-xyz' } }) }
      return { ok: true, status: 200, text: async () => JSON.stringify(pages[page++] ?? { results: [] }) }
    }
    return { f, calls }
  }
  it('builds headers without login-customer-id and targets googleAds:search on customer 8726535246, API v25', () => {
    expect(Object.keys(buildHeaders('a', 'b')).map((k) => k.toLowerCase())).not.toContain('login-customer-id')
    expect(searchUrl()).toBe('https://googleads.googleapis.com/v25/customers/8726535246/googleAds:search')
  })
  it('refreshes the token, sends only authorization + developer-token, follows pagination', async () => {
    process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = '2775673007' // must be ignored
    try {
      const { f, calls } = fakeFetch([
        { results: [{ segments: { date: '2026-09-26' }, metrics: { costMicros: '10500000', impressions: '2600', clicks: '21' } }], nextPageToken: 'p2' },
        { results: [{ segments: { date: '2026-09-27' }, metrics: { costMicros: '13200000', impressions: '5100', clicks: '40' } }] },
      ])
      const client = await createAdsClient(creds, { fetchImpl: f })
      const days = await fetchDailySpend(client, '24279250691', '2026-09-26', '2026-09-27')
      expect(days['2026-09-27']).toEqual({ costMicros: 13_200_000, impressions: 5100, clicks: 40 })
      const searches = calls.filter((c) => c.url.includes('googleAds:search'))
      expect(searches).toHaveLength(2)
      for (const c of searches) {
        expect(Object.keys(c.headers).map((k) => k.toLowerCase()).sort()).toEqual(['authorization', 'content-type', 'developer-token'])
        expect(JSON.parse(c.body!).query).toMatch(/^SELECT segments\.date, metrics\.cost_micros/)
      }
      expect(JSON.parse(searches[1].body!).pageToken).toBe('p2')
    } finally {
      delete process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
    }
  })
  it('the range total (review L1) is one SELECT without segments.date in the SELECT list; null when Google returns no row', async () => {
    const { f, calls } = fakeFetch([{ results: [{ metrics: { costMicros: '17300000', impressions: '7700', clicks: '61' } }] }, { results: [] }])
    const client = await createAdsClient(creds, { fetchImpl: f })
    expect(await fetchRangeTotal(client, '24279250691', '2026-09-26', '2026-09-27')).toEqual({ costMicros: 17_300_000, impressions: 7700, clicks: 61 })
    expect(await fetchRangeTotal(client, '24279250691', '2026-09-28', '2026-09-28')).toBeNull()
    const q = JSON.parse(calls.filter((c) => c.url.includes('googleAds:search'))[0].body!).query as string
    expect(q).toBe("SELECT metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign WHERE campaign.id = 24279250691 AND segments.date BETWEEN '2026-09-26' AND '2026-09-27'")
    await expect(fetchRangeTotal(client, '111111111', '2026-09-26', '2026-09-27')).rejects.toThrow()
  })
  it('refuses anything that is not a GAQL SELECT', async () => {
    const client = await createAdsClient(creds, { fetchImpl: fakeFetch([]).f })
    await expect(client.search('mutate campaign')).rejects.toThrow(/SELECT/)
  })
  it('errors never carry a credential', async () => {
    const tokenFail = createAdsClient(creds, { fetchImpl: fakeFetch([], { tokenStatus: 400 }).f })
    await expect(tokenFail).rejects.toThrow(/OAuth refresh failed/)
    registerSecret(creds.developerToken)
    const client = await createAdsClient(creds, { fetchImpl: fakeFetch([], { searchStatus: 403 }).f })
    const err = await fetchDailySpend(client, '24279250691', '2026-09-26', '2026-09-27').catch((e) => String(e))
    expect(err).toMatch(/HTTP 403/)
    expect(err).not.toContain('devtoken-value-xyz')
  })
  it('placement rows are tagged against the campaign list and split into approved / itemized', async () => {
    const { f } = fakeFetch([
      {
        results: [
          { segments: { date: '2026-09-27' }, groupPlacementView: { placement: 'mobileapp::2-com.easybrain.sudoku.android', displayName: 'Sudoku.com' }, metrics: { costMicros: '9000000', impressions: '100', clicks: '2' } },
          { segments: { date: '2026-09-27' }, groupPlacementView: { placement: 'mobileapp::2-com.example.other', displayName: 'Other' }, metrics: { costMicros: '1000000', impressions: '10', clicks: '0' } },
          { segments: { date: '2026-09-28' }, groupPlacementView: { placement: 'mobileapp::2-com.example.other', displayName: 'Other' }, metrics: { costMicros: '5000000', impressions: '10', clicks: '0' } },
        ],
      },
    ])
    const client = await createAdsClient(creds, { fetchImpl: f })
    const rows = await fetchPlacementDaily(client, '24279250691', '2026-09-26', '2026-09-28')
    expect(rows.map((r) => r.approved)).toEqual([true, false, false])
    const split = splitPlacements(rows, '2026-09-27')
    expect(split).toMatchObject({ itemizedCost: 10, approvedCost: 9 })
    expect(split.byPlacement[1]).toMatchObject({ placement: 'mobileapp::2-com.example.other', approved: false, costMicros: 1_000_000 })
  })
  it('a metric read of an unknown campaign is refused before any request', async () => {
    const { f, calls } = fakeFetch([])
    const client = await createAdsClient(creds, { fetchImpl: f })
    await expect(fetchDailySpend(client, '111111111', '2026-09-26', '2026-09-27')).rejects.toThrow()
    expect(calls.filter((c) => c.url.includes('googleAds:search'))).toHaveLength(0)
  })

  describe('diagnostic depth (R2/R3): hourly, geo, devices, targeting, recommendations — informational only', () => {
    it('hourly: per (day, hour) in account time zone, zero rows dropped', async () => {
      const { f, calls } = fakeFetch([
        {
          results: [
            { segments: { date: '2026-09-27', hour: '13' }, metrics: { impressions: '120', clicks: '3', ctr: '0.025', costMicros: '900000' } },
            { segments: { date: '2026-09-27', hour: '2' }, metrics: { impressions: '0', clicks: '0', ctr: '0', costMicros: '0' } },
          ],
        },
      ])
      const client = await createAdsClient(creds, { fetchImpl: f })
      const rows = await fetchHourly(client, '24279250691', '2026-09-27', '2026-09-27')
      expect(rows).toEqual([{ date: '2026-09-27', hour: 13, impressions: 120, clicks: 3, ctr: 0.025, cost: 0.9 }])
      const q = JSON.parse(calls.find((c) => c.url.includes('googleAds:search'))!.body!).query as string
      expect(q).toMatch(/^SELECT segments\.date, segments\.hour, metrics\.impressions/)
    })
    it('geo: per-country delivery joined to the LIVE bid modifier, sorted by cost descending', async () => {
      const { f } = fakeFetch([
        { results: [{ geographicView: { countryCriterionId: '2840' }, metrics: { impressions: '500', clicks: '10', costMicros: '3000000' } }, { geographicView: { countryCriterionId: '2826' }, metrics: { impressions: '200', clicks: '2', costMicros: '500000' } }] },
        { results: [{ campaignCriterion: { location: { geoTargetConstant: 'geoTargetConstants/2826' }, bidModifier: 0.25 } }] },
        { results: [{ geoTargetConstant: { id: '2840', name: 'United States', countryCode: 'US' } }, { geoTargetConstant: { id: '2826', name: 'United Kingdom', countryCode: 'GB' } }] },
      ])
      const client = await createAdsClient(creds, { fetchImpl: f })
      const rows = await fetchGeo(client, '24279250691', '2026-09-27', '2026-09-27')
      expect(rows).toEqual([
        { criterionId: '2840', country: 'United States', countryCode: 'US', impressions: 500, clicks: 10, ctr: 0.02, cost: 3, bidModifier: null, bidAdjustmentPct: null },
        { criterionId: '2826', country: 'United Kingdom', countryCode: 'GB', impressions: 200, clicks: 2, ctr: 0.01, cost: 0.5, bidModifier: 0.25, bidAdjustmentPct: -75 },
      ])
    })
    it('devices: aggregated by the REST enum name directly (no int mapping needed)', async () => {
      const { f } = fakeFetch([
        { results: [{ segments: { device: 'MOBILE' }, metrics: { impressions: '1000', clicks: '20', costMicros: '5000000' } }, { segments: { device: 'DESKTOP' }, metrics: { impressions: '0', clicks: '0', costMicros: '0' } }] },
      ])
      const client = await createAdsClient(creds, { fetchImpl: f })
      const rows = await fetchDevices(client, '24279250691', '2026-09-27', '2026-09-27')
      expect(rows).toEqual([
        { device: 'MOBILE', impressions: 1000, clicks: 20, ctr: 0.02, cost: 5 },
        { device: 'DESKTOP', impressions: 0, clicks: 0, ctr: 0, cost: 0 },
      ])
    })
    it('targeting: placement counts from PLACEMENT + MOBILE_APPLICATION criteria, audience bid-only flag', async () => {
      const { f } = fakeFetch([
        {
          results: [
            { adGroup: { id: '199141743526', name: 'Sudoku.com placement', status: 'ENABLED', targetingSetting: { targetRestrictions: [{ targetingDimension: 'AUDIENCE', bidOnly: true }] } } },
            { adGroup: { id: '201162129980', name: 'Other Sudoku placements', status: 'ENABLED', targetingSetting: {} } },
          ],
        },
        { results: [{ adGroup: { name: 'Sudoku.com placement' }, adGroupCriterion: { criterionId: '1', type: 'MOBILE_APPLICATION' } }] },
      ])
      const client = await createAdsClient(creds, { fetchImpl: f })
      const rows = await fetchTargeting(client, '24279250691')
      expect(rows).toEqual([
        { adGroup: 'Sudoku.com placement', status: 'ENABLED', placements: 1, audienceBidOnly: true },
        { adGroup: 'Other Sudoku placements', status: 'ENABLED', placements: 0, audienceBidOnly: null },
      ])
    })
    it('recommendations: read-only list, filtered client-side to this campaign; never mutates or dismisses', async () => {
      const { f, calls } = fakeFetch([
        {
          results: [
            { recommendation: { resourceName: 'customers/8726535246/recommendations/111', type: 'MAXIMIZE_CONVERSIONS_OPT_IN', campaign: 'customers/8726535246/campaigns/24279250691' } },
            { recommendation: { resourceName: 'customers/8726535246/recommendations/222', type: 'OPTIMIZE_AD_ROTATION', campaign: 'customers/8726535246/campaigns/24234347705' } },
          ],
        },
      ])
      const client = await createAdsClient(creds, { fetchImpl: f })
      const rows = await fetchRecommendations(client, '8726535246', '24279250691')
      expect(rows).toEqual([{ type: 'MAXIMIZE_CONVERSIONS_OPT_IN', resourceName: 'customers/8726535246/recommendations/111' }])
      const q = JSON.parse(calls.find((c) => c.url.includes('googleAds:search'))!.body!).query as string
      expect(q).toMatch(/^SELECT recommendation\.resource_name/)
    })
    it('every diagnostic read refuses an unknown campaign before any request', async () => {
      const { f, calls } = fakeFetch([])
      const client = await createAdsClient(creds, { fetchImpl: f })
      await expect(fetchHourly(client, '111111111', '2026-09-27', '2026-09-27')).rejects.toThrow()
      await expect(fetchGeo(client, '111111111', '2026-09-27', '2026-09-27')).rejects.toThrow()
      await expect(fetchDevices(client, '111111111', '2026-09-27', '2026-09-27')).rejects.toThrow()
      await expect(fetchTargeting(client, '111111111')).rejects.toThrow()
      await expect(fetchRecommendations(client, '8726535246', '111111111')).rejects.toThrow()
      expect(calls.filter((c) => c.url.includes('googleAds:search'))).toHaveLength(0)
    })
  })
})

describe('ONE fetch path: only the shared sync pulls Ads metrics (owner, 2026-09-26)', () => {
  const root = repoRoot()
  const listTs = (dir: string): string[] => {
    const abs = path.join(root, dir)
    if (!fs.existsSync(abs)) return []
    return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
      const rel = path.posix.join(dir, e.name)
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : listTs(rel)
      return /\.(ts|vue)$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [rel] : []
    })
  }
  const files = [...listTs('scripts/ads-reads'), ...listTs('src'), ...listTs('functions'), ...listTs('workers')]
  it('no module but src/lib/adsSync.ts calls a metrics source (.daily / .placements)', () => {
    expect(files).toContain('src/lib/adsSync.ts')
    for (const f of files) {
      if (f === 'src/lib/adsSync.ts') continue
      expect([f, /\.(daily|placements)\(/.test(fs.readFileSync(path.join(root, f), 'utf8'))]).toEqual([f, false])
    }
  })
  it('the raw Ads fetchers are only wrapped into a source by the adapters, never called by a read', () => {
    const allowed = ['src/lib/adsApi.ts', 'scripts/ads-reads/cli.ts', 'workers/sync/src/index.ts']
    for (const f of files) {
      if (allowed.includes(f)) continue
      expect([f, /fetch(DailySpend|PlacementDaily)\(/.test(fs.readFileSync(path.join(root, f), 'utf8'))]).toEqual([f, false])
    }
  })
})
