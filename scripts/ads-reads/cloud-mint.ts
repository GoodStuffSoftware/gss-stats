// cloud-mint: mints the cloud routine's three credentials STRAIGHT into Bitwarden (project prod).
// Agent-run, locally, after review. No arguments beyond the kind, so the npm scripts are
// PowerShell-safe:
//
//   npm run ads:mint-firestore-sa   read-only Firestore SA gss-ads-reads-ro@best-sudoku-prod
//                                   (roles/datastore.viewer) -> infra--cloud-routine-env--FIRESTORE_SA_B64
//   npm run ads:mint-ads-sa         Google Ads SA gss-ads-reads-ads in the Ads OAuth client's own
//                                   GCP project (no IAM role) -> infra--cloud-routine-env--ADS_SA_B64
//   npm run ads:mint-cf-d1          account-scoped Cloudflare token gss-ads-reads-cloud-d1,
//                                   D1 Read + D1 Write, no expiry -> infra--cloud-routine-env--CLOUDFLARE_API_TOKEN
//
// Hard rules, by construction:
// - Refuses when the bws key already exists (no overwrite, no rotate).
// - A minted value only ever lives in this process: from the minting call (a key file in a fresh
//   temp dir that is deleted in a finally block, or the Cloudflare API response) into
//   `bws secret create KEY VALUE <prod id>` through execFile. Never stdout, a log, a shell
//   variable or the repo.
// - Prints only `stored <KEY> (prod)` plus non-secret identifiers (an SA email, a project id,
//   a token name and id). Errors are redacted and never carry a response body.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exec, execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { redact, redactedFirstLine, registerSecret } from '../../src/lib/adsRedact'
import { createTimedFetch, type FetchLike } from '../../src/lib/adsApi'
import { cloudEnvKey, createProdSecret, prodProjectId, prodSecrets, runBwsBinary } from './bwsProd'
import { BWS_KEYS, type BwsRunner } from './secrets'
import { EXTERNAL_TIMEOUT_MS } from './wrangler'

export const FIRESTORE_PROJECT = 'best-sudoku-prod'
export const FIRESTORE_SA_ID = 'gss-ads-reads-ro'
export const FIRESTORE_ROLE = 'roles/datastore.viewer'
export const ADS_SA_ID = 'gss-ads-reads-ads'
/** The GCP project that owns the Google Ads OAuth client and so the developer token (a
 * developer token is tied to one Cloud project). Found 2026-10-06 as the only project on this
 * account with googleads.googleapis.com enabled; the mint re-verifies it from the client id. */
export const EXPECTED_ADS_PROJECT = 'best-sudoku-17306'
export const ADS_API_SERVICE = 'googleads.googleapis.com'
export const CF_ACCOUNT_ID = 'a32bba62c77df5e8f6bd33d04478ec34'
export const CF_TOKEN_FILE = 'C:/Users/msant/dev/cf-token.txt'
export const CF_TOKEN_NAME = 'gss-ads-reads-cloud-d1'
export const CF_PERMISSION_GROUPS = ['D1 Read', 'D1 Write'] as const
const CF_API = 'https://api.cloudflare.com/client/v4'

export const MINT_KEYS = {
  'firestore-sa': cloudEnvKey('FIRESTORE_SA_B64'),
  'ads-sa': cloudEnvKey('ADS_SA_B64'),
  'cf-d1': cloudEnvKey('CLOUDFLARE_API_TOKEN'),
} as const
export type MintKind = keyof typeof MINT_KEYS

export type ExecResult = { code: number; stdout: string; stderr: string }
export interface MintDeps {
  bws: BwsRunner
  gcloud: (args: string[]) => Promise<ExecResult>
  fetch: FetchLike
  readFile: (p: string) => string
  mkdtemp: () => string
  rmDir: (dir: string) => void
  sleep: (ms: number) => Promise<void>
  log: (line: string) => void
}

// gcloud on Windows is gcloud.cmd, which Node can only start through a shell (exec, hidden). Every argument is
// therefore checked against a strict character set (no spaces, quotes or shell metacharacters)
// before it is joined; none of them is ever a secret.
const SAFE_ARG = /^[A-Za-z0-9@._:/\\=,-]+$/
export function assertSafeGcloudArgs(args: readonly string[]): void {
  for (const a of args) if (!SAFE_ARG.test(a)) throw new Error('refusing a gcloud argument with characters outside the safe set')
}

