import { describe, expect, it } from 'vitest'
import {
  TokenCryptoError,
  decryptToken,
  encryptToken,
  keyFingerprint,
  type EncryptedToken,
} from '../src/tokenCrypto'

// Keys are generated at run time: no key-like literal lives in the repo.
function makeKey(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  let bin = ''
  for (const b of raw) bin += String.fromCharCode(b)
  return btoa(bin)
}

const CONN = 'c0123456789abcdef'
const OTHER_CONN = 'cfedcba9876543210'
const makePlain = () => 'rt-' + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(TokenCryptoError)
    return (e as TokenCryptoError).code
  }
  return 'no_error'
}

describe('tokenCrypto', () => {
  it('round-trips and fits the schema checks', async () => {
    const key = makeKey()
    const plain = makePlain()
    const enc = await encryptToken(plain, CONN, key)
    expect(enc.token_iv).toHaveLength(16)
    expect(enc.key_id).toMatch(/^[0-9a-f]{8}$/)
    expect(enc.token_ct.length).toBeLessThanOrEqual(2048)
    expect(enc.key_id).toBe(await keyFingerprint(key))
    expect(enc.token_ct).not.toContain(plain)
    const out = await decryptToken(enc, CONN, { current: key })
    expect(out).toEqual({ plaintext: plain, usedOldKey: false })
  })

  it('fails for a different connection id', async () => {
    const key = makeKey()
    const enc = await encryptToken(makePlain(), CONN, key)
    expect(await codeOf(decryptToken(enc, OTHER_CONN, { current: key }))).toBe('decrypt_failed')
  })

  it('fails on tampered ciphertext and tampered IV', async () => {
    const key = makeKey()
    const enc = await encryptToken(makePlain(), CONN, key)
    const raw = Uint8Array.from(atob(enc.token_ct), (c) => c.charCodeAt(0))
    raw[0] ^= 1
    const bad: EncryptedToken = { ...enc, token_ct: btoa(String.fromCharCode(...raw)) }
    expect(await codeOf(decryptToken(bad, CONN, { current: key }))).toBe('decrypt_failed')
    const ivRaw = Uint8Array.from(atob(enc.token_iv), (c) => c.charCodeAt(0))
    ivRaw[0] ^= 1
    const badIv: EncryptedToken = { ...enc, token_iv: btoa(String.fromCharCode(...ivRaw)) }
    expect(await codeOf(decryptToken(badIv, CONN, { current: key }))).toBe('decrypt_failed')
    expect(await codeOf(decryptToken({ ...enc, token_ct: '!!notbase64' }, CONN, { current: key }))).toBe('decrypt_failed')
  })

  it('decrypts with the old key and flags it; the current key is not flagged', async () => {
    const oldKey = makeKey()
    const newKey = makeKey()
    const plain = makePlain()
    const enc = await encryptToken(plain, CONN, oldKey)
    const out = await decryptToken(enc, CONN, { current: newKey, old: oldKey })
    expect(out).toEqual({ plaintext: plain, usedOldKey: true })
    // After re-encrypting with the new key, the old key is no longer needed.
    const re = await encryptToken(out.plaintext, CONN, newKey)
    expect(re.key_id).toBe(await keyFingerprint(newKey))
    expect(await decryptToken(re, CONN, { current: newKey, old: oldKey })).toEqual({ plaintext: plain, usedOldKey: false })
    // Without the old key configured, the old row cannot be read.
    expect(await codeOf(decryptToken(enc, CONN, { current: newKey }))).toBe('decrypt_failed')
  })

  it('rejects keys of the wrong length or format', async () => {
    for (const bad of [makeKey(16), makeKey(31), makeKey(33), makeKey(64), '', 'not base64 !!']) {
      expect(await codeOf(encryptToken('x', CONN, bad))).toBe('key_invalid')
    }
    const good = makeKey()
    const enc = await encryptToken('x', CONN, good)
    expect(await codeOf(decryptToken(enc, CONN, { current: makeKey(16) }))).toBe('key_invalid')
    expect(await codeOf(decryptToken(enc, CONN, { current: good, old: makeKey(8) }))).toBe('key_invalid')
  })

  it('uses a fresh IV, so two encryptions of the same text differ', async () => {
    const key = makeKey()
    const plain = makePlain()
    const a = await encryptToken(plain, CONN, key)
    const b = await encryptToken(plain, CONN, key)
    expect(a.token_iv).not.toBe(b.token_iv)
    expect(a.token_ct).not.toBe(b.token_ct)
    expect(a.key_id).toBe(b.key_id)
  })

  it('never puts plaintext or key material in an error message', async () => {
    const key = makeKey()
    const plain = makePlain()
    const enc = await encryptToken(plain, CONN, key)
    const wrong = makeKey()
    const errors: unknown[] = []
    for (const p of [
      () => decryptToken(enc, OTHER_CONN, { current: key }),
      () => decryptToken(enc, CONN, { current: wrong }),
      () => decryptToken({ ...enc, token_ct: enc.token_ct.slice(0, -4) }, CONN, { current: key }),
      () => encryptToken(plain, CONN, makeKey(16)),
    ]) {
      try {
        await p()
      } catch (e) {
        errors.push(e)
      }
    }
    expect(errors).toHaveLength(4)
    for (const e of errors) {
      const text = String((e as Error).message) + String((e as Error).stack ?? '')
      expect(text).not.toContain(plain)
      expect(text).not.toContain(key)
      expect(text).not.toContain(wrong)
      expect((e as Error).message).toMatch(/^[a-z_]+$/)
    }
  })

  it('rejects empty input and an oversize token', async () => {
    const key = makeKey()
    expect(await codeOf(encryptToken('', CONN, key))).toBe('input_invalid')
    expect(await codeOf(encryptToken('x', '', key))).toBe('input_invalid')
    expect(await codeOf(encryptToken('a'.repeat(2000), CONN, key))).toBe('token_too_long')
  })
})
