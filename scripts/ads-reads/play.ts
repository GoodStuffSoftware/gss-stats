// OPTIONAL, READ-ONLY Play Console "bulk reports" reader (R4 of the retest routine parity
// work). Google Play has no REST API for install/acquisition statistics — the one
// programmatic path is Play Console's "bulk reports": monthly CSVs, refreshed daily, that
// Google drops into a private Cloud Storage bucket owned by the developer account. This reads
// those files directly via the GCS JSON API. No scraping, no browser, no mutation of anything
// (every request below is a GET).
//
// Ported from `best-sudoku-ads-week2/scripts/marketing/play-reports.mjs` (2026-09-18), adapted
// to this codebase's existing no-new-dependency pattern (see firebase.ts: manual RS256 JWT
// signing via node:crypto, a fenced fetch allowlisting exact URLs, no `google-auth-library`).
//
// BUCKET — settled by execution 2026-09-27, not by memory or by the old script's own comment.
// The old script's docstring guessed `pubsite_prod_rev_<digits>` (never confirmed working; its
// own error text still said so). A live GCS list call with the same credential this file uses
// gives: `pubsite_prod_6577064245925542510` -> HTTP 200 with real file listings;
// `pubsite_prod_rev_6577064245925542510` -> HTTP 404 "bucket does not exist". The working name
// matches the developer account id (6577064245925542510, visible in the Play Console URL), not
// the numeric app id. DEFAULT_BUCKET below is that confirmed name; PLAY_BULK_REPORTS_BUCKET
// overrides it without a code change if Google ever renames it.
//
// CREDENTIAL — the existing `play-publisher@best-sudoku-prod.iam.gserviceaccount.com` key
// (default path ~/.google-play/service-accounts/best-sudoku-prod.json) already has the
// account-level "View app information and download bulk reports" permission: the live probe
// returned 200, not 403. No new secret plumbing was needed for R4.
//
// RETENTION — day-1/day-7 retention is NOT available from bulk reports: a live listing of
// every object under `stats/` in the bucket returns exactly two file families, `installs/` and
// `store_performance/`; there is no retention-shaped file at all (confirmed 2026-09-27). This
// reader reports that as an explicit gap line rather than fabricating a number or silently
// omitting the requirement.
//
// LAG — Google's docs say "captured daily and posted within 3 to 7 days"; this reader computes
// the actual lag from each file's own last-dated row rather than assuming a fixed number, and
// every section states which date it covers.
//
// HOUSEHOLD — Play device/install counts are not attributable to any one flight by construction
// (no install-referrer capture on this app; see best-sudoku's play-install-referrer-capture
// backlog item) and include the developer's own household devices. Every section below carries
// that caveat; report.ts repeats it next to the numbers, never behind a single shared footnote.
//
// COLUMN NAMES — verified against real bulk-report CSVs 2026-09-27 (not assumed from Google's
// prose docs, which do not publish the literal header text for store_performance). One real
// difference from the old script's alias list: the country dimension column is literally
// "Country / region", not "Country" — findCol() below includes both.

import fs from 'node:fs'
import { createSign } from 'node:crypto'
import { redact, registerSecret } from '../../src/lib/adsRedact'
import { EXTERNAL_TIMEOUT_MS } from './wrangler'

export const PACKAGE_NAME = 'com.bestsudoku.app'
export const DEFAULT_BUCKET = 'pubsite_prod_6577064245925542510'
const STORAGE_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_only'
const STORAGE_API = 'https://storage.googleapis.com/storage/v1/b'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

/** A binary-capable fetch with the same external timeout as the rest of this CLI (review L8);
 * a plain FetchLike (src/lib/adsApi.ts) only exposes .text(), and a bulk-report CSV is
 * UTF-16-with-BOM, so this needs raw bytes. Self-contained here rather than widening the
 * shared FetchLike type, since nothing else needs arrayBuffer(). */
export type BinaryFetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>
export function createTimedBinaryFetch(timeoutMs: number = EXTERNAL_TIMEOUT_MS): BinaryFetchLike {
  return async (url, init) => {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error(`${new URL(url).host} timed out after ${Math.round(timeoutMs / 1000)}s`)
      throw e
    }
  }
}

/** The only requests this module may make: the token exchange, and GET (list or download)
 * against exactly this bucket's storage API. Anything else throws before it is sent. */
export function fencedPlayFetch(f: BinaryFetchLike, bucket: string): BinaryFetchLike {
  const base = `${STORAGE_API}/${encodeURIComponent(bucket)}`
  return (url, init) => {
    const ok = (init.method === 'POST' && url === TOKEN_URL) || (init.method === 'GET' && url.startsWith(`${base}/o`))
    if (!ok) throw new Error(`play.ts refused a ${init.method} to a non-allowlisted URL`)
    return f(url, init)
  }
}