export function runGcloud(args: string[]): Promise<ExecResult> {
  assertSafeGcloudArgs(args)
  const opts = { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 3 * EXTERNAL_TIMEOUT_MS }
  return new Promise((resolve) => {
    const done = (err: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null
      const code = e ? (e.killed ? 124 : typeof e.code === 'number' ? e.code : 1) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    }
    if (process.platform === 'win32') exec(`gcloud.cmd ${args.join(' ')}`, opts, done)
    else execFile('gcloud', args, opts, done)
  })
}

async function gcloudOk(d: MintDeps, args: string[], what: string): Promise<string> {
  const r = await d.gcloud(args)
  if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${redactedFirstLine(r.stderr)}`)
  return r.stdout
}

/** Retries a gcloud step a few times: a just-created service account takes a moment to appear. */
async function withRetry<T>(d: MintDeps, fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= tries) throw e
      await d.sleep(4_000)
    }
  }
}

async function refuseIfExists(d: MintDeps, key: string): Promise<string> {
  const projectId = await prodProjectId(d.bws)
  const existing = await prodSecrets(d.bws, projectId)
  const has = existing.has(key)
  existing.clear()
  if (has) throw new Error(`${key} already exists in bws prod; refusing to overwrite it (delete it first only if a rotation is intended)`)
  return projectId
}

const saEmail = (id: string, project: string) => `${id}@${project}.iam.gserviceaccount.com`

async function ensureServiceAccount(d: MintDeps, id: string, project: string): Promise<string> {
  const email = saEmail(id, project)
  const desc = await d.gcloud(['iam', 'service-accounts', 'describe', email, `--project=${project}`, '--format=json'])
  if (desc.code === 0) {
    d.log(`service account ${email} already exists; reusing it`)
    return email
  }
  await gcloudOk(d, ['iam', 'service-accounts', 'create', id, `--project=${project}`, `--display-name=${id}`, '--format=none'], 'gcloud iam service-accounts create')
  d.log(`created service account ${email}`)
  return email
}

/** Creates a JSON key in a fresh temp dir, reads it into memory and deletes the dir in finally.
 * Returns the key as base64 on one line; every form of it is registered with redact(). */
async function mintKeyB64(d: MintDeps, email: string, project: string): Promise<{ b64: string; keyId: string | null }> {
  const dir = d.mkdtemp()
  try {
    const file = path.join(dir, 'key.json')
    await withRetry(d, () => gcloudOk(d, ['iam', 'service-accounts', 'keys', 'create', file, `--iam-account=${email}`, `--project=${project}`, '--format=none'], 'gcloud iam service-accounts keys create'))
    const json = d.readFile(file)
    registerSecret(json)
    let sa: any
    try {
      sa = JSON.parse(json)
    } catch {
      throw new Error('the new key file is not JSON')
    }
    if (typeof sa?.private_key === 'string') registerSecret(sa.private_key)
    if (sa?.client_email !== email || typeof sa?.private_key !== 'string') throw new Error('the new key file does not belong to the expected service account')
    const b64 = Buffer.from(json, 'utf8').toString('base64')
    registerSecret(b64)
    return { b64, keyId: typeof sa.private_key_id === 'string' ? sa.private_key_id : null }
  } finally {
    d.rmDir(dir)
  }
}

async function storeOrExplain(d: MintDeps, key: string, value: string, projectId: string, orphan: string): Promise<void> {
  try {
    await createProdSecret(d.bws, key, value, projectId)
  } catch (e) {
    throw new Error(`${redact(e)}; the minted credential was NOT stored, revoke it: ${orphan}`)
  }
  d.log(`stored ${key} (prod)`)
}

export async function mintFirestoreSa(d: MintDeps): Promise<void> {
  const key = MINT_KEYS['firestore-sa']
  const projectId = await refuseIfExists(d, key)
  const email = await ensureServiceAccount(d, FIRESTORE_SA_ID, FIRESTORE_PROJECT)
  await withRetry(d, () =>
    gcloudOk(d, ['projects', 'add-iam-policy-binding', FIRESTORE_PROJECT, `--member=serviceAccount:${email}`, `--role=${FIRESTORE_ROLE}`, '--condition=None', '--format=none'], 'gcloud projects add-iam-policy-binding'),
  )
  d.log(`granted ${FIRESTORE_ROLE} on ${FIRESTORE_PROJECT} to ${email}`)
  const { b64, keyId } = await mintKeyB64(d, email, FIRESTORE_PROJECT)
  await storeOrExplain(d, key, b64, projectId, `key ${keyId ?? '(unknown id)'} of ${email}`)
}

/** Finds the GCP project that owns the Ads OAuth client: the client id's numeric prefix is the
 * project NUMBER. Verifies it resolves to EXPECTED_ADS_PROJECT and has the Ads API enabled. The
 * client id is read in memory only and never printed. */
export async function findAdsProject(d: MintDeps, prodId: string): Promise<string> {
  const secrets = await prodSecrets(d.bws, prodId)
  const clientId = secrets.get(BWS_KEYS.clientId)
  secrets.clear()
  if (!clientId) throw new Error(`bws prod has no ${BWS_KEYS.clientId}`)
  registerSecret(clientId)
  const m = /^(\d+)-[a-z0-9]+\.apps\.googleusercontent\.com$/.exec(clientId.trim())
  if (!m) throw new Error(`${BWS_KEYS.clientId} is not shaped like <project number>-<id>.apps.googleusercontent.com`)
  const number = m[1]
  const descOut = await gcloudOk(d, ['projects', 'describe', number, '--format=json'], 'gcloud projects describe (Ads OAuth client project)')
  let desc: any
  try {
    desc = JSON.parse(descOut)
  } catch {
    throw new Error('gcloud projects describe returned output that is not JSON')
  }
  const projectId = desc?.projectId
  if (typeof projectId !== 'string' || String(desc?.projectNumber) !== number) throw new Error('could not resolve the Ads OAuth client project')
  if (projectId !== EXPECTED_ADS_PROJECT) throw new Error(`the Ads OAuth client belongs to ${projectId}, not ${EXPECTED_ADS_PROJECT}; stopping for a human check`)
  const servicesOut = await gcloudOk(d, ['services', 'list', '--enabled', `--project=${projectId}`, `--filter=config.name=${ADS_API_SERVICE}`, '--format=json'], 'gcloud services list')
  let enabled: unknown
  try {
    enabled = JSON.parse(servicesOut)
  } catch {
    enabled = null
  }
  if (!Array.isArray(enabled) || enabled.length !== 1) throw new Error(`${ADS_API_SERVICE} is not enabled on ${projectId}`)
  d.log(`Ads OAuth client project: ${projectId} (verified from the client id; ${ADS_API_SERVICE} enabled)`)
  return projectId
}

export async function mintAdsSa(d: MintDeps): Promise<void> {
  const key = MINT_KEYS['ads-sa']
  const prodId = await refuseIfExists(d, key)
  const project = await findAdsProject(d, prodId)
  const email = await ensureServiceAccount(d, ADS_SA_ID, project)
  const { b64, keyId } = await mintKeyB64(d, email, project)
  await storeOrExplain(d, key, b64, prodId, `key ${keyId ?? '(unknown id)'} of ${email}`)
  d.log(`next (Mike): ads.google.com > Admin > Access and security > Users > + > ${email} > Read only > Add account`)
}

interface CfEnvelope {
  success?: boolean
  errors?: { code?: number }[]
  result?: any
  result_info?: { page?: number; total_pages?: number }
}

async function cf(d: MintDeps, token: string, method: 'GET' | 'POST', p: string, body?: unknown): Promise<CfEnvelope> {
  const res = await d.fetch(`${CF_API}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let j: CfEnvelope
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error(`Cloudflare ${method} ${p.split('?')[0]} returned HTTP ${res.status} with a body that is not JSON`)
  }
  if (!res.ok || j.success === false) {
    const codes = (j.errors ?? []).map((e) => e.code).filter((c) => typeof c === 'number')
    throw new Error(`Cloudflare ${method} ${p.split('?')[0]} failed, HTTP ${res.status}${codes.length ? ` (codes ${codes.join(', ')})` : ''}`)
  }
  return j
}

