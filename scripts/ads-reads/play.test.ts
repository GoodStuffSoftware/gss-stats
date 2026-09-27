// R4: the Play bulk-reports reader — pure CSV shaping, the fence, checkpoint logic, and a
// full readPlayReports() run against a fake fetch harness (same pattern as guards.test.ts's
// Firestore tests). No network, no real credential.
import { afterEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clearRegisteredSecrets } from '../../src/lib/adsRedact'
import {
  checkpoint,
  decodeCsvBuffer,
  DEFAULT_BUCKET,
  fencedPlayFetch,
  filterDateRange,
  HOUSEHOLD_NOTE,
  monthsBetween,
  normalizeDate,
  parseCsvText,
  readPlayReports,
  RETENTION_NOTE,
  rowsToRecords,
  shapeInstallsOverview,
  shapeStorePerformance,
} from './play'

afterEach(() => clearRegisteredSecrets())

describe('decodeCsvBuffer', () => {
  it('strips a UTF-16LE BOM (the real bulk-report encoding) and decodes correctly', () => {
    const text = 'Date,Daily Device Installs\n2026-09-26,3\n'
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    expect(decodeCsvBuffer(buf)).toBe(text)
  })
  it('strips a UTF-8 BOM and falls back to plain UTF-8 with no BOM at all', () => {
    const text = 'Date,x\n2026-09-26,1\n'
    expect(decodeCsvBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]))).toBe(text)
    expect(decodeCsvBuffer(Buffer.from(text, 'utf8'))).toBe(text)
  })
})

describe('parseCsvText / rowsToRecords', () => {
  it('parses quoted fields with an escaped quote, and CRLF rows', () => {
    const rows = parseCsvText('a,b\r\n"x, ""y""",2\r\n')
    expect(rows).toEqual([['a', 'b'], ['x, "y"', '2']])
  })
  it('maps header to each row by name', () => {
    const { header, records } = rowsToRecords(parseCsvText('Date,Count\n2026-09-26,3\n2026-09-27,\n'))
    expect(header).toEqual(['Date', 'Count'])
    expect(records).toEqual([
      { Date: '2026-09-26', Count: '3' },
      { Date: '2026-09-27', Count: '' },
    ])
  })
})

describe('normalizeDate', () => {
  it('passes ISO through, and converts YYYYMMDD and M/D/YYYY', () => {
    expect(normalizeDate('2026-09-26')).toBe('2026-09-26')
    expect(normalizeDate('20260926')).toBe('2026-09-26')
    expect(normalizeDate('9/26/2026')).toBe('2026-09-26')
  })
})

describe('shapeInstallsOverview — real bulk-report header (verified live 2026-09-27)', () => {
  const REAL_HEADER = 'Date,Package name,Daily Device Installs,Daily Device Uninstalls,Daily Device Upgrades,Total User Installs,Daily User Installs,Daily User Uninstalls,Active Device Installs,Install events,Update events,Uninstall events'
  it('reads device/user installs and active devices by the real column names', () => {
    const csv = `${REAL_HEADER}\n2026-09-26,com.bestsudoku.app,2,0,0,0,2,0,5,2,0,0\n`
    const rows = shapeInstallsOverview(rowsToRecords(parseCsvText(csv)))
    expect(rows).toEqual([{ date: '2026-09-26', deviceInstalls: 2, userInstalls: 2, deviceUninstalls: 0, activeDeviceInstalls: 5 }])
  })
})

