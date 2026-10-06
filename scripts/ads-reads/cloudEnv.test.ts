// The env-var credential paths (the claude.ai cloud routine) and ads:cloud-check's output shape.
// No network: every remote is a fake fetch, a fake bws runner or a fake wrangler binary.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { clearRegisteredSecrets, redact } from '../../src/lib/adsRedact'
import type { FetchLike } from '../../src/lib/adsApi'
import { adsCredentialSource, adsCredentialsFromEnv, BWS_KEYS, ENV_KEYS, loadAdsCredentials, type BwsRunner } from './secrets'
import { FIRESTORE_SA_ENV, probeFirestoreCount, readFirebaseCounts, serviceAccountFromEnv } from './firebase'
import { errorClass, ERROR_CLASSES, runCloudCheck, type CloudCheckProbes } from './cloud-check'
import { loadCfToken } from './cli'
import { createD1Select } from './d1'
import { wranglerAdsDb } from './d1Store'
import { createWranglerRunner, repoRoot } from './wrangler'

const VALUES = {
  ADS_CLIENT_ID: 'env-client-id-value-111',
  ADS_CLIENT_SECRET: 'env-client-secret-value-222',
  ADS_REFRESH_TOKEN: 'env-refresh-token-value-333',
  ADS_DEVELOPER_TOKEN: 'env-developer-token-value-444',
}
const allValues = () => Object.values(VALUES)

afterEach(() => clearRegisteredSecrets())

describe('Ads credentials from env (no bws)', () => {
  it('uses the sync Worker binding names', () => {
    expect(Object.values(ENV_KEYS)).toEqual(['ADS_CLIENT_ID', 'ADS_CLIENT_SECRET', 'ADS_REFRESH_TOKEN', 'ADS_DEVELOPER_TOKEN'])
    const toml = fs.readFileSync(path.join(repoRoot(), 'workers', 'sync', 'wrangler.toml'), 'utf8')
    for (const name of Object.values(ENV_KEYS)) expect(toml).toContain(`binding = "${name}"`)
  })
  it('loads all four from env when BWS_ACCESS_TOKEN is unset, and registers each for redaction', async () => {
    const runBws: BwsRunner = async () => {
      throw new Error('bws must not run')
    }
    const creds = await loadAdsCredentials({ env: { ...VALUES }, runBws })
    expect(creds).toEqual({ clientId: VALUES.ADS_CLIENT_ID, clientSecret: VALUES.ADS_CLIENT_SECRET, refreshToken: VALUES.ADS_REFRESH_TOKEN, developerToken: VALUES.ADS_DEVELOPER_TOKEN })
    for (const v of allValues()) expect(redact(`body: ${v}`)).toBe('body: <redacted>')
  })
  it('the bws path still wins when BWS_ACCESS_TOKEN is set, even with every ADS_* var present', async () => {
    const calls: string[][] = []
    const runBws: BwsRunner = async (args) => {
      calls.push(args)
      return { code: 0, stdout: JSON.stringify(Object.values(BWS_KEYS).map((key) => ({ key, value: `${key}-from-bws` }))), stderr: '' }
    }
    const env = { ...VALUES, BWS_ACCESS_TOKEN: 'bws-access-token-value' }
    expect(adsCredentialSource(env)).toBe('bws')
    const creds = await loadAdsCredentials({ env, runBws })
    expect(calls).toHaveLength(1)
    expect(creds.clientId).toBe(`${BWS_KEYS.clientId}-from-bws`)
    expect(Object.values(creds)).not.toContain(VALUES.ADS_CLIENT_ID)
  })
  it('the missing-env error lists variable NAMES only, never a value', async () => {
    const partial = { ADS_CLIENT_ID: VALUES.ADS_CLIENT_ID, ADS_REFRESH_TOKEN: '   ' }
    expect(adsCredentialSource(partial)).toBeNull()
    const err = await loadAdsCredentials({ env: partial }).then(
      () => null,
      (e: Error) => e.message,
    )
    expect(err).toMatch(/BWS_ACCESS_TOKEN/)
    expect(err).toMatch(/ADS_CLIENT_ID, ADS_CLIENT_SECRET, ADS_REFRESH_TOKEN, ADS_DEVELOPER_TOKEN/)
    expect(err).toMatch(/missing: ADS_CLIENT_SECRET, ADS_REFRESH_TOKEN, ADS_DEVELOPER_TOKEN\)/)
    expect(err).not.toContain(VALUES.ADS_CLIENT_ID)
    expect(adsCredentialsFromEnv({}).missing).toEqual(Object.values(ENV_KEYS))
  })
})

