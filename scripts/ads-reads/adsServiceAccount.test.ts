// The Google Ads service-account path (ADS_SA_B64 + ADS_DEVELOPER_TOKEN) and the plain-ASCII
// CLI output. No network: every remote is a fake fetch.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { clearRegisteredSecrets, redact } from '../../src/lib/adsRedact'
import { createAdsClient, type FetchLike } from '../../src/lib/adsApi'
import { ADS_SA_ENV, adsCredentialSource, loadAdsAuth } from './secrets'
import { ADWORDS_SCOPE, GOOGLE_TOKEN_URL, signedAssertion } from './googleSa'
import { errorClass, runCloudCheck, type CloudCheckProbes } from './cloud-check'
import { fixtureDeps, type Fixture } from './cli'
import { WRANGLER_WITHHELD_ENV } from './wrangler'
import { runMorningRead, runPostflightRead } from './read'
import { asciiFold, asciiResult, formatMorningReport, formatPostflightReport, jsonOnly, withJson } from './report'

const here = path.dirname(fileURLToPath(import.meta.url))
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const SA = { type: 'service_account', project_id: 'proj-x', client_email: 'gss-ads-reads-ads@proj-x.iam.gserviceaccount.com', private_key: PEM }
const SA_B64 = Buffer.from(JSON.stringify(SA)).toString('base64')
const DEV = 'env-developer-token-value-444'
const REFRESH = { ADS_CLIENT_ID: 'env-client-id-value-111', ADS_CLIENT_SECRET: 'env-client-secret-value-222', ADS_REFRESH_TOKEN: 'env-refresh-token-value-333', ADS_DEVELOPER_TOKEN: DEV }

afterEach(() => clearRegisteredSecrets())

function fakeAdsFetch() {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = []
  const f: FetchLike = async (url, init) => {
    calls.push({ url, ...init })
    if (url === GOOGLE_TOKEN_URL) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ya29.fake-access-token-value' }) }
    return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ customer: { id: '1' } }] }) }
  }
  return { f, calls }
}

const decode = (part: string) => JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))

describe('Ads service account (ADS_SA_B64)', () => {
  it('is picked over the refresh-token set, and bws still wins over both', () => {
    expect(adsCredentialSource({ [ADS_SA_ENV]: SA_B64, ADS_DEVELOPER_TOKEN: DEV })).toBe('env-sa')
    expect(adsCredentialSource({ ...REFRESH, [ADS_SA_ENV]: SA_B64 })).toBe('env-sa')
    expect(adsCredentialSource({ ...REFRESH })).toBe('env')
    expect(adsCredentialSource({ [ADS_SA_ENV]: SA_B64, BWS_ACCESS_TOKEN: 'x' })).toBe('bws')
  })

  it('signs an RS256 JWT for the adwords scope that the public key verifies', () => {
    const jwt = signedAssertion(SA, ADWORDS_SCOPE, 1_000)
    const [h, p, s] = jwt.split('.')
    expect(decode(h)).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(decode(p)).toEqual({ iss: SA.client_email, scope: ADWORDS_SCOPE, aud: GOOGLE_TOKEN_URL, iat: 1_000, exp: 4_600 })
    const sig = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, sig)).toBe(true)
  })

  it('exchanges a jwt-bearer grant, then searches with the same headers as the refresh-token path', async () => {
    const sa = fakeAdsFetch()
    const client = await createAdsClient(await loadAdsAuth({ env: { [ADS_SA_ENV]: SA_B64, ADS_DEVELOPER_TOKEN: DEV } }), { fetchImpl: sa.f })
    await client.search('SELECT customer.id FROM customer LIMIT 1')
    const tokenBody = new URLSearchParams(sa.calls[0].body)
    expect(sa.calls[0].url).toBe(GOOGLE_TOKEN_URL)
    expect(tokenBody.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(decode(tokenBody.get('assertion')!.split('.')[1]).scope).toBe(ADWORDS_SCOPE)
    expect([...tokenBody.keys()].sort()).toEqual(['assertion', 'grant_type'])

    const rt = fakeAdsFetch()
    const rtClient = await createAdsClient(await loadAdsAuth({ env: { ...REFRESH } }), { fetchImpl: rt.f })
    await rtClient.search('SELECT customer.id FROM customer LIMIT 1')
    expect(sa.calls[1].headers).toEqual(rt.calls[1].headers)
    expect(sa.calls[1].url).toBe(rt.calls[1].url)
    expect(Object.keys(sa.calls[1].headers).map((k) => k.toLowerCase())).not.toContain('login-customer-id')
    expect(sa.calls[1].headers['developer-token']).toBe(DEV)
  })

  it('registers the encoded value, the JSON, the private key and the developer token before any use', async () => {
    await loadAdsAuth({ env: { [ADS_SA_ENV]: SA_B64, ADS_DEVELOPER_TOKEN: DEV } })
    for (const v of [SA_B64, JSON.stringify(SA), PEM, DEV]) expect(redact(`x ${v} y`)).not.toContain(v)
  })

  it('a missing developer token or an unreadable key fails with variable names only', async () => {
    const noDev = await loadAdsAuth({ env: { [ADS_SA_ENV]: SA_B64 } }).then(() => '', (e: Error) => e.message)
    expect(noDev).toContain('ADS_DEVELOPER_TOKEN')
    expect(noDev).not.toContain(SA_B64)
    const junk = Buffer.from('not json at all, secret-ish-junk-value').toString('base64')
    const bad = await loadAdsAuth({ env: { [ADS_SA_ENV]: junk, ADS_DEVELOPER_TOKEN: DEV } }).then(() => '', (e: Error) => e.message)
    expect(bad).toBe(`${ADS_SA_ENV} service account unreadable`)
    expect(errorClass(new Error(bad))).toBe('bad-credential')
    expect(errorClass(new Error('service-account token exchange failed, HTTP 401'))).toBe('auth')
  })

  it('a failed exchange reports the HTTP status only', async () => {
    const f: FetchLike = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: 'invalid_grant', leaked: SA.client_email }) })
    const msg = await createAdsClient(await loadAdsAuth({ env: { [ADS_SA_ENV]: SA_B64, ADS_DEVELOPER_TOKEN: DEV } }), { fetchImpl: f }).then(() => '', (e: Error) => e.message)
    expect(msg).toBe('service-account token exchange failed, HTTP 400')
  })
})

