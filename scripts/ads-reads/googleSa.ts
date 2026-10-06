// Google service-account sign-in (OAuth 2.0 JWT bearer, RS256), shared by the Firestore counts
// (firebase.ts, scope datastore) and the Google Ads service-account path (secrets.ts, scope
// adwords). Node only (node:crypto); the runtime-agnostic Ads client in src/lib/adsApi.ts takes
// the resulting token through an AdsTokenAuth and never imports this module.
//
// The private key and the access token are registered with redact() and never printed. Errors
// carry an HTTP status only, never a response body.

import { createSign } from 'node:crypto'
import { registerSecret } from '../../src/lib/adsRedact'
import type { FetchLike } from '../../src/lib/adsApi'

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const DATASTORE_SCOPE = 'https://www.googleapis.com/auth/datastore'
export const ADWORDS_SCOPE = 'https://www.googleapis.com/auth/adwords'

export interface ServiceAccountKey {
  client_email: string
  private_key: string
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

/** The signed JWT assertion for `scope`, valid for one hour from `nowSec`. Pure, for tests. */
export function signedAssertion(sa: ServiceAccountKey, scope: string, nowSec: number): string {
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify({ iss: sa.client_email, scope, aud: GOOGLE_TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }),
  )}`
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key)
  return `${unsigned}.${b64url(sig)}`
}

/** Exchanges a signed assertion for an access token at oauth2.googleapis.com/token. */
export async function serviceAccountAccessToken(sa: ServiceAccountKey, scope: string, fetchImpl: FetchLike): Promise<string> {
  registerSecret(sa.private_key)
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedAssertion(sa, scope, Math.floor(Date.now() / 1000)) }).toString(),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`service-account token exchange failed, HTTP ${res.status}`)
  let tok: unknown
  try {
    tok = JSON.parse(body).access_token
  } catch {
    throw new Error('service-account token exchange returned a body that is not JSON')
  }
  if (typeof tok !== 'string' || !tok) throw new Error('service-account token exchange returned no access_token')
  registerSecret(tok)
  return tok
}
