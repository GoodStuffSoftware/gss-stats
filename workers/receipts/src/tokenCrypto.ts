// AES-256-GCM encryption for the stored Gmail refresh token (WebCrypto only: runs in Workers and Pages).
// Plan: email-receipts section 9. AAD = connection id, so a ciphertext moved to another row fails to decrypt.
// Errors are fixed codes only: never a token, key or plaintext.

/** Fields stored on email_connections (token_ct, token_iv, key_id). */
export interface EncryptedToken {
  /** base64 of ciphertext + 16-byte GCM tag (schema: <= 2048 chars). */
  token_ct: string
  /** base64 of the 12-byte IV (16 chars). */
  token_iv: string
  /** First 8 hex chars of sha256(raw key bytes). */
  key_id: string
}

export interface TokenKeys {
  /** RECEIPTS_TOKEN_KEY: base64 of 32 bytes. */
  current: string
  /** RECEIPTS_TOKEN_KEY_OLD: optional, rotation only. */
  old?: string | null
}

export type TokenCryptoCode =
  | 'key_invalid'
  | 'input_invalid'
  | 'token_too_long'
  | 'decrypt_failed'

export class TokenCryptoError extends Error {
  readonly code: TokenCryptoCode
  constructor(code: TokenCryptoCode) {
    super(code)
    this.name = 'TokenCryptoError'
    this.code = code
  }
}

const KEY_BYTES = 32
const IV_BYTES = 12
const MAX_CT_CHARS = 2048
const B64 = /^[A-Za-z0-9+/]+={0,2}$/

function fromB64(s: string, code: TokenCryptoCode): Uint8Array<ArrayBuffer> {
  if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0 || !B64.test(s)) {
    throw new TokenCryptoError(code)
  }
  try {
    const bin = atob(s)
    const out = new Uint8Array(new ArrayBuffer(bin.length))
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    throw new TokenCryptoError(code)
  }
}

function toB64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

interface LoadedKey {
  key: CryptoKey
  keyId: string
}

async function loadKey(b64: string): Promise<LoadedKey> {
  const raw = fromB64(b64, 'key_invalid')
  if (raw.length !== KEY_BYTES) throw new TokenCryptoError('key_invalid')
  const digest = await crypto.subtle.digest('SHA-256', raw)
  const keyId = toHex(new Uint8Array(digest)).slice(0, 8)
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  return { key, keyId }
}

/** The key_id (first 8 hex of sha256) for a base64 key. Throws key_invalid on a wrong length. */
export async function keyFingerprint(keyB64: string): Promise<string> {
  return (await loadKey(keyB64)).keyId
}

/** Encrypt a refresh token for one connection with the current key. Fresh random IV every call. */
export async function encryptToken(
  plaintext: string,
  connectionId: string,
  currentKeyB64: string,
): Promise<EncryptedToken> {
  if (typeof plaintext !== 'string' || plaintext.length === 0) throw new TokenCryptoError('input_invalid')
  if (typeof connectionId !== 'string' || connectionId.length === 0) throw new TokenCryptoError('input_invalid')
  const { key, keyId } = await loadKey(currentKeyB64)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(connectionId) },
    key,
    new TextEncoder().encode(plaintext),
  )
  const token_ct = toB64(new Uint8Array(ct))
  if (token_ct.length > MAX_CT_CHARS) throw new TokenCryptoError('token_too_long')
  return { token_ct, token_iv: toB64(iv), key_id: keyId }
}

export interface DecryptResult {
  plaintext: string
  /** True when the old key decrypted it: the caller should re-encrypt with the current key and store. */
  usedOldKey: boolean
}

/**
 * Decrypt a stored token. Uses the key whose fingerprint matches the row's key_id first (current, then old);
 * if key_id matches neither, both are still tried. Throws decrypt_failed for any wrong key, wrong connection
 * id, or tampered data.
 */
export async function decryptToken(
  row: EncryptedToken,
  connectionId: string,
  keys: TokenKeys,
): Promise<DecryptResult> {
  if (typeof connectionId !== 'string' || connectionId.length === 0) throw new TokenCryptoError('input_invalid')
  const ct = fromB64(row.token_ct, 'decrypt_failed')
  const iv = fromB64(row.token_iv, 'decrypt_failed')
  if (iv.length !== IV_BYTES) throw new TokenCryptoError('decrypt_failed')

  // The current key is tried first and must be valid (an invalid current key is a configuration fault: key_invalid).
  // The old key is loaded lazily, only when the current key fails; an invalid old key (for example a placeholder
  // secret) counts as absent, so it can never break runs or revokes that the current key can serve.
  const current = await loadKey(keys.current)
  const aad = new TextEncoder().encode(connectionId)
  const attempt = async (k: LoadedKey, old: boolean): Promise<DecryptResult | null> => {
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, k.key, ct)
      return { plaintext: new TextDecoder().decode(pt), usedOldKey: old }
    } catch {
      return null
    }
  }
  const first = await attempt(current, false)
  if (first) return first
  if (keys.old) {
    let oldKey: LoadedKey | null = null
    try {
      oldKey = await loadKey(keys.old)
    } catch {
      oldKey = null
    }
    if (oldKey) {
      const second = await attempt(oldKey, true)
      if (second) return second
    }
  }
  throw new TokenCryptoError('decrypt_failed')
}

/** Re-encrypt a token that was decrypted with the old key. Returns the new row fields. */
export async function reencryptToken(
  plaintext: string,
  connectionId: string,
  currentKeyB64: string,
): Promise<EncryptedToken> {
  return encryptToken(plaintext, connectionId, currentKeyB64)
}