describe('shapeStorePerformance — regression: the real country column is "Country / region", not "Country"', () => {
  const REAL_COUNTRY_HEADER = 'Date,Package name,Country / region,Store listing acquisitions,Store listing visitors,Store listing conversion rate'
  it('finds the dimension column via the real alias, not just "Country"', () => {
    const csv = `${REAL_COUNTRY_HEADER}\n2026-09-26,com.bestsudoku.app,Other,1,3,0.333\n`
    const rows = shapeStorePerformance(rowsToRecords(parseCsvText(csv)), ['Country / region', 'Country'])
    expect(rows).toEqual([{ date: '2026-09-26', dimension: 'Other', visitors: 3, acquisitions: 1, conversionRate: 0.333 }])
  })
  it('would have silently lost the dimension with only the old alias list (proves the bug this fixes)', () => {
    const csv = `${REAL_COUNTRY_HEADER}\n2026-09-26,com.bestsudoku.app,Other,1,3,0.333\n`
    const rows = shapeStorePerformance(rowsToRecords(parseCsvText(csv)), ['Country']) // old script's alias list
    expect(rows[0].dimension).toBeNull() // confirms the real header does not match "Country" alone
  })
  const REAL_SOURCE_HEADER = 'Date,Package name,Traffic source,Search term,UTM source,UTM campaign,Store listing acquisitions,Store listing visitors,Store listing conversion rate'
  it('reads the traffic-source file by its real column name', () => {
    const csv = `${REAL_SOURCE_HEADER}\n2026-09-26,com.bestsudoku.app,Google Ads,Other,google,sudoku_funnel_retest,1,10,0.1\n`
    const rows = shapeStorePerformance(rowsToRecords(parseCsvText(csv)), ['Traffic source', 'Traffic Source'])
    expect(rows).toEqual([{ date: '2026-09-26', dimension: 'Google Ads', visitors: 10, acquisitions: 1, conversionRate: 0.1 }])
  })
})

describe('monthsBetween / filterDateRange', () => {
  it('spans a year boundary inclusively', () => {
    expect(monthsBetween('2026-11-15', '2027-01-10')).toEqual(['202611', '202612', '202701'])
  })
  it('filters rows to [since, until] inclusive', () => {
    const rows = [{ date: '2026-09-25' }, { date: '2026-09-26' }, { date: '2026-09-27' }]
    expect(filterDateRange(rows, '2026-09-26', '2026-09-27')).toEqual([{ date: '2026-09-26' }, { date: '2026-09-27' }])
  })
})

describe('fencedPlayFetch — the only requests this module may make', () => {
  const bucket = 'pubsite_prod_test'
  it('allows the token POST and a GET under this bucket\'s storage API only', async () => {
    const f = fencedPlayFetch(async () => ({ ok: true, status: 200, text: async () => '{}', arrayBuffer: async () => new ArrayBuffer(0) }), bucket)
    await expect(f('https://oauth2.googleapis.com/token', { method: 'POST', headers: {} })).resolves.toBeTruthy()
    await expect(f(`https://storage.googleapis.com/storage/v1/b/${bucket}/o?prefix=stats/`, { method: 'GET', headers: {} })).resolves.toBeTruthy()
  })
  it('refuses a different bucket, a write method, or any other host', () => {
    const f = fencedPlayFetch(async () => ({ ok: true, status: 200, text: async () => '{}', arrayBuffer: async () => new ArrayBuffer(0) }), bucket)
    expect(() => f(`https://storage.googleapis.com/storage/v1/b/some-other-bucket/o`, { method: 'GET', headers: {} })).toThrow(/refused/)
    expect(() => f(`https://storage.googleapis.com/storage/v1/b/${bucket}/o`, { method: 'DELETE', headers: {} })).toThrow(/refused/)
    expect(() => f(`https://storage.googleapis.com/storage/v1/b/${bucket}/o`, { method: 'POST', headers: {} })).toThrow(/refused/)
    expect(() => f('https://evil.example.com/token', { method: 'POST', headers: {} })).toThrow(/refused/)
  })
})

describe('checkpoint — informational only, matches the old routines\' "undecidable" precedent', () => {
  it('reads "not yet crossed" below the threshold', () => {
    expect(checkpoint(50, 13.12, '2026-09-26', '2026-09-20').status).toBe('not yet crossed')
  })
  it('reads "undecidable" once crossed but the horizon has not reached the flight start', () => {
    const c = checkpoint(50, 55, '2026-09-26', '2026-09-20')
    expect(c.status).toBe('undecidable')
    expect(c.crossed).toBe(true)
    expect(c.detail).toMatch(/undecidable/)
  })
  it('reads "read" once crossed and the horizon covers the flight start', () => {
    const c = checkpoint(50, 55, '2026-09-26', '2026-10-01')
    expect(c.status).toBe('read')
  })
  it('reads "undecidable" with no install data at all yet', () => {
    expect(checkpoint(75, 80, '2026-09-26', null).status).toBe('undecidable')
  })
})

