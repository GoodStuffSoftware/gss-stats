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
// - A minted value only ever lives in this process: from the minting call (the IAM REST API's
//   keys.create response, whose privateKeyData is already the base64 JSON key, or the
//   Cloudflare API response) into `bws secret create -- KEY VALUE <prod id>` through execFile.
//   Never disk, stdout, a log, a shell variable or the repo. If the bws store fails after a
//   service-account key was created, that key is deleted again through the API (keys.delete).
// - A reused service account is refused if it holds any project role beyond the expected one.
// - Residual risk (accepted): bws 2.1.0 has no stdin form, so the value is on bws.exe's command
//   line while that call runs, readable by processes of the same user.
// - Prints only `stored <KEY> (prod)` plus non-secret identifiers (an SA email, a project id,
//   a token name and id). Errors are redacted and never carry a response body.

import fs from 'node:fs'
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

async function retryWait(d: MintDeps, i: number, tries: number): Promise<boolean> {
  if (i >= tries) return false
  await d.sleep(4_000)
  return true
}

/** Retries a gcloud step a few times: a just-created service account takes a moment to appear. */
async function withRetry<T>(d: MintDeps, fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (!(await retryWait(d, i, tries))) throw e
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
  if (!/NOT_FOUND|does not exist|not found/i.test(desc.stderr)) throw new Error(`gcloud iam service-accounts describe failed (exit ${desc.code}): ${redactedFirstLine(desc.stderr)}`)
  await gcloudOk(d, ['iam', 'service-accounts', 'create', id, `--project=${project}`, `--display-name=${id}`, '--format=none'], 'gcloud iam service-accounts create')
  d.log(`created service account ${email}`)
  return email
}

/** The project roles a service account holds (from the project IAM policy), sorted. */
export async function projectRolesOf(d: MintDeps, project: string, email: string): Promise<string[]> {
  const out = await gcloudOk(d, ['projects', 'get-iam-policy', project, '--format=json'], 'gcloud projects get-iam-policy')
  let policy: any
  try {
    policy = JSON.parse(out)
  } catch {
    throw new Error('gcloud projects get-iam-policy returned output that is not JSON')
  }
  const member = `serviceAccount:${email}`
  const roles: string[] = (Array.isArray(policy?.bindings) ? policy.bindings : [])
    .filter((b: any) => Array.isArray(b?.members) && b.members.includes(member))
    .map((b: any) => String(b.role))
  return [...new Set(roles)].sort()
}

/** Refuses unless every project role the SA holds is in `allowed` (none allowed = no role). */
export async function assertOnlyRoles(d: MintDeps, project: string, email: string, allowed: readonly string[]): Promise<void> {
  const extra = (await projectRolesOf(d, project, email)).filter((r) => !allowed.includes(r))
  if (extra.length) throw new Error(`${email} holds roles beyond ${allowed.length ? allowed.join(', ') : 'none'} on ${project}: ${extra.join(', ')}; refusing to mint a key for it`)
}

export const IAM_API = 'https://iam.googleapis.com/v1'

/** The caller's gcloud access token, captured in-process and registered; never printed. */
async function gcloudAccessToken(d: MintDeps): Promise<string> {
  const tok = (await gcloudOk(d, ['auth', 'print-access-token'], 'gcloud auth print-access-token')).trim()
  if (!tok) throw new Error('gcloud auth print-access-token returned nothing')
  registerSecret(tok)
  return tok
}

async function iamCall(d: MintDeps, token: string, method: 'POST' | 'DELETE', url: string, body?: unknown): Promise<{ status: number; ok: boolean; json: any }> {
  const res = await d.fetch(url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, ok: res.ok, json }
}

export interface MintedKey {
  b64: string
  keyId: string
  /** The key's resource name, for keys.delete. */
  name: string
}

/** Creates a JSON key through the IAM REST API (projects.serviceAccounts.keys.create). Nothing
 * touches disk: privateKeyData is already the base64 JSON key file, the *_SA_B64 format. Every
 * form of it is registered with redact() at once. Only a 404 (a just-created SA not visible
 * yet) is retried, so a retry never mints a second key behind a failure that made one. */
