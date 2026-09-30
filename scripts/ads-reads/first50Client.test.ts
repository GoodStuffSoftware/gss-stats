// The client-visible first-50 offer (promos_public/first50) next to the promos/first50 counter:
// fenced single-doc read, fail-soft, report text only. The flight is live, so the core proof here
// is that decisions (kill rules, verdicts, completeness, push/no-push) are byte-identical with and
// without the new data.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { fixtureDeps, type Fixture } from './cli'
import { first50ClientUnknown, fencedFetch, promosPublicUrl, readFirebaseCounts, type First50ClientState, type FirebaseCounts } from './firebase'
import { runMorningRead, runPostflightRead, type MorningOptions, type MorningResult, type PostflightResult } from './read'
import { first50FlagLine, first50Text, formatMorningReport, formatPostflightReport } from './report'
import { MIN_COHORT } from '../../src/lib/popupEvents'
import { PROMOS_PUBLIC_FIRST50_LIVE_AT, promoArmAbsentNote } from '../../src/lib/adsRules'
import { clearRegisteredSecrets } from '../../src/lib/adsRedact'
import type { FetchLike } from '../../src/lib/adsApi'

const here = path.dirname(fileURLToPath(import.meta.url))
const base = (): Fixture => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8'))
const opts: MorningOptions = { campaignId: '24279250691', releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24 }
const docs = 'https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents'

const VISIBLE: First50ClientState = { state: 'visible', exists: true, open: true, updateTime: '2026-09-28T20:11:29.123Z', error: null }
const HIDDEN_MISSING: First50ClientState = { state: 'hidden', exists: false, open: null, updateTime: null, error: null }
const HIDDEN_FALSE: First50ClientState = { state: 'hidden', exists: true, open: false, updateTime: '2026-09-28T20:11:29Z', error: null }
const FAILED = first50ClientUnknown('firestore.googleapis.com timed out after 20s')

function withClient(client: First50ClientState | undefined): Fixture {
  const fx = base()
  const fb = { ...(fx.firebase as FirebaseCounts) }
  if (client === undefined) delete fb.first50Client
  else fb.first50Client = client
  fx.firebase = fb
  return fx
}

/** Everything that is a decision: kill rules, verdicts, thresholds, completeness, failures, push. */
function morningDecisions(r: MorningResult) {
  return {
    crossedNow: r.thresholds.crossedNow,
    consumedBefore: r.thresholds.consumedBefore,
    hardCapDaily: r.hardCapDaily,
    kill: r.thresholdRead?.kill ?? null,
    decision: r.thresholdRead?.decision ?? null,
    complete: r.thresholdRead?.complete ?? null,
    failedSources: r.thresholdRead?.failedSources ?? null,
    readErrors: r.thresholdRead?.errors ?? null,
    failures: r.failures,
    releaseHealthAlerts: r.releaseHealth.alerts,
    notify: r.notify,
  }
}
function postflightDecisions(r: PostflightResult) {
  return {
    due: r.due,
    kill: r.read?.kill ?? null,
    decision: r.read?.decision ?? null,
    complete: r.read?.complete ?? null,
    failedSources: r.read?.failedSources ?? null,
    readErrors: r.read?.errors ?? null,
    hardCap: r.hardCap,
    postFlightSpend: r.postFlightSpend,
    recommendations: r.recommendations,
    failures: r.failures,
    notify: r.notify,
  }
}

describe('first-50 client-visible state: decisions are unchanged (the flight is live)', () => {
  const variants: [string, First50ClientState][] = [
    ['visible', VISIBLE],
    ['hidden (doc missing)', HIDDEN_MISSING],
    ['hidden (open=false)', HIDDEN_FALSE],
    ['read failed', FAILED],
  ]
  it('the $50 morning read: kill rules, verdicts, thresholds, completeness and push are identical with and without promos_public data', async () => {
    const without = morningDecisions(await runMorningRead(fixtureDeps(withClient(undefined), false), opts))
    expect(without.crossedNow).toEqual([50])
    expect(without.notify.push).toBe(true)
    for (const [name, client] of variants) {
      const withData = morningDecisions(await runMorningRead(fixtureDeps(withClient(client), false), opts))
      expect(withData, name).toEqual(without)
    }
  })
  it('the $50 morning read writes the same store records with and without promos_public data', async () => {
    const a = fixtureDeps(withClient(undefined), false)
    await runMorningRead(a, opts)
    for (const [name, client] of variants) {
      const b = fixtureDeps(withClient(client), false)
      await runMorningRead(b, opts)
      expect(b.store.written.readings.map(({ readAtMs, ...x }: any) => x), name).toEqual(a.store.written.readings.map(({ readAtMs, ...x }: any) => x))
      expect(await b.store.getConsumedThresholds('24279250691'), name).toEqual(await a.store.getConsumedThresholds('24279250691'))
    }
  })
  it('the post-flight wrap-up read: decision table, completeness and push are identical with and without promos_public data', async () => {
    const at = (client: First50ClientState | undefined) => {
      const fx = withClient(client)
      fx.now = '2026-10-09T13:00:00Z'
      return fixtureDeps(fx, false)
    }
    const without = postflightDecisions(await runPostflightRead(at(undefined), { campaignId: '24279250691', stage: 'wrapup', force: false }))
    expect(without.due).toBe(true)
    for (const [name, client] of variants) {
      const withData = postflightDecisions(await runPostflightRead(at(client), { campaignId: '24279250691', stage: 'wrapup', force: false }))
      expect(withData, name).toEqual(without)
    }
  })
})