/** The permission-group ids for exactly 'D1 Read' and 'D1 Write'. */
export function pickPermissionGroups(groups: unknown): { id: string; name: string }[] {
  const list = Array.isArray(groups) ? groups : []
  return CF_PERMISSION_GROUPS.map((name) => {
    const hits = list.filter((g: any) => g && g.name === name && typeof g.id === 'string')
    if (hits.length !== 1) throw new Error(`expected one Cloudflare permission group named ${name}, found ${hits.length}`)
    return { id: hits[0].id, name }
  })
}

/** The create body: account-scoped, D1 Read + D1 Write, and deliberately no expires_on. */
export function cfTokenBody(groups: { id: string }[]): unknown {
  return {
    name: CF_TOKEN_NAME,
    policies: [{ effect: 'allow', resources: { [`com.cloudflare.api.account.${CF_ACCOUNT_ID}`]: '*' }, permission_groups: groups.map((g) => ({ id: g.id })) }],
  }
}

export async function mintCfD1(d: MintDeps): Promise<void> {
  const key = MINT_KEYS['cf-d1']
  const prodId = await refuseIfExists(d, key)
  let admin: string | null = d.readFile(CF_TOKEN_FILE).trim()
  if (!admin) throw new Error('the Cloudflare admin token file is empty')
  registerSecret(admin)
  try {
    const acct = `/accounts/${CF_ACCOUNT_ID}`
    const groups = pickPermissionGroups((await cf(d, admin, 'GET', `${acct}/tokens/permission_groups`)).result)
    for (let page = 1; page <= 20; page++) {
      const r = await cf(d, admin, 'GET', `${acct}/tokens?per_page=50&page=${page}`)
      if ((r.result ?? []).some((t: any) => t?.name === CF_TOKEN_NAME)) throw new Error(`a Cloudflare token named ${CF_TOKEN_NAME} already exists; refusing to mint a second one`)
      if (!r.result_info?.total_pages || page >= r.result_info.total_pages) break
    }
    const created = (await cf(d, admin, 'POST', `${acct}/tokens`, cfTokenBody(groups))).result
    const value = created?.value
    const id = typeof created?.id === 'string' ? created.id : '(unknown id)'
    if (typeof value !== 'string' || !value) throw new Error(`Cloudflare created token ${id} but returned no value; revoke it`)
    registerSecret(value)
    d.log(`created Cloudflare token ${CF_TOKEN_NAME} (id ${id}): ${CF_PERMISSION_GROUPS.join(' + ')}, account-scoped, no expiry`)
    await storeOrExplain(d, key, value, prodId, `Cloudflare token ${CF_TOKEN_NAME} (id ${id})`)
  } finally {
    admin = null
  }
}

