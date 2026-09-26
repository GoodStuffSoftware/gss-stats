// Shared CLI plumbing for morning-read / postflight-read / backfill: argument parsing, the
// live dependency graph (Ads API via bws, beacon D1 read-only, gss-stats-ads store) and the
// --fixture graph (everything from one recorded JSON file, in-memory store, no network).
//
// Credentials: Google Ads keys come from Bitwarden (secrets.ts). The Cloudflare token comes
// from --cf-token-file (read into memory) or an already-set CLOUDFLARE_API_TOKEN, else
// wrangler's own login. None of them is ever printed.

import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { RETEST_CAMPAIGN_ID, type ReadingRecord, type ReturnRow, type ReturnSiteStat, type SpendDay, type StoredSpend, type TaggedRow } from '../../src/lib/adsRules'
import type { PlacementDayRow } from '../../src/lib/adsStore'
import type { HourPathCount } from '../../src/lib/popupEvents'
import { createAdsClient, fetchCampaignStatus, fetchDailySpend, fetchPlacementDaily, type AdsClient, type CampaignStatus } from './adsApi'
import { createBeaconSource, type BeaconSource } from './beacon'
import { createD1Select } from './d1'
import { createD1Store, createMemoryStore } from './d1Store'
import { readFirebaseCounts, type FirebaseCounts } from './firebase'
import type { AdsSource, ReadDeps } from './read'
import { redact, registerSecret } from './redact'
import { loadAdsCredentials } from './secrets'
import { createWranglerRunner, type WranglerRunner } from './wrangler'

export const COMMON_OPTIONS = {
  'dry-run': { type: 'boolean', default: false },
  campaign: { type: 'string', default: RETEST_CAMPAIGN_ID },
  'cf-token-file': { type: 'string' },
  'firebase-sa': { type: 'string' },
  fixture: { type: 'string' },
  now: { type: 'string' },
  'json-only': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} as const

export function parseCli<T extends Record<string, { type: 'string' | 'boolean'; default?: string | boolean }>>(extra: T, argv = process.argv.slice(2)) {
  return parseArgs({ args: argv, options: { ...COMMON_OPTIONS, ...extra }, allowPositionals: false, strict: true }).values as Record<string, string | boolean | undefined>
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
    return { ads: await createAdsClient(await loadAdsCredentials()), adsInitError: null }
  } catch (e) {
    return { ads: null, adsInitError: redact(e) }
  }
}

export function adsSource(client: AdsClient): AdsSource {
  return {
    status: (id) => fetchCampaignStatus(client, id),
    daily: (id, since, until) => fetchDailySpend(client, id, since, until),
    placements: (id, since, until) => fetchPlacementDaily(client, id, since, until),
  }
}

/** Live dependencies. `--now` is refused here: a live read always runs on the real clock. */
export async function liveDeps(opts: Record<string, string | boolean | undefined>): Promise<ReadDeps> {
  if (opts.now) throw new Error('--now is only allowed with --fixture')
  const dryRun = !!opts['dry-run']
  const run = createWranglerRunner({ cfToken: loadCfToken(opts['cf-token-file'] as string | undefined) })
  const { ads, adsInitError } = await liveAdsClient()
  const saPath = opts['firebase-sa'] as string | undefined
  return {
    nowMs: Date.now(),
    ads: ads ? adsSource(ads) : null,
    adsInitError,
    beacon: createBeaconSource(createD1Select(run)),
    store: createD1Store({ run, dryRun }),
    // --firebase-sa is a plain path so the key can be swapped for a read-only one later.
    firebase: saPath ? { counts: (s, e, at) => readFirebaseCounts(saPath, s, e, { cohortTiersAtMs: at ?? null }) } : null,
    dryRun,
  }
}

// ── --fixture: one recorded JSON file drives the whole read ───────────────────────────────
export interface Fixture {
  now: string
  ads?: { status: CampaignStatus; daily: Record<string, SpendDay>; placements: PlacementDayRow[] } | { error: string }
  beacon?: {
    tagged: (Omit<TaggedRow, 'hourStartMs'> & { hour?: string; hourStartMs?: number })[]
    siteEvents: (Omit<HourPathCount, 'hourStartMs'> & { hour?: string; hourStartMs?: number })[]
    returns: ReturnRow[]
    returnSites: (Omit<ReturnSiteStat, 'firstMs' | 'lastMs'> & { first?: string | null; last?: string | null; firstMs?: number | null; lastMs?: number | null })[]
  } | { error: string }
  store?: { spend?: StoredSpend | null; readings?: ReadingRecord[]; consumed?: number[] }
  firebase?: FirebaseCounts | null
}

const hourMs = (x: { hour?: string; hourStartMs?: number }) => (x.hourStartMs != null ? x.hourStartMs : Date.parse(x.hour!))
const optMs = (iso: string | null | undefined, ms: number | null | undefined) => (ms != null ? ms : iso ? Date.parse(iso) : null)

export function fixtureDeps(fx: Fixture, dryRun: boolean): ReadDeps & { store: ReturnType<typeof createMemoryStore> } {
  const ads = fx.ads && !('error' in fx.ads) ? fx.ads : null
  const beacon = fx.beacon && !('error' in fx.beacon) ? fx.beacon : null
  const inRange = (d: string, since: string, until: string) => d >= since && d <= until
  const b: BeaconSource | null = beacon
    ? {
        tagged: async () => beacon.tagged.map((r) => ({ hourStartMs: hourMs(r), path: r.path, visitor: r.visitor, count: r.count })),
        siteEvents: async (sinceMs) => beacon.siteEvents.map((r) => ({ hourStartMs: hourMs(r), path: r.path, count: r.count })).filter((r) => r.hourStartMs >= sinceMs),
        returns: async () => beacon.returns,
        returnSites: async () => beacon.returnSites.map((s) => ({ site: s.site, count: s.count, firstMs: optMs(s.first, s.firstMs), lastMs: optMs(s.last, s.lastMs) })),
      }
    : null
  return {
    nowMs: Date.parse(fx.now),
    ads: ads
      ? {
          status: async () => ads.status,
          daily: async (_id, since, until) => Object.fromEntries(Object.entries(ads.daily).filter(([d]) => inRange(d, since, until))),
          placements: async (_id, since, until) => ads.placements.filter((p) => inRange(p.date, since, until)),
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