async function accessToken(sa: { client_email: string; private_key: string }, fetchImpl: BinaryFetchLike): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify({ iss: sa.client_email, scope: STORAGE_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }),
  )}`
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key)
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }).toString(),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`Play SA token exchange failed, HTTP ${res.status}`)
  const tok = JSON.parse(body).access_token
  if (!tok) throw new Error('Play SA token exchange returned no access_token')
  registerSecret(tok)
  return tok
}

// ── Pure CSV helpers — exported for unit testing without network or a credential ───────────

export function decodeCsvBuffer(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  return buf.toString('utf8')
}

export function parseCsvText(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else inQuotes = false
      } else field += c
      continue
    }
    if (c === '"') inQuotes = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\r') {
      // swallow; \n closes the row
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

export function rowsToRecords(rows: string[][]): { header: string[]; records: Record<string, string>[] } {
  if (!rows.length) return { header: [], records: [] }
  const header = rows[0]
  const records = rows
    .slice(1)
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => {
      const o: Record<string, string> = {}
      header.forEach((h, i) => {
        o[h] = r[i] !== undefined ? r[i] : ''
      })
      return o
    })
  return { header, records }
}

function findCol(header: string[], aliases: string[]): string | null {
  const norm = (s: string) => String(s).trim().toLowerCase().replace(/\s+/g, ' ')
  const normHeader = header.map(norm)
  for (const alias of aliases) {
    const idx = normHeader.indexOf(norm(alias))
    if (idx !== -1) return header[idx]
  }
  return null
}

const toNum = (v: unknown): number | null => {
  const n = Number(String(v ?? '').replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : null
}

export function normalizeDate(v: unknown): string {
  const s = String(v ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  const md = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (md) return `${md[3]}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`
  return s
}

export interface PlayInstallDay {
  date: string
  deviceInstalls: number | null
  userInstalls: number | null
  deviceUninstalls: number | null
  activeDeviceInstalls: number | null
}
/** installs_<pkg>_<yyyyMM>_overview.csv -> per-day totals, all countries. */
export function shapeInstallsOverview({ header, records }: { header: string[]; records: Record<string, string>[] }): PlayInstallDay[] {
  const dateCol = findCol(header, ['Date'])
  const ddiCol = findCol(header, ['Daily Device Installs'])
  const duiCol = findCol(header, ['Daily User Installs'])
  const dduCol = findCol(header, ['Daily Device Uninstalls'])
  const adiCol = findCol(header, ['Active Device Installs'])
  if (!dateCol) return []
  return records.map((r) => ({
    date: normalizeDate(r[dateCol]),
    deviceInstalls: ddiCol ? toNum(r[ddiCol]) : null,
    userInstalls: duiCol ? toNum(r[duiCol]) : null,
    deviceUninstalls: dduCol ? toNum(r[dduCol]) : null,
    activeDeviceInstalls: adiCol ? toNum(r[adiCol]) : null,
  }))
}

export interface PlayAcquisitionRow {
  date: string
  dimension: string | null
  visitors: number | null
  acquisitions: number | null
  conversionRate: number | null
}
/** store_performance_<pkg>_<yyyyMM>_{country,traffic_source}.csv -> per-day (+ dimension)
 * visitors/acquisitions/conversion. `dimensionAliases` picks the "Country / region" column for
 * the country file, or "Traffic source" for the traffic-source file. */
export function shapeStorePerformance({ header, records }: { header: string[]; records: Record<string, string>[] }, dimensionAliases: string[]): PlayAcquisitionRow[] {
  const dateCol = findCol(header, ['Date'])
  const dimCol = findCol(header, dimensionAliases)
  const visitorsCol = findCol(header, ['Store listing visitors', 'Store Listing Visitors', 'Visitors'])
  const acqCol = findCol(header, ['Store listing acquisitions', 'Store Listing Acquisitions', 'Installers', 'Acquisitions'])
  const cvrCol = findCol(header, ['Store listing conversion rate', 'Store Listing Conversion Rate', 'Conversion Rate'])
  if (!dateCol) return []
  return records.map((r) => {
    const visitors = visitorsCol ? toNum(r[visitorsCol]) : null
    const acquisitions = acqCol ? toNum(r[acqCol]) : null
    return {
      date: normalizeDate(r[dateCol]),
      dimension: dimCol ? String(r[dimCol]) : null,
      visitors,
      acquisitions,
      conversionRate: cvrCol ? toNum(r[cvrCol]) : visitors && acquisitions !== null ? acquisitions / visitors : null,
    }
  })
}

export function filterDateRange<T extends { date: string }>(rows: T[], since: string, until: string): T[] {
  return rows.filter((r) => r.date && r.date >= since && r.date <= until)
}

/** 'YYYY-MM-DD' + 'YYYY-MM-DD' -> ['yyyyMM', ...] inclusive of both ends. */
export function monthsBetween(since: string, until: string): string[] {
  const [sy, sm] = since.split('-').map(Number)
  const [uy, um] = until.split('-').map(Number)
  const months: string[] = []
  let y = sy
  let m = sm
  for (let i = 0; i < 1200 && (y < uy || (y === uy && m <= um)); i += 1) {
    months.push(`${y}${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return months
}