describe('readPlayReports — end to end against a fake GCS harness', () => {
  const rsa = () => generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  const tmpSa = (privateKey: string) => {
    const p = path.join(os.tmpdir(), `gss-play-test-sa-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
    fs.writeFileSync(p, JSON.stringify({ client_email: 'play-publisher@best-sudoku-prod.iam.gserviceaccount.com', private_key: privateKey }))
    return p
  }
  // Node's Buffer.concat() for small results can allocate from a shared internal pool, so
  // calling this more than once per CSV and slicing across the separate results (each call's
  // .buffer/.byteOffset/.byteLength taken from a DIFFERENT pool allocation) corrupts the slice.
  // Call once per CSV, keep the Buffer, and convert to an ArrayBuffer via Buffer.from's own
  // (self-consistent) .buffer/.byteOffset/.byteLength from that single call.
  const csvBuf = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  const toArrayBuffer = (buf: Buffer): ArrayBuffer => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer

  it('reads installs and store_performance, computes horizon/lag, and always carries the retention gap and household notes', async () => {
    const { privateKey } = rsa()
    const sa = tmpSa(privateKey)
    const installsCsv = 'Date,Package name,Daily Device Installs,Daily Device Uninstalls,Daily Device Upgrades,Total User Installs,Daily User Installs,Daily User Uninstalls,Active Device Installs,Install events,Update events,Uninstall events\n2026-09-20,com.bestsudoku.app,1,0,0,0,1,0,10,1,0,0\n'
    const countryCsv = 'Date,Package name,Country / region,Store listing acquisitions,Store listing visitors,Store listing conversion rate\n2026-09-19,com.bestsudoku.app,Other,0,1,0.0\n'
    const sourceCsv = 'Date,Package name,Traffic source,Search term,UTM source,UTM campaign,Store listing acquisitions,Store listing visitors,Store listing conversion rate\n2026-09-19,com.bestsudoku.app,Other,Other,Other,Other,0,1,0.0\n'
    const installsBuf = csvBuf(installsCsv)
    const countryBuf = csvBuf(countryCsv)
    const sourceBuf = csvBuf(sourceCsv)
    // Regression: a live probe (2026-09-27) found listObjects/downloadObject built their
    // requests with `headers: {}`, silently dropping the bearer token — GCS then answers
    // every list/download with 401 "Anonymous caller", even though accessToken() itself
    // succeeded. The mocks above never inspected headers, so this shipped and only surfaced
    // against the real bucket. Every non-oauth request's Authorization header is captured and
    // asserted below so this class of bug fails a unit test, not a live run.
    const seenAuth: (string | undefined)[] = []
    try {
      const out = await readPlayReports(sa, {
        since: '2026-09-01',
        until: '2026-09-27',
        flightStart: '2026-09-26',
        cumulativeSpend: 13.12,
        bucket: 'pubsite_prod_test',
        fetchImpl: async (url, init) => {
          if (url.includes('oauth2')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ya29.test' }), arrayBuffer: async () => new ArrayBuffer(0) }
          seenAuth.push(init.headers.Authorization)
          if (url.includes('/o?') && url.includes('installs_com.bestsudoku.app_')) return { ok: true, status: 200, text: async () => JSON.stringify({ items: [{ name: 'stats/installs/installs_com.bestsudoku.app_202609_overview.csv', updated: '2026-09-26T16:10:00Z' }] }), arrayBuffer: async () => new ArrayBuffer(0) }
          if (url.includes('/o?') && url.includes('store_performance_com.bestsudoku.app_')) return { ok: true, status: 200, text: async () => JSON.stringify({ items: [{ name: 'stats/store_performance/store_performance_com.bestsudoku.app_202609_country.csv' }, { name: 'stats/store_performance/store_performance_com.bestsudoku.app_202609_traffic_source.csv' }] }), arrayBuffer: async () => new ArrayBuffer(0) }
          if (url.includes('_overview.csv')) return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => toArrayBuffer(installsBuf) }
          if (url.includes('_country.csv')) return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => toArrayBuffer(countryBuf) }
          if (url.includes('_traffic_source.csv')) return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => toArrayBuffer(sourceBuf) }
          throw new Error(`unexpected URL in test: ${url}`)
        },
      })
      expect(seenAuth.length).toBeGreaterThan(0)
      expect(seenAuth.every((a) => a === 'Bearer ya29.test')).toBe(true) // every list/download call, never anonymous
      expect(out.ok).toBe(true)
      expect(out.bucket).toBe('pubsite_prod_test')
      expect(out.installsByDay).toEqual([{ date: '2026-09-20', deviceInstalls: 1, userInstalls: 1, deviceUninstalls: 0, activeDeviceInstalls: 10 }])
      expect(out.acquisitionByCountry).toEqual([{ date: '2026-09-19', dimension: 'Other', visitors: 1, acquisitions: 0, conversionRate: 0 }])
      expect(out.installsThrough).toBe('2026-09-20')
      expect(out.storePerformanceThrough).toBe('2026-09-19')
      expect(out.installsLagDays).toBe(7) // 2026-09-20 -> 2026-09-27
      expect(out.storePerformanceLagDays).toBe(8)
      expect(out.retentionNote).toBe(RETENTION_NOTE)
      expect(out.householdNote).toBe(HOUSEHOLD_NOTE)
      // spend is $13.12: below both $50 and $75, so both checkpoints are "not yet crossed"
      expect(out.checkpoints.map((c) => c.status)).toEqual(['not yet crossed', 'not yet crossed'])
      expect(out.errors).toEqual([])
    } finally {
      fs.rmSync(sa, { force: true })
    }
  })

  it('a failed CSV download is recorded in errors and never throws; other files still read', async () => {
    const { privateKey } = rsa()
    const sa = tmpSa(privateKey)
    try {
      const out = await readPlayReports(sa, {
        since: '2026-09-01',
        until: '2026-09-27',
        flightStart: '2026-09-26',
        cumulativeSpend: 0,
        bucket: 'pubsite_prod_test',
        fetchImpl: async (url) => {
          if (url.includes('oauth2')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ya29.test' }), arrayBuffer: async () => new ArrayBuffer(0) }
          if (url.includes('installs_com.bestsudoku.app_') && url.includes('/o?')) return { ok: true, status: 200, text: async () => JSON.stringify({ items: [{ name: 'stats/installs/installs_com.bestsudoku.app_202609_overview.csv' }] }), arrayBuffer: async () => new ArrayBuffer(0) }
          if (url.includes('store_performance_com.bestsudoku.app_') && url.includes('/o?')) return { ok: true, status: 200, text: async () => JSON.stringify({ items: [] }), arrayBuffer: async () => new ArrayBuffer(0) }
          if (url.includes('_overview.csv')) return { ok: false, status: 500, text: async () => 'boom', arrayBuffer: async () => new ArrayBuffer(0) }
          throw new Error(`unexpected URL: ${url}`)
        },
      })
      expect(out.ok).toBe(true) // the list+auth succeeded; one file failing is a per-file error
      expect(out.errors.join(' ')).toMatch(/installs overview.*HTTP 500/)
      expect(out.installsByDay).toEqual([])
    } finally {
      fs.rmSync(sa, { force: true })
    }
  })

  it('a missing/unreadable SA file fails closed with a readable error, no throw', async () => {
    const out = await readPlayReports('/no/such/file.json', { since: '2026-09-01', until: '2026-09-27', flightStart: '2026-09-26', cumulativeSpend: 0 })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/unreadable/)
    expect(out.bucket).toBe(DEFAULT_BUCKET) // confirms the settled-by-execution default is wired in
  })
})
