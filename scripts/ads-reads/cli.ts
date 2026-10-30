// Shared CLI plumbing for morning-read / postflight-read / backfill: argument parsing, the
// live dependency graph (Ads API via bws, beacon D1 read-only, gss-stats-ads store) and the
// --fixture graph (everything from one recorded JSON file, in-memory store, no network).
//
// Credentials: Google Ads keys come from Bitwarden, or from env vars (ADS_SA_B64 or the ADS_* set) when
// BWS_ACCESS_TOKEN is unset (secrets.ts). The Cloudflare token comes from --cf-token-file (read
// into memory) or an already-set CLOUDFLARE_API_TOKEN, else wrangler's own login; wrangler
// inherits CLOUDFLARE_ACCOUNT_ID from the environment. Firestore uses --firebase-sa <path>, else
// FIRESTORE_SA_B64 (firebase.ts). None of them is ever printed.

import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { ADS_CUSTOMER_ID, ADS_READ_PLANS, defaultReadCampaignId, etDateOf, postflightDueDate, type PostflightStage, type FirstSessionRowSite, type ReadingRecord, type ReturnRow, type ReturnSiteStat, type SpendDay, type StoredSpend, type TaggedRow } from '../../src/lib/adsRules'
import { campaignById, etMidnightUtcMs, etTimeUtcMs } from '../../src/lib/campaigns'
import { addEtDays } from '../../src/lib/overview'
import type { SearchSideRaw } from '../../src/lib/searchAdsSide'
import type { PlacementDayRow } from '../../src/lib/adsStore'
import type { AdsExtrasSource } from '../../src/lib/adsSync'
import { etDateFromMs, type HourPathCount } from '../../src/lib/popupEvents'
import {
  createAdsClient,
  fetchCampaignStatus,
  fetchAdDaily,
  fetchDailyAssets,
  fetchDailyConversions,
  fetchDailySpend,
  fetchDevices,
  fetchGeo,
  fetchHourly,
  fetchPlacementDaily,
  fetchRangeTotal,
  fetchRecommendations,
  fetchSearchDaily,
  fetchSearchKeywords,
  fetchSearchRange,
  fetchTargeting,
  type AdDayRow,
  type AdsClient,
  type CampaignStatus,
} from '../../src/lib/adsApi'
import { createBeaconSource, type BeaconSource } from './beacon'
import { createD1Select } from './d1'
import { createD1Store, createMemoryStore } from './d1Store'
import { readFirebaseCounts, serviceAccountFromEnv, type FirebaseCounts, type ServiceAccountSource } from './firebase'
import { readPlayReports } from './play'
import type { AdsSource, AsOfMark, ReadDeps } from './read'
import { redact, registerSecret } from '../../src/lib/adsRedact'
import { loadAdsAuth } from './secrets'
import { createWranglerRunner, EXTERNAL_TIMEOUT_MS, type WranglerRunner } from './wrangler'

export const COMMON_OPTIONS = {
  'dry-run': { type: 'boolean', default: false },
  campaign: { type: 'string' },
  'cf-token-file': { type: 'string' },
  'firebase-sa': { type: 'string' },
  'play-sa': { type: 'string' },
  fixture: { type: 'string' },
  now: { type: 'string' },
  'json-only': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} as const