export async function createKeyViaApi(d: MintDeps, token: string, email: string, project: string): Promise<MintedKey> {
  const url = `${IAM_API}/projects/${encodeURIComponent(project)}/serviceAccounts/${encodeURIComponent(email)}/keys`
  let r: { status: number; ok: boolean; json: any }
  for (let i = 1; ; i++) {
    r = await iamCall(d, token, 'POST', url, { privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE', keyAlgorithm: 'KEY_ALG_RSA_2048' })
    if (r.ok || r.status !== 404 || !(await retryWait(d, i, 5))) break
  }
  const b64 = typeof r.json?.privateKeyData === 'string' ? r.json.privateKeyData.trim() : ''
  if (b64) registerSecret(b64)
  const name = typeof r.json?.name === 'string' ? r.json.name : ''
  const keyId = name.split('/').pop() || '(unknown id)'
  if (!r.ok) throw new Error(`IAM keys.create for ${email} failed, HTTP ${r.status}`)
  if (!b64 || !name) {
    if (name) await deleteKeyViaApi(d, token, name)
    throw new Error(`IAM keys.create for ${email} returned no key data${name ? `; deleted key ${keyId}` : ''}`)
  }
  const json = Buffer.from(b64, 'base64').toString('utf8')
  registerSecret(json)
  let sa: any = null
  try {
    sa = JSON.parse(json)
  } catch {
    sa = null
  }
  if (typeof sa?.private_key === 'string') registerSecret(sa.private_key)
  if (sa?.client_email !== email || typeof sa?.private_key !== 'string') {
    const deleted = await deleteKeyViaApi(d, token, name)
    throw new Error(`IAM keys.create returned a key that does not belong to ${email}; ${deleted ? 'deleted' : 'could NOT delete'} key ${keyId}`)
  }
  return { b64, keyId, name }
}

export async function deleteKeyViaApi(d: MintDeps, token: string, name: string): Promise<boolean> {
  try {
    return (await iamCall(d, token, 'DELETE', `${IAM_API}/${name.split('/').map(encodeURIComponent).join('/')}`)).ok
  } catch {
    return false
  }
}

/** Mints a key via the API and stores it; on a failed store, deletes the key again and says so
 * by key id only. */
async function mintAndStoreKey(d: MintDeps, key: string, email: string, project: string, prodId: string): Promise<void> {
  const token = await gcloudAccessToken(d)
  const k = await createKeyViaApi(d, token, email, project)
  d.log(`created key ${k.keyId} for ${email}`)
  try {
    await createProdSecret(d.bws, key, k.b64, prodId)
  } catch (e) {
    const deleted = await deleteKeyViaApi(d, token, k.name)
    throw new Error(`${redact(e)}; ${deleted ? `deleted key ${k.keyId} of ${email} again` : `could NOT delete key ${k.keyId} of ${email}: delete it by hand`}`)
  }
  d.log(`stored ${key} (prod)`)
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
  await assertOnlyRoles(d, FIRESTORE_PROJECT, email, [FIRESTORE_ROLE])
  await withRetry(d, () =>
    gcloudOk(d, ['projects', 'add-iam-policy-binding', FIRESTORE_PROJECT, `--member=serviceAccount:${email}`, `--role=${FIRESTORE_ROLE}`, '--condition=None', '--format=none'], 'gcloud projects add-iam-policy-binding'),
  )
  d.log(`granted ${FIRESTORE_ROLE} on ${FIRESTORE_PROJECT} to ${email}`)
  await assertOnlyRoles(d, FIRESTORE_PROJECT, email, [FIRESTORE_ROLE])
  await mintAndStoreKey(d, key, email, FIRESTORE_PROJECT, projectId)
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
  await assertOnlyRoles(d, project, email, [])
  await mintAndStoreKey(d, key, email, project, prodId)
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
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => process.stdout.write(`${line}\n`),
  }
}

async function main() {
  const kind = process.argv[2] as MintKind
  if (!Object.hasOwn(MINTERS, kind) || process.argv.length !== 3) {
    process.stdout.write(`cloud-mint <${Object.keys(MINTERS).join('|')}> (use the npm scripts ads:mint-firestore-sa, ads:mint-ads-sa, ads:mint-cf-d1)\n`)
    process.exitCode = 1
    return
  }
  if (!process.env.BWS_ACCESS_TOKEN) throw new Error('BWS_ACCESS_TOKEN is not set (the key goes straight into Bitwarden)')
  registerSecret(process.env.BWS_ACCESS_TOKEN)
  await MINTERS[kind](liveMintDeps())
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`error: ${redactedFirstLine(redact(e))}\n`)
    process.exit(1)
  })
}