function testServiceAccount() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  const json = JSON.stringify({ project_id: 'p', client_email: 'x@p.iam.gserviceaccount.com', private_key: privateKey })
  return { privateKey, json, b64: Buffer.from(json, 'utf8').toString('base64') }
}

describe('Firestore service account from FIRESTORE_SA_B64', () => {
  it('decodes in memory, registers the key and the whole JSON, and reads counts without a key file', async () => {
    const { privateKey, json, b64 } = testServiceAccount()
    const src = serviceAccountFromEnv({ [FIRESTORE_SA_ENV]: b64 })
    expect(src).toEqual({ json })
    expect(redact(`x ${json} y`)).toBe('x <redacted> y')
    expect(redact(privateKey)).toBe('<redacted>')
    expect(redact(b64)).toBe('<redacted>')
    const seen: string[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push(`${init.method} ${url}`)
      if (url.includes('oauth2')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ya29.test-token' }) }
      if (url.endsWith(':runAggregationQuery')) return { ok: true, status: 200, text: async () => JSON.stringify([{ result: { aggregateFields: { n: { integerValue: '7' } } } }]) }
      return { ok: false, status: 404, text: async () => '' }
    }
    const out = await readFirebaseCounts(src!, Date.parse('2026-09-26T16:00:00Z'), Date.parse('2026-10-03T04:00:00Z'), { fetchImpl })
    expect(out.projectId).toBe('p')
    expect(out.newAccountsInWindow).toBe(7)
    expect(seen.every((s) => /^POST https:\/\/oauth2|:runAggregationQuery$|\/promos\/first50|promos_public/.test(s))).toBe(true)
  })
  it('unset is null; a malformed value names the variable only', async () => {
    expect(serviceAccountFromEnv({})).toBeNull()
    const bad = serviceAccountFromEnv({ [FIRESTORE_SA_ENV]: 'not-json-at-all-secretish' })!
    const fetchImpl: FetchLike = async () => {
      throw new Error('no fetch expected')
    }
    const out = await readFirebaseCounts(bad, 0, 1, { fetchImpl })
    expect(out.errors).toEqual([`${FIRESTORE_SA_ENV} service account unreadable`])
  })
  it('the cloud-check probe runs exactly one COUNT aggregation and returns nothing', async () => {
    const { b64 } = testServiceAccount()
    const bodies: string[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.includes('oauth2')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ya29.test-token' }) }
      bodies.push(init.body!)
      return { ok: true, status: 200, text: async () => JSON.stringify([{ result: { aggregateFields: { n: { integerValue: '12345' } } } }]) }
    }
    expect(await probeFirestoreCount(serviceAccountFromEnv({ [FIRESTORE_SA_ENV]: b64 })!, { fetchImpl })).toBeUndefined()
    expect(bodies).toHaveLength(1)
    expect(JSON.parse(bodies[0]).structuredAggregationQuery.aggregations).toEqual([{ alias: 'n', count: {} }])
  })
})

describe('D1 from CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID only', () => {
  it('loadCfToken falls back to CLOUDFLARE_API_TOKEN and registers it', () => {
    const prev = process.env.CLOUDFLARE_API_TOKEN
    process.env.CLOUDFLARE_API_TOKEN = 'cf-env-token-value-555'
    try {
      expect(loadCfToken(undefined)).toBe('cf-env-token-value-555')
      expect(redact('cf-env-token-value-555')).toBe('<redacted>')
    } finally {
      if (prev === undefined) delete process.env.CLOUDFLARE_API_TOKEN
      else process.env.CLOUDFLARE_API_TOKEN = prev
    }
  })
  it('wrangler gets the token and inherits CLOUDFLARE_ACCOUNT_ID with no --cf-token-file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gss-wr-env-'))
    const bin = path.join(root, 'node_modules', 'wrangler', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    // A stand-in wrangler: reports only WHETHER both vars arrived as expected, as D1 JSON.
    fs.writeFileSync(
      path.join(bin, 'wrangler.js'),
      [
        "const ok = process.env.CLOUDFLARE_API_TOKEN === 'cf-env-token-value-555' && process.env.CLOUDFLARE_ACCOUNT_ID === 'acct-test-id'",
        'process.stdout.write(JSON.stringify([{ success: true, results: [{ one: ok ? 1 : 0, db: process.argv[4] }] }]))',
        '',
      ].join('\n'),
    )
    const prev = process.env.CLOUDFLARE_ACCOUNT_ID
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct-test-id'
    try {
      const run = createWranglerRunner({ root, cfToken: 'cf-env-token-value-555' })
      expect(await createD1Select(run)('SELECT 1')).toEqual([{ one: 1, db: 'gss-geo' }])
      expect(await wranglerAdsDb(run).all({ sql: 'SELECT 1', binds: [] })).toEqual([{ one: 1, db: 'gss-stats-ads' }])
    } finally {
      if (prev === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID
      else process.env.CLOUDFLARE_ACCOUNT_ID = prev
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }, 30_000)

  it('the wrangler child does not inherit the Ads, Firestore or Bitwarden secrets, but keeps CLOUDFLARE_* and PATH', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gss-wr-strip-'))
    const bin = path.join(root, 'node_modules', 'wrangler', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    // Reports the NAMES of the stripped keys that are present in its env (never values), plus keepers.
    fs.writeFileSync(
      path.join(bin, 'wrangler.js'),
      [
        "const stripped = ['ADS_CLIENT_ID','ADS_CLIENT_SECRET','ADS_REFRESH_TOKEN','ADS_DEVELOPER_TOKEN','ADS_SA_B64','FIRESTORE_SA_B64','BWS_ACCESS_TOKEN']",
        "const leaked = stripped.filter((k) => k in process.env).join(',')",
        "const kept = ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','PATH'].every((k) => !!process.env[k] || (k === 'PATH' && !!process.env.Path))",
        'process.stdout.write(JSON.stringify([{ success: true, results: [{ leaked, kept }] }]))',
        '',
      ].join('\n'),
    )
    const keys = ['ADS_CLIENT_ID', 'ADS_CLIENT_SECRET', 'ADS_REFRESH_TOKEN', 'ADS_DEVELOPER_TOKEN', 'ADS_SA_B64', 'FIRESTORE_SA_B64', 'BWS_ACCESS_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    for (const k of keys) process.env[k] = `strip-test-${k}`
    try {
      const run = createWranglerRunner({ root, cfToken: 'cf-env-token-value-555' })
      expect(await createD1Select(run)('SELECT 1')).toEqual([{ leaked: '', kept: true }])
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k]
        else process.env[k] = prev[k]
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }, 30_000)
})

describe('ads:cloud-check output', () => {
  const fullEnv = { ...VALUES, FIRESTORE_SA_B64: 'c2EtYjY0LXZhbHVl', CLOUDFLARE_API_TOKEN: 'cf-env-token-value-555', CLOUDFLARE_ACCOUNT_ID: 'acct-test-id' }
  const okProbes = (): CloudCheckProbes & { calls: string[] } => {
    const calls: string[] = []
    return {
      calls,
      ads: async () => void calls.push('ads'),
      firestore: async () => void calls.push('firestore'),
      d1Ads: async () => void calls.push('d1Ads'),
      d1Beacon: async () => void calls.push('d1Beacon'),
    }
  }
  const LINE = /^(ads|firestore|d1-ads|d1-beacon) +( ?[A-Z0-9_]+=(present|missing))+ -> (ok|fail: [a-z0-9-]+)$/

  it('one line per dependency: names, present|missing, ok; exit ok when all pass', async () => {
    const p = okProbes()
    const { lines, ok } = await runCloudCheck(fullEnv, p)
    expect(ok).toBe(true)
    expect(p.calls).toEqual(['ads', 'firestore', 'd1Ads', 'd1Beacon'])
    expect(lines).toEqual([
      'ads       ADS_CLIENT_ID=present ADS_CLIENT_SECRET=present ADS_REFRESH_TOKEN=present ADS_DEVELOPER_TOKEN=present -> ok',
      'firestore FIRESTORE_SA_B64=present -> ok',
      'd1-ads    CLOUDFLARE_API_TOKEN=present CLOUDFLARE_ACCOUNT_ID=present -> ok',
      'd1-beacon CLOUDFLARE_API_TOKEN=present CLOUDFLARE_ACCOUNT_ID=present -> ok',
    ])
  })
  it('missing vars skip the probe and fail; nothing printed carries a value', async () => {
    const p = okProbes()
    const env = { ADS_CLIENT_ID: VALUES.ADS_CLIENT_ID, CLOUDFLARE_API_TOKEN: 'cf-env-token-value-555' }
    const { lines, ok } = await runCloudCheck(env, p)
    expect(ok).toBe(false)
    expect(p.calls).toEqual([])
    for (const l of lines) expect(l).toMatch(LINE)
    expect(lines[0]).toBe('ads       ADS_CLIENT_ID=present ADS_CLIENT_SECRET=missing ADS_REFRESH_TOKEN=missing ADS_DEVELOPER_TOKEN=missing -> fail: missing-env')
    const text = lines.join('\n')
    expect(text).not.toContain(VALUES.ADS_CLIENT_ID)
    expect(text).not.toContain('cf-env-token-value-555')
  })
  it('a probe failure prints only a fixed error class, never the message (which may carry ids, counts or tokens)', async () => {
    const leaky = 'customers/8726535246 HTTP 403 PERMISSION_DENIED token ya29.leak count=12345 env-developer-token-value-444'
    const p: CloudCheckProbes = {
      ads: async () => {
        throw new Error(`Google Ads search failed, ${leaky}`)
      },
      firestore: async () => {
        throw new Error('www.googleapis.com timed out after 60s')
      },
      d1Ads: async () => {
        throw new Error('wrangler d1 execute gss-stats-ads failed (exit 1): something acct-test-id')
      },
      d1Beacon: async () => {
        throw new Error('runAggregationQuery HTTP 503 12345')
      },
    }
    const { lines, ok } = await runCloudCheck(fullEnv, p)
    expect(ok).toBe(false)
    expect(lines.map((l) => l.split(' -> ')[1])).toEqual(['fail: auth', 'fail: timeout', 'fail: wrangler-exit', 'fail: http-5xx'])
    const text = lines.join('\n')
    for (const bad of ['8726535246', 'ya29', '12345', 'acct-test-id', ...allValues(), 'c2EtYjY0LXZhbHVl']) expect(text).not.toContain(bad)
    for (const l of lines) expect(l).toMatch(LINE)
  })
  it('with BWS_ACCESS_TOKEN set, the ads line reports the bws path and does not require ADS_*', async () => {
    const p = okProbes()
    const { lines } = await runCloudCheck({ BWS_ACCESS_TOKEN: 'bws-access-token-value' }, p)
    expect(lines[0]).toBe('ads       ADS_CLIENT_ID=missing ADS_CLIENT_SECRET=missing ADS_REFRESH_TOKEN=missing ADS_DEVELOPER_TOKEN=missing BWS_ACCESS_TOKEN=present -> ok')
    expect(lines[0]).not.toContain('bws-access-token-value')
  })
  it('errorClass only ever returns a label from the fixed list', () => {
    for (const m of ['OAuth refresh failed, HTTP 400: invalid_grant', 'fetch failed', 'HTTP 404', 'bws secret list returned output that is not JSON', 'wrangler is not installed in this checkout (run npm ci)', 'anything else', '']) {
      expect(ERROR_CLASSES).toContain(errorClass(new Error(m)))
    }
    expect(errorClass(new Error('no Google Ads credentials: set BWS_ACCESS_TOKEN'))).toBe('bad-credential')
    expect(errorClass(new Error('fetch failed'))).toBe('network')
    expect(errorClass(new Error('Google Ads search failed, HTTP 404: x'))).toBe('http-4xx')
  })
})