export function parseCli<T extends Record<string, { type: 'string' | 'boolean'; default?: string | boolean }>>(extra: T, argv = process.argv.slice(2)) {
  try {
    const parsed = parseArgs({ args: argv, options: { ...COMMON_OPTIONS, ...extra }, allowPositionals: false, strict: true, tokens: true })
    // parseArgs keeps the LAST of a repeated string option; a leftover second --campaign would
    // silently read the wrong arm, so a repeat is refused (naming every value given).
    const campaigns = parsed.tokens.flatMap((t) => (t.kind === 'option' && t.name === 'campaign' ? [t.value ?? ''] : []))
    if (campaigns.length > 1) throw new Error(`--campaign was given ${campaigns.length} times (${campaigns.map((c) => JSON.stringify(c)).join(' and ')}); pass it once`)
    return parsed.values as Record<string, string | boolean | undefined>
  } catch (e) {
    // A bare `--campaign` (no value) fails in parseArgs before resolveCampaignId runs: give it the
    // same message as a blank or unknown id, listing the registered ids.
    if (e instanceof Error && /Option '--campaign\b.*argument (missing|is ambiguous)/.test(e.message)) throw new Error(campaignRefusal(null))
    throw e
  }
}

/** The one message for a `--campaign` value that is not usable (blank, missing, unknown). */
export function campaignRefusal(given: string | boolean | null): string {
  const ids = Object.keys(ADS_READ_PLANS).join(', ') || 'none registered'
  return `--campaign ${given === null ? 'with no value' : JSON.stringify(given)} is not a registered campaign id (registered read plans: ${ids}); pass --campaign <id>`
}

/** The campaign a read runs on: an explicit `--campaign <id>`, else the registry's default for
 * this kind of read on the read's own clock (src/lib/adsRules.ts defaultReadCampaignId; throws
 * a one-line error listing the registered ids when it cannot pick exactly one). `nowMs` is the
 * fixture's clock under --fixture, else the real one.
 * A flag that is given must be a known campaign: an empty value (an unset shell variable), a
 * boolean or an unknown id fails loudly, listing the registered ids; it never falls through to
 * the default. (A closed campaign is known: its own refusal, "is closed", comes later.) */
export function resolveCampaignId(opts: Record<string, string | boolean | undefined>, kind: 'morning' | 'postflight', nowMs: number, stage?: PostflightStage): string {
  const given = opts.campaign
  if (given === undefined) return defaultReadCampaignId(kind, etDateOf(nowMs), stage)
  if (typeof given === 'string' && given && (ADS_READ_PLANS[given] || campaignById(given))) return given
  throw new Error(campaignRefusal(given))
}

// ── --as-of: a post-flight stage read on a past ET day's clock ─────────────────────────────
/** The last millisecond of ET calendar day `dateEt` (DST-safe). */
export const endOfEtDayMs = (dateEt: string): number => etMidnightUtcMs(addEtDays(dateEt, 1)) - 1

const isEtDate = (d: string): boolean => {
  try {
    return addEtDays(d, 0) === d
  } catch {
    return false // an impossible date such as 2026-13-01
  }
}

/** A post-flight run's campaign and clock: the instant every time-dependent part keys off, and
 * (only with --as-of) the mark that tells the reading apart from a same-day read. */
export interface PostflightClock {
  campaignId: string
  nowMs: number
  asOf: AsOfMark | null
}

/** Resolves a post-flight run's campaign and clock. Without `--as-of` the clock is `clockMs`
 * (the real time, or a fixture's). With `--as-of <YYYY-MM-DD ET>` it is the end of that ET day
 * (or `clockMs` itself when the date is today), so a stage read that never ran on its day can be
 * taken afterwards with the data of that day: the beacon windows, the matured-arrival cutoff, the
 * Ads date range and the stored et_date all follow. Refused: a malformed date, a date after
 * `clockMs`'s ET day, a date before the stage's due date, and `--now` beside it. */
export function resolvePostflightClock(opts: Record<string, string | boolean | undefined>, stage: PostflightStage, clockMs: number): PostflightClock {
  const given = opts['as-of']
  if (given === undefined) return { campaignId: resolveCampaignId(opts, 'postflight', clockMs, stage), nowMs: clockMs, asOf: null }
  if (opts.now) throw new Error('--as-of and --now cannot be combined')
  if (typeof given !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(given) || !isEtDate(given)) throw new Error(`--as-of must be an ET date as YYYY-MM-DD, got ${JSON.stringify(given)}`)
  const today = etDateOf(clockMs)
  if (given > today) throw new Error(`--as-of ${given} is in the future (today is ${today} ET)`)
  const campaignId = resolveCampaignId(opts, 'postflight', endOfEtDayMs(given), stage)
  const campaign = campaignById(campaignId)
  if (!campaign) throw new Error(`--as-of needs a registered campaign with a flight end; ${campaignId} has none`)
  const dueEt = postflightDueDate(stage, campaign.flightEnd)
  if (given < dueEt) throw new Error(`--as-of ${given} is before the ${stage} stage's due date ${dueEt} (flight ended ${campaign.flightEnd})`)
  return { campaignId, nowMs: Math.min(endOfEtDayMs(given), clockMs), asOf: { etDate: given, realNowMs: clockMs } }
}

const AS_OF_READ_TIME_ET = '08:05'
/** morning-read `--as-of <read date>`: backfills a daily reading that never ran on its day (the clock is 08:05 ET of that day, the
 * routine's usual time: yesterday is a closed day by then, and nothing from the read day itself is counted). The mark's etDate is the last day covered, so the
 * beacon reads cut at the read day's midnight; the stored et_date is the read date, read_at stays the real time. null without the flag.
 * Refused: a malformed date, today or a later day, and `--now` beside it. */
export function resolveMorningClock(opts: Record<string, string | boolean | undefined>, clockMs: number): Pick<PostflightClock, 'nowMs' | 'asOf'> | null {
  const given = opts['as-of']
  if (given === undefined) return null
  if (opts.now) throw new Error('--as-of and --now cannot be combined')
  if (typeof given !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(given) || !isEtDate(given)) throw new Error(`--as-of must be an ET date as YYYY-MM-DD, got ${JSON.stringify(given)}`)
  if (given >= etDateOf(clockMs)) throw new Error(`--as-of ${given} must be before today (${etDateOf(clockMs)} ET): a daily reading is for a day that has begun and passed`)
  return { nowMs: etTimeUtcMs(given, AS_OF_READ_TIME_ET), asOf: { etDate: addEtDays(given, -1), realNowMs: clockMs } }
}

export function loadCfToken(file: string | undefined): string | null {
  if (file) {
    const tok = fs.readFileSync(file, 'utf8').trim()
    if (!tok) throw new Error('--cf-token-file is empty')
    registerSecret(tok)
    return tok
  }
  const env = process.env.CLOUDFLARE_API_TOKEN
  if (env) registerSecret(env)
  return env ?? null
}

export interface LiveGraph {
  run: WranglerRunner
  ads: AdsClient | null
  adsInitError: string | null
}

export async function liveAdsClient(): Promise<{ ads: AdsClient | null; adsInitError: string | null }> {
  try {
    return { ads: await createAdsClient(await loadAdsAuth(), { timeoutMs: EXTERNAL_TIMEOUT_MS }), adsInitError: null }
  } catch (e) {
    return { ads: null, adsInitError: redact(e) }
  }
}

export function adsSource(client: AdsClient): AdsSource {
  return {
    status: (id) => fetchCampaignStatus(client, id),
    daily: (id, since, until) => fetchDailySpend(client, id, since, until),
    placements: (id, since, until) => fetchPlacementDaily(client, id, since, until),
    rangeTotal: (id, since, until) => fetchRangeTotal(client, id, since, until),
    // R2/R3 diagnostic depth (informational only; see src/lib/adsApi.ts).
    hourly: (id, since, until) => fetchHourly(client, id, since, until),
    geo: (id, since, until) => fetchGeo(client, id, since, until),
    devices: (id, since, until) => fetchDevices(client, id, since, until),
    targeting: (id) => fetchTargeting(client, id),
    recommendations: (id) => fetchRecommendations(client, ADS_CUSTOMER_ID, id),
    // Ad-level cost for the per-tag split of an arm with several tags (a read-only SELECT).
    adDaily: (id, since, until) => fetchAdDaily(client, id, since, until),
    // The flight 3 Search Ads-side block: three read-only SELECTs. The keyword query failing leaves only the keyword part out.
    searchSide: async (id, since, until) => {
      const [daily, cumulative] = await Promise.all([fetchSearchDaily(client, id, since, until), fetchSearchRange(client, id, since, until)])
      let keywords = null
      let keywordsError: string | null = null
      try {
        keywords = await fetchSearchKeywords(client, id, since, until)
      } catch (e) {
        keywordsError = redact(e)
      }
      return { daily, cumulative, keywords, keywordsError }
    },
  }
}

/** The conversions-and-assets pass's source (src/lib/adsSync.ts syncAdsExtras): two read-only SELECTs. */
export function adsExtrasSource(client: AdsClient): AdsExtrasSource {
  return {
    conversions: (id, since, until) => fetchDailyConversions(client, id, since, until),
    assets: (id, since, until) => fetchDailyAssets(client, id, since, until),
  }
}

/** Live dependencies. `--now` is refused here: a live read runs on the real clock or, for a
 * post-flight stage read given `--as-of`, on the clock resolvePostflightClock made of it. */
export async function liveDeps(opts: Record<string, string | boolean | undefined>, clock?: Pick<PostflightClock, 'nowMs' | 'asOf'>): Promise<ReadDeps> {
  if (opts.now) throw new Error('--now is only allowed with --fixture')
  const dryRun = !!opts['dry-run']
  const run = createWranglerRunner({ cfToken: loadCfToken(opts['cf-token-file'] as string | undefined) })
  const { ads, adsInitError } = await liveAdsClient()
  // An explicit --firebase-sa wins; otherwise FIRESTORE_SA_B64 (decoded in memory) if set.
  const saPath = opts['firebase-sa'] as string | undefined
  const envSa = serviceAccountFromEnv() // always registers FIRESTORE_SA_B64 for redaction, even when --firebase-sa wins
  const saSource: ServiceAccountSource | null = saPath ?? envSa
  const playSaPath = opts['play-sa'] as string | undefined
  return {
    nowMs: clock?.nowMs ?? Date.now(),
    ...(clock?.asOf ? { asOf: clock.asOf } : {}),
    ads: ads ? adsSource(ads) : null,
    adsInitError,
    beacon: createBeaconSource(createD1Select(run)),
    store: createD1Store({ run, dryRun }),
    // --firebase-sa is a plain path so the key can be swapped for a read-only one later.
    firebase: saSource ? { counts: (s, e, at) => readFirebaseCounts(saSource, s, e, { cohortTiersAtMs: at ?? null }) } : null,
    // --play-sa: Play Console bulk-reports (R4), read-only, informational (see play.ts header
    // for the bucket/credential facts settled by execution). Same existing SA credential works
    // (~/.google-play/service-accounts/best-sudoku-prod.json) — no new secret plumbing.
    playReports: playSaPath ? { read: (o) => readPlayReports(playSaPath, o) } : null,
    dryRun,
  }
}

// ── --fixture: one recorded JSON file drives the whole read ───────────────────────────────
export interface Fixture {
  now: string
  ads?: { status: CampaignStatus; daily: Record<string, SpendDay>; placements: PlacementDayRow[]; adDaily?: AdDayRow[]; searchSide?: SearchSideRaw } | { error: string }
  beacon?: {
    tagged: (Omit<TaggedRow, 'hourStartMs'> & { hour?: string; hourStartMs?: number })[]
    siteEvents: (Omit<HourPathCount, 'hourStartMs'> & { hour?: string; hourStartMs?: number })[]
    returns: ReturnRow[]
    /** first/last (ISO) or firstMs/lastMs are reduced to ET dates on load: the read only ever
     * sees a /return/ row's ET date (adsRules.ts ReturnSiteStat). */
    returnSites: (Omit<ReturnSiteStat, 'firstEtDate' | 'lastEtDate'> & { first?: string | null; last?: string | null; firstMs?: number | null; lastMs?: number | null })[]
    /** Site-wide first-session rows (beacon.ts siteFirstSessionQuery); absent = not read. */
    siteFirstSession?: FirstSessionRowSite[]
  } | { error: string }
  store?: { spend?: StoredSpend | null; readings?: ReadingRecord[]; consumed?: number[] }
  firebase?: FirebaseCounts | null
}

const hourMs = (x: { hour?: string; hourStartMs?: number }) => (x.hourStartMs != null ? x.hourStartMs : Date.parse(x.hour!))
const optMs = (iso: string | null | undefined, ms: number | null | undefined) => (ms != null ? ms : iso ? Date.parse(iso) : null)
const optEtDate = (iso: string | null | undefined, ms: number | null | undefined) => {
  const t = optMs(iso, ms)
  return t == null ? null : etDateFromMs(t)
}

export function fixtureDeps(fx: Fixture, dryRun: boolean): ReadDeps & { store: ReturnType<typeof createMemoryStore> } {
  const ads = fx.ads && !('error' in fx.ads) ? fx.ads : null
  const beacon = fx.beacon && !('error' in fx.beacon) ? fx.beacon : null
  const inRange = (d: string, since: string, until: string) => d >= since && d <= until
  const b: BeaconSource | null = beacon
    ? {
        tagged: async (_c, _u, _m, untilMs) => beacon.tagged.filter((r) => untilMs == null || hourMs(r) < untilMs).map((r) => ({ hourStartMs: hourMs(r), path: r.path, visitor: r.visitor, count: r.count, ...(r.campaign === undefined ? {} : { campaign: r.campaign }), ...(r.postUpsellFix === undefined ? {} : { postUpsellFix: r.postUpsellFix }) })),
        siteEvents: async (sinceMs, untilMs) => beacon.siteEvents.map((r) => ({ hourStartMs: hourMs(r), path: r.path, count: r.count })).filter((r) => r.hourStartMs >= sinceMs && (untilMs == null || r.hourStartMs < untilMs)),
        returns: async () => beacon.returns,
        returnSites: async () => beacon.returnSites.map((s) => ({ site: s.site, count: s.count, firstEtDate: optEtDate(s.first, s.firstMs), lastEtDate: optEtDate(s.last, s.lastMs) })),
        ...(beacon.siteFirstSession ? { siteFirstSession: async () => beacon.siteFirstSession! } : {}),
        // Tagged d0 arrivals: the fixture's own /return/<uc>/d0 rows (path-attributed, like the real query).
        returnArrivals: async (c) => beacon.returns.filter((r) => c.ucValues.some((u) => r.path === `/return/${u}/d0`)).map((r) => ({ path: r.path, count: r.count })),
      }
    : null
  return {
    nowMs: Date.parse(fx.now),
    ads: ads
      ? {
          status: async () => ads.status,
          daily: async (_id, since, until) => Object.fromEntries(Object.entries(ads.daily).filter(([d]) => inRange(d, since, until))),
          placements: async (_id, since, until) => ads.placements.filter((p) => inRange(p.date, since, until)),
          ...(ads.searchSide ? { searchSide: async () => ads.searchSide! } : {}),
          ...(ads.adDaily ? { adDaily: async (_id: string, since: string, until: string) => ads.adDaily!.filter((a) => inRange(a.date, since, until)) } : {}),
          rangeTotal: async (_id, since, until) => {
            const days = Object.entries(ads.daily).filter(([d]) => inRange(d, since, until)).map(([, v]) => v)
            return days.length ? days.reduce((a, v) => ({ costMicros: a.costMicros + v.costMicros, impressions: a.impressions + v.impressions, clicks: a.clicks + v.clicks }), { costMicros: 0, impressions: 0, clicks: 0 }) : null
          },
        }
      : null,
    adsInitError: fx.ads && 'error' in fx.ads ? fx.ads.error : ads ? null : 'no ads data in fixture',
    beacon: b,
    beaconInitError: fx.beacon && 'error' in fx.beacon ? fx.beacon.error : b ? null : 'no beacon data in fixture',
    store: createMemoryStore(fx.store ?? {}, dryRun),
    // A fixture's cohortTiers is only handed back when the caller asked for it, like the live read.
    firebase: fx.firebase
      ? {
          counts: async (_s, _e, at) => {
            const { cohortTiers, ...rest } = fx.firebase!
            return at != null ? { ...rest, ...(cohortTiers !== undefined ? { cohortTiers } : {}) } : rest
          },
        }
      : null,
    dryRun,
  }
}

export function loadFixture(path: string): Fixture {
  return JSON.parse(fs.readFileSync(path, 'utf8')) as Fixture
}

/** Last-resort handler: redacted message, non-zero exit. */
export function fail(e: unknown): never {
  process.stderr.write(`error: ${redact(e)}\n`)
  process.exit(1)
}