export const MINTERS: Record<MintKind, (d: MintDeps) => Promise<void>> = {
  'firestore-sa': mintFirestoreSa,
  'ads-sa': mintAdsSa,
  'cf-d1': mintCfD1,
}

export function liveMintDeps(): MintDeps {
  return {
    bws: runBwsBinary,
    gcloud: runGcloud,
    fetch: createTimedFetch(EXTERNAL_TIMEOUT_MS),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    mkdtemp: () => fs.mkdtempSync(path.join(os.tmpdir(), 'gss-mint-')),
    rmDir: (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => process.stdout.write(`${line}\n`),
  }
}

async function main() {
  const kind = process.argv[2] as MintKind
  if (!(kind in MINTERS) || process.argv.length !== 3) {
    process.stdout.write(`cloud-mint <${Object.keys(MINTERS).join('|')}> (use the npm scripts ads:mint-firestore-sa, ads:mint-ads-sa, ads:mint-cf-d1)\n`)
    process.exitCode = 1
    return
  }
  if (!process.env.BWS_ACCESS_TOKEN) throw new Error('BWS_ACCESS_TOKEN is not set (the key goes straight into Bitwarden)')
  await MINTERS[kind](liveMintDeps())
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`error: ${redactedFirstLine(redact(e))}\n`)
    process.exit(1)
  })
}