// ── Network — GCS JSON API. Every call here is a GET; nothing mutates the bucket ───────────

interface GcsObject {
  name: string
  updated?: string
}
async function listObjects(f: BinaryFetchLike, bucket: string, token: string, prefix: string): Promise<GcsObject[]> {
  let pageToken: string | undefined
  const items: GcsObject[] = []
  for (let page = 0; page < 50; page += 1) {
    const qs = new URLSearchParams({ prefix })
    if (pageToken) qs.set('pageToken', pageToken)
    const res = await f(`${STORAGE_API}/${encodeURIComponent(bucket)}/o?${qs}`, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })
    const text = await res.text()
    if (!res.ok) throw new Error(`GCS list HTTP ${res.status}: ${text.slice(0, 200)}`)
    const json = JSON.parse(text)
    items.push(...(json.items || []))
    pageToken = json.nextPageToken
    if (!pageToken) break
  }
  return items
}
async function downloadObject(f: BinaryFetchLike, bucket: string, token: string, name: string): Promise<Buffer> {
  const res = await f(`${STORAGE_API}/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}?alt=media`, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`GCS download HTTP ${res.status} for ${name.split('/').pop()}`)
  return Buffer.from(await res.arrayBuffer())
}

// ── Result shape and top-level read ─────────────────────────────────────────────────────────

export const RETENTION_NOTE = 'day-1/day-7 retention is NOT available from Play bulk reports: the bucket has exactly two report families (installs/, store_performance/), no retention-shaped file exists (checked by listing the bucket, not assumed from docs)'
export const HOUSEHOLD_NOTE = 'Play device/install counts include the developer\'s own household devices and are not attributable to any one campaign (no install-referrer capture on this app)'

export interface PlayCheckpoint {
  threshold: number
  crossed: boolean
  status: 'not yet crossed' | 'undecidable' | 'read'
  detail: string
}
export interface PlayReportsSection {
  ok: boolean
  error: string | null
  bucket: string
  installsThrough: string | null
  storePerformanceThrough: string | null
  installsLagDays: number | null
  storePerformanceLagDays: number | null
  installsByDay: PlayInstallDay[] | null
  acquisitionByCountry: PlayAcquisitionRow[] | null
  acquisitionBySource: PlayAcquisitionRow[] | null
  retentionNote: string
  householdNote: string
  checkpoints: PlayCheckpoint[]
  errors: string[]
}

export function checkpoint(threshold: number, cumulativeSpend: number, flightStart: string, installsThrough: string | null): PlayCheckpoint {
  if (cumulativeSpend < threshold) return { threshold, crossed: false, status: 'not yet crossed', detail: `cumulative spend $${cumulativeSpend.toFixed(2)} has not reached $${threshold} yet` }
  if (!installsThrough || installsThrough < flightStart) {
    return {
      threshold,
      crossed: true,
      status: 'undecidable',
      detail: `spend crossed $${threshold}, but Play's installs-by-day horizon (${installsThrough ?? 'no data yet'}) has not reached the flight start (${flightStart}) — undecidable, same as the old routines' precedent for this exact lag`,
    }
  }
  return { threshold, crossed: true, status: 'read', detail: `spend crossed $${threshold}; Play's installs-by-day horizon (${installsThrough}) now covers the flight start (${flightStart}) — see installsByDay for the daily figures (informational, never proof of attribution: see acquisitionBySource for Play's own source attribution, and note the household caveat)` }
}

/** Reads this month's and (if the window spans a boundary) last month's installs and
 * store_performance CSVs, shapes them, and computes the $50/$75 checkpoint lines. Every
 * failure is recorded in `errors`, never thrown — matches diagnosticsRead()'s best-effort
 * posture in read.ts. */
