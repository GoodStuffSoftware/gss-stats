// cloud-mint and cloud-env with fakes for gcloud, bws, fetch and PowerShell. No network, no
// real binaries, no real clipboard.

import { afterEach, describe, expect, it } from 'vitest'
import { clearRegisteredSecrets } from '../../src/lib/adsRedact'
import type { FetchLike } from '../../src/lib/adsApi'
import type { BwsRunner } from './secrets'
import {
  ADS_SA_ID,
  assertSafeGcloudArgs,
  CF_ACCOUNT_ID,
  CF_TOKEN_FILE,
  CF_TOKEN_NAME,
  cfTokenBody,
  EXPECTED_ADS_PROJECT,
  FIRESTORE_ROLE,
  MINT_KEYS,
  mintAdsSa,
  mintCfD1,
  mintFirestoreSa,
  pickPermissionGroups,
  type ExecResult,
  type MintDeps,
} from './cloud-mint'
import { buildEnvBlock, CLEAR_SCRIPT, CLOUD_ENV_SPEC, powershellArgs, runCloudEnv, SET_SCRIPT, sha256Hex, type PowerShellRunner } from './cloud-env'

afterEach(() => clearRegisteredSecrets())

const PROD = 'prod-project-uuid'
const KEY_JSON = (email: string) => JSON.stringify({ type: 'service_account', client_email: email, private_key: '-----BEGIN PRIVATE KEY-----\nMIIfakeprivatekeymaterial\n-----END PRIVATE KEY-----\n', private_key_id: 'keyid123' })
const CLIENT_ID = '353430848249-abcdef123.apps.googleusercontent.com'
const CF_ADMIN = 'cf-admin-token-value-0123456789'
const CF_NEW = 'cf-minted-d1-token-value-9876543210'

function fakeBws(secrets: { key: string; value: string; projectId?: string }[]) {
  const calls: string[][] = []
  const created: { key: string; value: string; project: string }[] = []
  const bws: BwsRunner = async (args) => {
    calls.push(args)
    if (args[0] === 'project' && args[1] === 'list') return { code: 0, stdout: JSON.stringify([{ id: PROD, name: 'prod' }, { id: 'dev-id', name: 'dev' }]), stderr: '' }
    if (args[0] === 'secret' && args[1] === 'list') return { code: 0, stdout: JSON.stringify(secrets.map((s) => ({ projectId: PROD, ...s }))), stderr: '' }
    if (args[0] === 'secret' && args[1] === 'create') {
      created.push({ key: args[2], value: args[3], project: args[4] })
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 1, stdout: '', stderr: 'unexpected' }
  }
  return { bws, calls, created }
}