describe('first-50 client-visible state: report lines', () => {
  const counts = (client: First50ClientState | undefined, closed = false): FirebaseCounts => ({
    projectId: 'p',
    newAccountsInWindow: 1,
    accountsWithCreatedAt: 15,
    promoClaimsInWindow: 1,
    promoClaimsTotal: 3,
    first50: { cap: 50, claimed: 3, closed },
    ...(client === undefined ? {} : { first50Client: client }),
    errors: [],
  })
  it('reports the counter and the client offer separately', () => {
    expect(first50Text(counts(VISIBLE))).toBe('first-50: counter 3/50 claimed, open; client offer VISIBLE (promos_public open=true, updated 2026-09-28 16:11 ET)')
    expect(first50Text(counts(HIDDEN_MISSING))).toBe('first-50: counter 3/50 claimed, open; client offer HIDDEN (promos_public missing)')
    expect(first50Text(counts(HIDDEN_FALSE))).toBe('first-50: counter 3/50 claimed, open; client offer HIDDEN (promos_public open=false, updated 2026-09-28 16:11 ET)')
    expect(first50Text(counts(FAILED))).toBe('first-50: counter 3/50 claimed, open; client offer UNKNOWN (read failed: firestore.googleapis.com timed out after 20s)')
    expect(first50Text(counts(undefined))).toBe('first-50: counter 3/50 claimed, open; client offer UNKNOWN (read failed: not read)')
  })
  it('flags a disagreement loudly, and only a disagreement', () => {
    expect(first50FlagLine(counts(HIDDEN_MISSING))).toBe('FLAG: first-50 counter says open but the client offer is hidden')
    expect(first50FlagLine(counts(HIDDEN_FALSE))).toBe('FLAG: first-50 counter says open but the client offer is hidden')
    expect(first50FlagLine(counts(VISIBLE, true))).toBe('FLAG: first-50 counter says closed but the client offer is visible')
    expect(first50FlagLine(counts(VISIBLE))).toBeNull()
    expect(first50FlagLine(counts(HIDDEN_MISSING, true))).toBeNull()
    expect(first50FlagLine(counts(FAILED))).toBeNull()
  })
  it('the $50 report prints the Accounts line, the flag at the top and under Accounts, and the promo-arm note by the promo asks', async () => {
    const text = formatMorningReport(await runMorningRead(fixtureDeps(withClient(HIDDEN_MISSING), true), opts))
    const lines = text.split('\n')
    expect(lines.slice(0, 4)).toContain('FLAG: first-50 counter says open but the client offer is hidden')
    const acc = lines.findIndex((l) => l.startsWith('Accounts ('))
    expect(lines[acc]).toContain('first-50: counter 4/50 claimed, open; client offer HIDDEN (promos_public missing)')
    expect(lines[acc + 1]).toBe('  FLAG: first-50 counter says open but the client offer is hidden')
    expect(text).toContain('  promo asks: promo arm absent until 16:11:29 ET 09-28 (promos_public/first50 did not exist)')
    expect(text).toMatch(/first-50 promo: shown .*; promo arm absent until 16:11:29 ET 09-28/)
  })
  it('a visible offer prints no flag; a failed read prints UNKNOWN and the read carries on', async () => {
    const vis = formatMorningReport(await runMorningRead(fixtureDeps(withClient(VISIBLE), true), opts))
    expect(vis).toContain('client offer VISIBLE (promos_public open=true')
    expect(vis).not.toContain('FLAG:')
    const failed = await runMorningRead(fixtureDeps(withClient(FAILED), true), opts)
    expect(failed.failures).toEqual([])
    expect(failed.thresholdRead!.complete).toBe(true)
    expect(formatMorningReport(failed)).toContain('client offer UNKNOWN (read failed: firestore.googleapis.com timed out after 20s)')
  })
  it('the post-flight report carries the promo-arm note too', async () => {
    const fx = withClient(VISIBLE)
    fx.now = '2026-10-09T13:00:00Z'
    const text = formatPostflightReport(await runPostflightRead(fixtureDeps(fx, true), { campaignId: '24279250691', stage: 'wrapup', force: false }))
    expect(text).toContain('promo asks: promo arm absent until 16:11:29 ET 09-28 (promos_public/first50 did not exist)')
  })
  it('the note constant is 2026-09-28T20:11:29Z, labelled by ET arithmetic, and has no em-dash', () => {
    expect(PROMOS_PUBLIC_FIRST50_LIVE_AT).toBe(Date.parse('2026-09-28T20:11:29Z'))
    expect(promoArmAbsentNote()).toBe('promo arm absent until 16:11:29 ET 09-28 (promos_public/first50 did not exist)')
    expect(promoArmAbsentNote()).not.toContain(String.fromCharCode(0x2014))
  })
})