export async function readPlayReports(
  saPath: string,
  opts: {
    since: string
    until: string
    flightStart: string
    cumulativeSpend: number
    bucket?: string
    fetchImpl?: BinaryFetchLike
  },
): Promise<PlayReportsSection> {
  const bucket = opts.bucket || process.env.PLAY_BULK_REPORTS_BUCKET || DEFAULT_BUCKET
  const out: PlayReportsSection = {
    ok: false,
    error: null,
    bucket,
    installsThrough: null,
    storePerformanceThrough: null,
    installsLagDays: null,
    storePerformanceLagDays: null,
    installsByDay: null,
    acquisitionByCountry: null,
    acquisitionBySource: null,
    retentionNote: RETENTION_NOTE,
    householdNote: HOUSEHOLD_NOTE,
    checkpoints: [],
    errors: [],
  }
  let sa: { client_email: string; private_key: string }
  try {
    sa = JSON.parse(fs.readFileSync(saPath, 'utf8'))
  } catch {
    out.error = 'service-account file unreadable'
    return out
  }
  if (!sa?.private_key || !sa?.client_email) {
    out.error = 'service-account file is missing client_email/private_key'
    return out
  }
  registerSecret(sa.private_key)
  const raw = opts.fetchImpl ?? createTimedBinaryFetch()
  const f = fencedPlayFetch(raw, bucket)
  let token: string
  try {
    token = await accessToken(sa, f)
  } catch (e) {
    out.error = redact(e)
    return out
  } finally {
    sa = null as any
  }

  let installsFiles: GcsObject[] = []
  let storeFiles: GcsObject[] = []
  try {
    installsFiles = await listObjects(f, bucket, token, `stats/installs/installs_${PACKAGE_NAME}_`)
    storeFiles = await listObjects(f, bucket, token, `stats/store_performance/store_performance_${PACKAGE_NAME}_`)
  } catch (e) {
    out.error = redact(e)
    return out
  }

  const months = new Set(monthsBetween(opts.since, opts.until))
  const monthOf = (name: string) => name.match(/_(\d{6})_/)?.[1] ?? null

  const overviewRows: PlayInstallDay[] = []
  for (const file of installsFiles.filter((x) => x.name.endsWith('_overview.csv') && months.has(monthOf(x.name) ?? ''))) {
    try {
      const buf = await downloadObject(f, bucket, token, file.name)
      overviewRows.push(...shapeInstallsOverview(rowsToRecords(parseCsvText(decodeCsvBuffer(buf)))))
    } catch (e) {
      out.errors.push(`installs overview (${file.name.split('/').pop()}): ${redact(e)}`)
    }
  }
  const countryRows: PlayAcquisitionRow[] = []
  const sourceRows: PlayAcquisitionRow[] = []
  for (const file of storeFiles.filter((x) => months.has(monthOf(x.name) ?? ''))) {
    try {
      const buf = await downloadObject(f, bucket, token, file.name)
      const shaped = rowsToRecords(parseCsvText(decodeCsvBuffer(buf)))
      if (file.name.endsWith('_country.csv')) countryRows.push(...shapeStorePerformance(shaped, ['Country / region', 'Country']))
      else if (file.name.endsWith('_traffic_source.csv')) sourceRows.push(...shapeStorePerformance(shaped, ['Traffic source', 'Traffic Source']))
    } catch (e) {
      out.errors.push(`store_performance (${file.name.split('/').pop()}): ${redact(e)}`)
    }
  }

  out.installsByDay = filterDateRange(overviewRows, opts.since, opts.until).sort((a, b) => a.date.localeCompare(b.date))
  out.acquisitionByCountry = filterDateRange(countryRows, opts.since, opts.until).sort((a, b) => a.date.localeCompare(b.date))
  out.acquisitionBySource = filterDateRange(sourceRows, opts.since, opts.until).sort((a, b) => a.date.localeCompare(b.date))

  // Horizon and lag are computed from ALL rows read for the requested months, not just the
  // since/until-filtered slice, so a narrow window still reports the true reporting horizon.
  const allInstallDates = overviewRows.map((r) => r.date).filter(Boolean).sort()
  const allStoreDates = [...countryRows, ...sourceRows].map((r) => r.date).filter(Boolean).sort()
  out.installsThrough = allInstallDates.length ? allInstallDates[allInstallDates.length - 1] : null
  out.storePerformanceThrough = allStoreDates.length ? allStoreDates[allStoreDates.length - 1] : null
  const todayEt = opts.until
  const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)
  out.installsLagDays = out.installsThrough ? daysBetween(out.installsThrough, todayEt) : null
  out.storePerformanceLagDays = out.storePerformanceThrough ? daysBetween(out.storePerformanceThrough, todayEt) : null

  out.checkpoints = [50, 75].map((t) => checkpoint(t, opts.cumulativeSpend, opts.flightStart, out.installsThrough))
  out.ok = true
  return out
}