function fakeGcloud(opts: { saExists?: boolean; projectNumber?: string; projectId?: string; adsEnabled?: boolean } = {}) {
  const calls: string[][] = []
  const files = new Map<string, string>()
  const gcloud = async (args: string[]): Promise<ExecResult> => {
    assertSafeGcloudArgs(args)
    calls.push(args)
    const j = args.join(' ')
    if (j.startsWith('iam service-accounts describe')) return opts.saExists ? { code: 0, stdout: '{}', stderr: '' } : { code: 1, stdout: '', stderr: 'NOT_FOUND' }
    if (j.startsWith('iam service-accounts keys create')) {
      const email = args.find((a) => a.startsWith('--iam-account='))!.split('=')[1]
      files.set(args[4], KEY_JSON(email))
      return { code: 0, stdout: '', stderr: '' }
    }
    if (j.startsWith('projects describe')) return { code: 0, stdout: JSON.stringify({ projectId: opts.projectId ?? EXPECTED_ADS_PROJECT, projectNumber: opts.projectNumber ?? '353430848249' }), stderr: '' }
    if (j.startsWith('services list')) return { code: 0, stdout: JSON.stringify(opts.adsEnabled === false ? [] : [{ config: { name: 'googleads.googleapis.com' } }]), stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { gcloud, calls, files }
}

function deps(over: Partial<MintDeps> & { files?: Map<string, string> }) {
  const logs: string[] = []
  const removed: string[] = []
  const files = over.files ?? new Map<string, string>()
  const d: MintDeps = {
    bws: over.bws ?? fakeBws([]).bws,
    gcloud: over.gcloud ?? fakeGcloud().gcloud,
    fetch: over.fetch ?? (async () => ({ ok: false, status: 500, text: async () => '{}' })),
    readFile: (p) => {
      if (p === CF_TOKEN_FILE) return `${CF_ADMIN}\n`
      const v = files.get(p)
      if (v === undefined) throw new Error('no such file')
      return v
    },
    mkdtemp: () => 'C:\\tmp\\gss-mint-abc',
    rmDir: (dir) => void removed.push(dir),
    sleep: async () => {},
    log: (l) => void logs.push(l),
  }
  return { d, logs, removed }
}

const allSecretValues = [CF_ADMIN, CF_NEW, CLIENT_ID, 'MIIfakeprivatekeymaterial']
const printedNothingSecret = (logs: string[]) => {
  const text = logs.join('\n')
  for (const v of allSecretValues) expect(text).not.toContain(v)
  expect(text).not.toMatch(/PRIVATE KEY/)
}

describe('cloud-mint: Firestore SA', () => {
  it('creates the SA, grants datastore.viewer, stores base64 of the key in prod, deletes the temp dir, prints names only', async () => {
    const b = fakeBws([])
    const g = fakeGcloud()
    const { d, logs, removed } = deps({ bws: b.bws, gcloud: g.gcloud, files: g.files })
    await mintFirestoreSa(d)
    const email = 'gss-ads-reads-ro@best-sudoku-prod.iam.gserviceaccount.com'
    expect(g.calls.map((c) => c.slice(0, 3).join(' '))).toEqual(['iam service-accounts describe', 'iam service-accounts create', 'projects add-iam-policy-binding best-sudoku-prod', 'iam service-accounts keys'])
    expect(g.calls[2]).toContain(`--role=${FIRESTORE_ROLE}`)
    expect(g.calls[2]).toContain(`--member=serviceAccount:${email}`)
    expect(b.created).toEqual([{ key: MINT_KEYS['firestore-sa'], value: Buffer.from(KEY_JSON(email)).toString('base64'), project: PROD }])
    expect(removed).toEqual(['C:\\tmp\\gss-mint-abc'])
    expect(logs.at(-1)).toBe(`stored ${MINT_KEYS['firestore-sa']} (prod)`)
    printedNothingSecret(logs)
  })
  it('refuses when the bws key already exists, before touching gcloud', async () => {
    const b = fakeBws([{ key: MINT_KEYS['firestore-sa'], value: 'old-value-xyz' }])
    const g = fakeGcloud()
    const { d } = deps({ bws: b.bws, gcloud: g.gcloud })
    await expect(mintFirestoreSa(d)).rejects.toThrow(/already exists in bws prod/)
    expect(g.calls).toEqual([])
    expect(b.created).toEqual([])
  })
  it('deletes the temp dir even when bws create fails, and names the orphan key id', async () => {
    const b = fakeBws([])
    const failing: BwsRunner = async (args) => (args[1] === 'create' ? { code: 1, stdout: '', stderr: 'boom' } : b.bws(args))
    const g = fakeGcloud({ saExists: true })
    const { d, removed } = deps({ bws: failing, gcloud: g.gcloud, files: g.files })
    await expect(mintFirestoreSa(d)).rejects.toThrow(/NOT stored, revoke it: key keyid123/)
    expect(removed).toHaveLength(1)
  })
})

describe('cloud-mint: Ads SA', () => {
  it('verifies the OAuth client project from the client id, creates the SA there with no role, prints the email', async () => {
    const b = fakeBws([{ key: 'google-ads-api-rep-client-id', value: CLIENT_ID }])
    const g = fakeGcloud()
    const { d, logs } = deps({ bws: b.bws, gcloud: g.gcloud, files: g.files })
    await mintAdsSa(d)
    const email = `${ADS_SA_ID}@${EXPECTED_ADS_PROJECT}.iam.gserviceaccount.com`
    expect(g.calls.find((c) => c[0] === 'projects' && c[1] === 'describe')).toEqual(['projects', 'describe', '353430848249', '--format=json'])
    expect(g.calls.some((c) => c.join(' ').includes('add-iam-policy-binding'))).toBe(false)
    expect(b.created).toEqual([{ key: MINT_KEYS['ads-sa'], value: Buffer.from(KEY_JSON(email)).toString('base64'), project: PROD }])
    expect(logs.join('\n')).toContain(email)
    expect(logs.join('\n')).toContain('Read only')
    printedNothingSecret(logs)
  })
  it('stops when the client id points at another project or the Ads API is off', async () => {
    const b = fakeBws([{ key: 'google-ads-api-rep-client-id', value: CLIENT_ID }])
    await expect(mintAdsSa(deps({ bws: b.bws, gcloud: fakeGcloud({ projectId: 'other-proj' }).gcloud }).d)).rejects.toThrow(/belongs to other-proj/)
    await expect(mintAdsSa(deps({ bws: b.bws, gcloud: fakeGcloud({ adsEnabled: false }).gcloud }).d)).rejects.toThrow(/not enabled/)
    await expect(mintAdsSa(deps({ bws: b.bws, gcloud: fakeGcloud({ projectNumber: '1' }).gcloud }).d)).rejects.toThrow(/could not resolve/)
    expect(b.created).toEqual([])
  })
})

describe('cloud-mint: Cloudflare D1 token', () => {
  const groups = [
    { id: 'g-d1-read', name: 'D1 Read' },
    { id: 'g-d1-write', name: 'D1 Write' },
    { id: 'g-other', name: 'Workers Scripts Write' },
  ]
  function fakeCf(existing: string[] = []) {
    const calls: { url: string; method: string; auth: string; body?: string }[] = []
    const f: FetchLike = async (url, init) => {
      calls.push({ url, method: init.method, auth: init.headers.authorization, body: init.body })
      const ok = (result: unknown, extra = {}) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, result, ...extra }) })
      if (url.endsWith('/tokens/permission_groups')) return ok(groups)
      if (init.method === 'GET' && url.includes('/tokens?')) return ok(existing.map((name) => ({ name })), { result_info: { page: 1, total_pages: 1 } })
      if (init.method === 'POST') return ok({ id: 'tok-id-1', value: CF_NEW })
      return { ok: false, status: 404, text: async () => '{}' }
    }
    return { f, calls }
  }
  it('mints an account-scoped D1 Read + Write token with no expiry and stores it in prod', async () => {
    const b = fakeBws([])
    const cf = fakeCf()
    const { d, logs } = deps({ bws: b.bws, fetch: cf.f })
    await mintCfD1(d)
    const post = cf.calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/tokens`)
    expect(post.auth).toBe(`Bearer ${CF_ADMIN}`)
    const body = JSON.parse(post.body!)
    expect(body).toEqual(cfTokenBody([{ id: 'g-d1-read' }, { id: 'g-d1-write' }]))
    expect(body).not.toHaveProperty('expires_on')
    expect(body.name).toBe(CF_TOKEN_NAME)
    expect(body.policies[0].resources).toEqual({ [`com.cloudflare.api.account.${CF_ACCOUNT_ID}`]: '*' })
    expect(b.created).toEqual([{ key: MINT_KEYS['cf-d1'], value: CF_NEW, project: PROD }])
    expect(logs.at(-1)).toBe(`stored ${MINT_KEYS['cf-d1']} (prod)`)
    printedNothingSecret(logs)
  })
  it('refuses a second token with the same name, and an existing bws key', async () => {
    const cf = fakeCf([CF_TOKEN_NAME])
    await expect(mintCfD1(deps({ bws: fakeBws([]).bws, fetch: cf.f }).d)).rejects.toThrow(/already exists/)
    expect(cf.calls.some((c) => c.method === 'POST')).toBe(false)
    const cf2 = fakeCf()
    await expect(mintCfD1(deps({ bws: fakeBws([{ key: MINT_KEYS['cf-d1'], value: 'old-token-value' }]).bws, fetch: cf2.f }).d)).rejects.toThrow(/already exists in bws prod/)
    expect(cf2.calls).toEqual([])
  })
  it('picks exactly the D1 Read and D1 Write groups', () => {
    expect(pickPermissionGroups(groups).map((g) => g.id)).toEqual(['g-d1-read', 'g-d1-write'])
    expect(() => pickPermissionGroups([{ id: 'x', name: 'D1 Read' }])).toThrow(/D1 Write, found 0/)
  })
  it('a failed Cloudflare call reports the status and codes, never the body', async () => {
    const f: FetchLike = async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ success: false, errors: [{ code: 9109, message: `nope ${CF_ADMIN}` }] }) })
    const err = await mintCfD1(deps({ bws: fakeBws([]).bws, fetch: f }).d).then(() => '', (e: Error) => e.message)
    expect(err).toContain('HTTP 403 (codes 9109)')
    expect(err).not.toContain(CF_ADMIN)
  })
})

describe('gcloud argument guard', () => {
  it('refuses spaces and shell metacharacters', () => {
    expect(() => assertSafeGcloudArgs(['iam', '--project=best-sudoku-prod', 'C:\\Users\\x\\key.json'])).not.toThrow()
    for (const bad of ['a b', 'a&b', 'a|b', 'a"b', 'a>b', '%PATH%', 'a^b']) expect(() => assertSafeGcloudArgs([bad])).toThrow()
  })
})

describe('cloud-env', () => {
  const SECRETS = new Map([
    ['infra--cloud-routine-env--ADS_SA_B64', 'YWRzLXNhLWI2NC12YWx1ZQ=='],
    ['google-ads-api-rep-developer-token', 'dev-token-value-777'],
    ['infra--cloud-routine-env--FIRESTORE_SA_B64', 'ZmlyZXN0b3JlLXNhLXZhbHVl'],
    ['infra--cloud-routine-env--CLOUDFLARE_API_TOKEN', 'cf-d1-token-value-888'],
    ['BWS_ACCESS_TOKEN', 'should-never-appear-123'],
  ])
  it('builds the block in order with the constants and never BWS_ACCESS_TOKEN', () => {
    const { block, names } = buildEnvBlock(SECRETS)
    expect(names).toEqual(['ADS_SA_B64', 'ADS_DEVELOPER_TOKEN', 'FIRESTORE_SA_B64', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'WRANGLER_SEND_METRICS', 'ADS_ROUTINE_MODE'])
    expect(block).toBe(
      [
        'ADS_SA_B64=YWRzLXNhLWI2NC12YWx1ZQ==',
        'ADS_DEVELOPER_TOKEN=dev-token-value-777',
        'FIRESTORE_SA_B64=ZmlyZXN0b3JlLXNhLXZhbHVl',
        'CLOUDFLARE_API_TOKEN=cf-d1-token-value-888',
        `CLOUDFLARE_ACCOUNT_ID=${CF_ACCOUNT_ID}`,
        'WRANGLER_SEND_METRICS=false',
        'ADS_ROUTINE_MODE=SHADOW',
        '',
      ].join('\n'),
    )
    expect(block).not.toContain('BWS_ACCESS_TOKEN')
    expect(CLOUD_ENV_SPEC.some((s) => s.name === 'BWS_ACCESS_TOKEN')).toBe(false)
  })
  it('names missing bws keys only', () => {
    const partial = new Map(SECRETS)
    partial.delete('infra--cloud-routine-env--ADS_SA_B64')
    expect(() => buildEnvBlock(partial)).toThrow('bws prod is missing: infra--cloud-routine-env--ADS_SA_B64')
    const multi = new Map(SECRETS)
    multi.set('infra--cloud-routine-env--FIRESTORE_SA_B64', 'line1\nline2-secret')
    const msg = (() => {
      try {
        buildEnvBlock(multi)
        return ''
      } catch (e) {
        return (e as Error).message
      }
    })()
    expect(msg).toContain('FIRESTORE_SA_B64')
    expect(msg).not.toContain('line2-secret')
  })
  it('copies through PowerShell STDIN (never argv), prints names only, clears by hash after the wait', async () => {
    const psCalls: { script: string; stdin: string; argv: string[] }[] = []
    let clipboard = ''
    const ps: PowerShellRunner = async (script, stdin) => {
      psCalls.push({ script, stdin, argv: powershellArgs(script) })
      if (script === SET_SCRIPT) {
        clipboard = stdin
        return { code: 0, stdout: 'ok', stderr: '' }
      }
      if (sha256Hex(clipboard) === stdin) {
        clipboard = ''
        return { code: 0, stdout: 'cleared', stderr: '' }
      }
      return { code: 0, stdout: 'changed', stderr: '' }
    }
    const b = fakeBws([...SECRETS].map(([key, value]) => ({ key, value })))
    const logs: string[] = []
    await runCloudEnv({ env: { BWS_ACCESS_TOKEN: 'x' }, platform: 'win32', bws: b.bws, ps, log: (l) => void logs.push(l), waitForClear: async () => 'timer' })
    expect(psCalls.map((c) => c.script)).toEqual([SET_SCRIPT, CLEAR_SCRIPT])
    expect(psCalls[0].argv.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand'])
    const values = [...SECRETS.values()]
    for (const c of psCalls) for (const v of values) expect(c.argv.join(' ')).not.toContain(v)
    expect(psCalls[0].stdin).toBe(buildEnvBlock(SECRETS).block)
    expect(psCalls[1].stdin).toBe(sha256Hex(buildEnvBlock(SECRETS).block))
    expect(SET_SCRIPT).toContain('CanIncludeInClipboardHistory')
    expect(SET_SCRIPT).toContain('CanUploadToCloudClipboard')
    expect(SET_SCRIPT).toContain('ExcludeClipboardContentFromMonitorProcessing')
    expect(clipboard).toBe('')
    const text = logs.join('\n')
    for (const v of values) expect(text).not.toContain(v)
    expect(logs.slice(0, 7)).toEqual(['ADS_SA_B64', 'ADS_DEVELOPER_TOKEN', 'FIRESTORE_SA_B64', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'WRANGLER_SEND_METRICS', 'ADS_ROUTINE_MODE'])
    expect(text).toContain('copied 7 vars')
    expect(logs.at(-1)).toBe('clipboard cleared')
  })
  it('leaves a clipboard Mike changed alone, and refuses without BWS_ACCESS_TOKEN or off Windows', async () => {
    const ps: PowerShellRunner = async (script) => ({ code: 0, stdout: script === SET_SCRIPT ? 'ok' : 'changed', stderr: '' })
    const b = fakeBws([...SECRETS].map(([key, value]) => ({ key, value })))
    const logs: string[] = []
    await runCloudEnv({ env: { BWS_ACCESS_TOKEN: 'x' }, platform: 'win32', bws: b.bws, ps, log: (l) => void logs.push(l), waitForClear: async () => 'interrupt' })
    expect(logs.at(-1)).toBe('clipboard holds something else now; left alone')
    await expect(runCloudEnv({ env: {}, platform: 'win32', bws: b.bws, ps, log: () => {}, waitForClear: async () => 'timer' })).rejects.toThrow('BWS_ACCESS_TOKEN is not set')
    await expect(runCloudEnv({ env: { BWS_ACCESS_TOKEN: 'x' }, platform: 'linux', bws: b.bws, ps, log: () => {}, waitForClear: async () => 'timer' })).rejects.toThrow(/Windows/)
  })
})