describe('first-50 client-visible state: the Firestore read', () => {
  afterEach(() => clearRegisteredSecrets())
  const run = async (answer: (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>) => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    const sa = path.join(os.tmpdir(), `gss-test-sa-f50-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
    fs.writeFileSync(sa, JSON.stringify({ project_id: 'p', client_email: 'x@p.iam.gserviceaccount.com', private_key: privateKey }))
    const seen: string[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push(`${init.method} ${url.replace(docs, '<docs>')}`)
      if (url.includes('oauth2')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ya29.test-token' }) }
      if (url.endsWith('/promos/first50')) return { ok: true, status: 200, text: async () => JSON.stringify({ fields: { cap: { integerValue: '50' }, claimed: { integerValue: '3' }, closed: { booleanValue: false } } }) }
      if (url.includes('promos_public')) return answer(url)
      return { ok: true, status: 200, text: async () => JSON.stringify([{ result: { aggregateFields: { n: { integerValue: '4' } } } }]) }
    }
    try {
      const out = await readFirebaseCounts(sa, Date.parse('2026-09-26T16:00:00Z'), Date.parse('2026-10-03T04:00:00Z'), { fetchImpl })
      return { out, seen }
    } finally {
      fs.rmSync(sa, { force: true })
    }
  }
  it('reads exactly one doc, masked to `open`, and never touches users/ or any other collection', async () => {
    const { out, seen } = await run(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ name: 'x', fields: { open: { booleanValue: true } }, updateTime: '2026-09-28T20:11:29.5Z' }) }))
    expect(out.first50Client).toEqual({ state: 'visible', exists: true, open: true, updateTime: '2026-09-28T20:11:29.5Z', error: null })
    expect(seen.filter((s) => s.includes('promos_public'))).toEqual(['GET <docs>/promos_public/first50?mask.fieldPaths=open'])
    expect(seen.every((s) => /^POST https:\/\/oauth2|^POST <docs>:runAggregationQuery$|^GET <docs>\/promos\/first50$|^GET <docs>\/promos_public\/first50\?mask\.fieldPaths=open$/.test(s))).toBe(true)
    expect(out.errors).toEqual([])
  })
  it('404 = missing = hidden; open=false = hidden', async () => {
    expect((await run(async () => ({ ok: false, status: 404, text: async () => '{"error":{"status":"NOT_FOUND"}}' }))).out.first50Client).toEqual(HIDDEN_MISSING)
    expect((await run(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ fields: { open: { booleanValue: false } } }) }))).out.first50Client).toMatchObject({ state: 'hidden', exists: true, open: false })
  })
  it('FAIL-SOFT: a throw, a timeout or an HTTP error becomes UNKNOWN with a short reason, never an entry in errors', async () => {
    const timeout = await run(async () => {
      throw new Error('firestore.googleapis.com timed out after 20s')
    })
    expect(timeout.out.first50Client).toEqual(first50ClientUnknown('firestore.googleapis.com timed out after 20s'))
    expect(timeout.out.errors).toEqual([])
    expect(timeout.out.first50).toEqual({ cap: 50, claimed: 3, closed: false })
    const http = await run(async () => ({ ok: false, status: 503, text: async () => 'unavailable' }))
    expect(http.out.first50Client).toMatchObject({ state: 'unknown', error: 'promos_public/first50 HTTP 503' })
    expect(http.out.errors).toEqual([])
    const junk = await run(async () => ({ ok: true, status: 200, text: async () => 'not json' }))
    expect(junk.out.first50Client!.state).toBe('unknown')
    expect(junk.out.errors).toEqual([])
    const leaky = await run(async () => {
      throw new Error(`boom at ${docs}/promos_public/first50 with Bearer ya29.test-token`)
    })
    expect(leaky.out.first50Client!.error).not.toMatch(/ya29|https?:/)
  })
  it('the fence allows the masked promos_public GET and refuses every other promos_public call', () => {
    const f = fencedFetch(async () => ({ ok: true, status: 200, text: async () => '{}' }), docs)
    expect(() => f(promosPublicUrl(docs), { method: 'GET', headers: {} })).not.toThrow()
    for (const [url, method] of [
      [`${docs}/promos_public/first50`, 'GET'],
      [`${docs}/promos_public/first50`, 'PATCH'],
      [`${docs}/promos_public/first50?mask.fieldPaths=open`, 'PATCH'],
      [`${docs}/promos_public`, 'GET'],
      [`${docs}/users/abc?mask.fieldPaths=open`, 'GET'],
    ]) {
      expect(() => f(url, { method, headers: {} })).toThrow(/refused/)
    }
  })
})