describe('wrangler child env', () => {
  it('withholds ADS_SA_B64 (and the other read credentials) from wrangler', () => {
    expect(WRANGLER_WITHHELD_ENV).toContain(ADS_SA_ENV)
    expect(WRANGLER_WITHHELD_ENV).toContain('ADS_DEVELOPER_TOKEN')
    expect(WRANGLER_WITHHELD_ENV).toContain('FIRESTORE_SA_B64')
  })
})

describe('ads:cloud-check with the service account', () => {
  const probes: CloudCheckProbes = { ads: async () => {}, firestore: async () => {}, d1Ads: async () => {}, d1Beacon: async () => {} }
  const rest = { FIRESTORE_SA_B64: 'c2EtYjY0LXZhbHVl', CLOUDFLARE_API_TOKEN: 'cf-env-token-value-555', CLOUDFLARE_ACCOUNT_ID: 'acct-test-id' }
  it('accepts ADS_SA_B64 + ADS_DEVELOPER_TOKEN without the refresh-token names', async () => {
    const { lines, ok } = await runCloudCheck({ ...rest, [ADS_SA_ENV]: SA_B64, ADS_DEVELOPER_TOKEN: DEV }, probes)
    expect(ok).toBe(true)
    expect(lines[0]).toBe('ads       ADS_SA_B64=present ADS_DEVELOPER_TOKEN=present -> ok')
    expect(lines.join('\n')).not.toContain(SA_B64)
  })
  it('ADS_SA_B64 without the developer token fails missing-env', async () => {
    const { lines, ok } = await runCloudCheck({ ...rest, [ADS_SA_ENV]: SA_B64 }, probes)
    expect(ok).toBe(false)
    expect(lines[0]).toBe('ads       ADS_SA_B64=present ADS_DEVELOPER_TOKEN=missing -> fail: missing-env')
  })
  it('still accepts the refresh-token set', async () => {
    const { lines } = await runCloudCheck({ ...rest, ...REFRESH }, probes)
    expect(lines[0]).toBe('ads       ADS_CLIENT_ID=present ADS_CLIENT_SECRET=present ADS_REFRESH_TOKEN=present ADS_DEVELOPER_TOKEN=present -> ok')
  })
})

describe('plain-ASCII CLI output', () => {
  const NON_ASCII = /[^\x00-\x7f]/
  it('folds the report typography', () => {
    expect(asciiFold('a — b · c → d ≥ e ’s … café 中')).toBe("a - b | c -> d >= e 's ... cafe ?")
    expect(asciiResult({ 'k—': ['x — y', 1, null, { t: '≤' }] })).toEqual({ 'k-': ['x - y', 1, null, { t: '<=' }] })
  })
  it('morning-read and every post-flight stage print ASCII only, and the JSON still parses', async () => {
    const fx: Fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8'))
    const m = await runMorningRead(fixtureDeps(fx, true), { campaignId: '24279250691', releaseHealth: 'auto', healthOnly: false, healthMinParent: 5, healthParentAgeHours: 24 })
    const outs = [withJson(formatMorningReport(m), m), jsonOnly(m)]
    expect(NON_ASCII.test(formatMorningReport(m))).toBe(true) // the raw formatter still has typography: the fold is what fixes it
    for (const [stage, now] of [['wrapup', '2026-10-09T13:00:00Z'], ['day15', '2026-10-17T13:00:00Z'], ['december', '2026-12-03T14:00:00Z']] as const) {
      const r = await runPostflightRead(fixtureDeps({ ...fx, now }, true), { campaignId: '24279250691', stage, force: false })
      outs.push(withJson(formatPostflightReport(r), r))
    }
    for (const out of outs) {
      expect(out.match(NON_ASCII)).toBeNull()
      const json = out.includes('----- JSON -----') ? out.split('----- JSON -----\n')[1] : out
      const parsed = JSON.parse(json)
      if (parsed.notify?.text) expect(NON_ASCII.test(parsed.notify.text)).toBe(false)
    }
  })
})
