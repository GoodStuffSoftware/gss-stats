// The bws token fallback: BWS_ACCESS_TOKEN first, else the file (BWS_TOKEN_FILE or ~/.bws-token).
// Made-up token values and a temp file only; no bws binary runs.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearRegisteredSecrets, redact } from '../../src/lib/adsRedact'
import { bwsChildEnv, findBwsToken, resolveBwsToken } from './bwsToken'
import { BWS_KEYS, loadAdsCredentials, type BwsRunner } from './secrets'

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bws-token-test-'))
  file = path.join(dir, 'token')
})
afterEach(() => {
  clearRegisteredSecrets()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('bws token resolution', () => {
  it('env wins over the file, and is trimmed', () => {
    fs.writeFileSync(file, 'file-token-aaaa\n')
    expect(resolveBwsToken({ BWS_ACCESS_TOKEN: '  env-token-bbbb ', BWS_TOKEN_FILE: file })).toBe('env-token-bbbb')
  })
  it('reads the file (trimmed) when env is unset or empty, and registers it for redaction', () => {
    fs.writeFileSync(file, '  file-token-cccc\r\n')
    expect(resolveBwsToken({ BWS_TOKEN_FILE: file })).toBe('file-token-cccc')
    expect(resolveBwsToken({ BWS_ACCESS_TOKEN: '', BWS_TOKEN_FILE: file })).toBe('file-token-cccc')
    expect(redact('x file-token-cccc y')).toBe('x <redacted> y')
  })
  it('throws a clear error naming both sources, and no value, when both are missing', () => {
    expect(() => resolveBwsToken({ BWS_TOKEN_FILE: file })).toThrow(/BWS_ACCESS_TOKEN is not set.*token file .*missing/)
    fs.writeFileSync(file, '  \n')
    expect(() => resolveBwsToken({ BWS_TOKEN_FILE: file })).toThrow(/No bws access token/)
    expect(findBwsToken({ BWS_TOKEN_FILE: file })).toBe('')
  })
  it('useFile:false ignores the file', () => {
    fs.writeFileSync(file, 'file-token-dddd')
    expect(findBwsToken({ BWS_TOKEN_FILE: file }, { useFile: false })).toBe('')
  })
  it('the bws child gets the token in its env only, not this process env', () => {
    expect(bwsChildEnv('child-token-eeee', { PATH: 'p' })).toEqual({ PATH: 'p', BWS_ACCESS_TOKEN: 'child-token-eeee' })
    expect(process.env.BWS_ACCESS_TOKEN).not.toBe('child-token-eeee')
  })
  it('loadAdsCredentials takes the bws path from the file token when env has none', async () => {
    fs.writeFileSync(file, 'file-token-ffff\n')
    let called = 0
    const runBws: BwsRunner = async () => {
      called++
      return { code: 0, stdout: JSON.stringify(Object.values(BWS_KEYS).map((key) => ({ key, value: `v-${key}` }))), stderr: '' }
    }
    const creds = await loadAdsCredentials({ env: { BWS_TOKEN_FILE: file }, runBws })
    expect(called).toBe(1)
    expect(creds.clientId).toBe(`v-${BWS_KEYS.clientId}`)
  })
  it('loadAdsCredentials with no token anywhere falls to the env set (no bws run)', async () => {
    const runBws: BwsRunner = async () => {
      throw new Error('bws must not run')
    }
    await expect(loadAdsCredentials({ env: { BWS_TOKEN_FILE: file }, runBws })).rejects.toThrow(/BWS_ACCESS_TOKEN or the token file/)
  })
})
