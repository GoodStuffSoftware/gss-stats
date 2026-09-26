// Safety guards: read-only beacon SQL, the ads-store write guard, bind inlining, secret
// redaction, and the read-only Google Ads client (no manager header, SELECT only).
import { afterEach, describe, expect, it } from 'vitest'
import { assertReadOnlySql, createD1Select, inlineBinds, parseD1Json, sqlLiteral, stripSqlLiterals } from './d1'
import { assertAdsWriteSql, createD1Store } from './d1Store'
import { returnRowsQuery, returnSitesQuery, siteEventsQuery, taggedRowsQuery } from './beacon'
import { campaignSyncStatement, dailyMetricsUpserts, placementDailyUpserts, readingInsert, thresholdStateInsert } from '../../src/lib/adsStore'
import { CAMPAIGNS, campaignById } from '../../src/lib/campaigns'
import { clearRegisteredSecrets, redact, redactedFirstLine, registerSecret } from './redact'
import { buildHeaders, createAdsClient, fetchDailySpend, fetchPlacementDaily, searchUrl, splitPlacements, type FetchLike } from './adsApi'
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
  it('the fence allows only the token exchange, GET promos/first50 and POST :runAggregationQuery', async () => {
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
      expect(seen.every((s) => /^POST https:\/\/oauth2|^POST <docs>:runAggregationQuery$|^GET <docs>\/promos\/first50$/.test(s))).toBe(true)
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
  const queries = [taggedRowsQuery(retest), siteEventsQuery(0), returnRowsQuery(retest), returnSitesQuery(0)]
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
})

describe('ads store write guard', () => {
  const rec: ReadingRecord = {
    v: 1, id: 'k', campaignId: '24279250691', kind: 'threshold', readAt: 'x', etDate: '2026-09-30', spendThroughEt: null,
    cumulativeSpend: 50, thresholds: [50], complete: true, rules: null, proposal: 'CONTINUE', decision: null, counts: {}, notes: ['DROP; DELETE -- in a literal'],
  }
  it('accepts every statement the shared builders produce', () => {
    const stmts = [
      campaignSyncStatement(CAMPAIGNS, 'x'),
      ...dailyMetricsUpserts('24279250691', { '2026-09-27': { costMicros: 1, impressions: 1, clicks: 0 } }, 'x'),
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
  it('--dry-run spawns no write at all', async () => {
    const calls: string[][] = []
    const store = createD1Store({
      run: async (args) => {
        calls.push(args)
        return { code: 0, stdout: '[{"results":[],"success":true}]', stderr: '' }
      },
      dryRun: true,
    })
    expect(await store.appendReadings([rec])).toBe(false)
    expect(await store.putDailyMetrics('24279250691', { '2026-09-27': { costMicros: 1, impressions: 1, clicks: 0 } }, 'x')).toBe(false)
    expect(await store.syncCampaigns(CAMPAIGNS, 'x')).toBe(false)
    expect(calls).toEqual([])
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
})
