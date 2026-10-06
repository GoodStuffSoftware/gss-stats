// ads:cloud-env: puts the cloud routine's .env block on the Windows clipboard for Mike to paste
// into claude.ai/code > environment gss-ads-reads > Edit environment > Environment variables.
// No arguments (PowerShell-safe):
//
//   npm run ads:cloud-env
//
// - Reads the prod secrets from Bitwarden in-process (`bws secret list`, BWS_ACCESS_TOKEN must
//   be set) and builds the block in memory. BWS_ACCESS_TOKEN itself is never in the block (it
//   would switch the CLI to the bws path, which the cloud has no binary for).
// - Copies it through `powershell -NoProfile -STA` with the block on STDIN (never argv), hidden,
//   and marks it excluded from clipboard history and cloud clipboard sync.
// - Prints variable NAMES only. Clears the clipboard after 60 s if it still holds the block
//   (compared by SHA-256, so something Mike copied since is left alone); Ctrl+C clears at once.

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { redact, redactedFirstLine, registerSecret } from '../../src/lib/adsRedact'
import { cloudEnvKey, prodProjectId, prodSecrets, runBwsBinary } from './bwsProd'
import { CF_ACCOUNT_ID } from './cloud-mint'
import { BWS_KEYS, type BwsRunner } from './secrets'

/** The block, in order: env var name -> where its value comes from. */
export const CLOUD_ENV_SPEC: readonly { name: string; bwsKey?: string; constant?: string }[] = [
  { name: 'ADS_SA_B64', bwsKey: cloudEnvKey('ADS_SA_B64') },
  { name: 'ADS_DEVELOPER_TOKEN', bwsKey: BWS_KEYS.developerToken },
  { name: 'FIRESTORE_SA_B64', bwsKey: cloudEnvKey('FIRESTORE_SA_B64') },
  { name: 'CLOUDFLARE_API_TOKEN', bwsKey: cloudEnvKey('CLOUDFLARE_API_TOKEN') },
  { name: 'CLOUDFLARE_ACCOUNT_ID', constant: CF_ACCOUNT_ID },
  { name: 'WRANGLER_SEND_METRICS', constant: 'false' },
  { name: 'ADS_ROUTINE_MODE', constant: 'SHADOW' },
]
export const CLEAR_AFTER_MS = 60_000

/** Builds the .env block from the prod secrets. Pure apart from registering every value.
 * Throws naming the missing bws KEYS (never a value). */
export function buildEnvBlock(secrets: ReadonlyMap<string, string>): { block: string; names: string[] } {
  const missing = CLOUD_ENV_SPEC.filter((s) => s.bwsKey && !secrets.get(s.bwsKey)?.trim()).map((s) => s.bwsKey!)
  if (missing.length) throw new Error(`bws prod is missing: ${missing.join(', ')}`)
  const lines = CLOUD_ENV_SPEC.map((s) => {
    const value = s.constant ?? secrets.get(s.bwsKey!)!.trim()
    if (s.bwsKey) registerSecret(value)
    if (/\s/.test(value)) throw new Error(`${s.bwsKey ?? s.name} holds whitespace or a line break; expected one line (base64 for a JSON key)`)
    return `${s.name}=${value}`
  })
  if (lines.some((l) => l.startsWith('BWS_ACCESS_TOKEN='))) throw new Error('BWS_ACCESS_TOKEN must never be in the cloud env')
  const block = lines.join('\n') + '\n'
  return { block, names: CLOUD_ENV_SPEC.map((s) => s.name) }
}

export const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

// Both scripts read their input from STDIN, so neither the block nor its hash is ever on a
// command line. The three extra formats keep the copy out of Win+V history and cloud sync.
export const SET_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::InputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$t = [Console]::In.ReadToEnd()',
  '$d = New-Object System.Windows.Forms.DataObject',
  '$d.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $t)',
  '$z = [BitConverter]::GetBytes([int32]0)',
  "$d.SetData('ExcludeClipboardContentFromMonitorProcessing', (New-Object System.IO.MemoryStream(,$z)))",
  "$d.SetData('CanIncludeInClipboardHistory', (New-Object System.IO.MemoryStream(,$z)))",
  "$d.SetData('CanUploadToCloudClipboard', (New-Object System.IO.MemoryStream(,$z)))",
  '[System.Windows.Forms.Clipboard]::SetDataObject($d, $true)',
  "'ok'",
].join('\n')

export const CLEAR_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::InputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$want = ([Console]::In.ReadToEnd()).Trim()',
  '$t = [System.Windows.Forms.Clipboard]::GetText()',
  "if (-not $t) { 'empty'; exit 0 }",
  '$t = $t -replace "`r`n", "`n"',
  '$sha = [Security.Cryptography.SHA256]::Create()',
  "$h = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($t)) | ForEach-Object { $_.ToString('x2') })",
  "if ($h -eq $want) { [System.Windows.Forms.Clipboard]::Clear(); 'cleared' } else { 'changed' }",
].join('\n')

/** powershell -NoProfile -NonInteractive -STA -EncodedCommand <script>; `stdin` is written to
 * the child's standard input. Returns the trimmed stdout. */
export type PowerShellRunner = (script: string, stdin: string) => Promise<{ code: number; stdout: string; stderr: string }>

export const powershellArgs = (script: string) => ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]

export const runPowerShell: PowerShellRunner = (script, stdin) =>
  new Promise((resolve) => {
    const child = spawn('powershell.exe', powershellArgs(script), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => (stdout += String(b)))
    child.stderr.on('data', (b) => (stderr += String(b)))
    child.on('error', (e) => resolve({ code: 1, stdout: '', stderr: e.message }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr }))
    child.stdin.end(stdin, 'utf8')
  })

export async function copyToClipboard(ps: PowerShellRunner, block: string): Promise<void> {
  const r = await ps(SET_SCRIPT, block)
  if (r.code !== 0 || r.stdout !== 'ok') throw new Error(`clipboard copy failed (exit ${r.code}): ${redactedFirstLine(r.stderr)}`)
}

export async function clearIfUnchanged(ps: PowerShellRunner, hash: string): Promise<'cleared' | 'changed' | 'empty' | 'failed'> {
  const r = await ps(CLEAR_SCRIPT, hash)
  return r.code === 0 && (r.stdout === 'cleared' || r.stdout === 'changed' || r.stdout === 'empty') ? r.stdout : 'failed'
}

export interface CloudEnvDeps {
  env: Record<string, string | undefined>
  platform: string
  bws: BwsRunner
  ps: PowerShellRunner
  log: (line: string) => void
  /** Resolves when it is time to clear: after CLEAR_AFTER_MS, or at once on Ctrl+C. */
  waitForClear: () => Promise<'timer' | 'interrupt'>
}

export async function runCloudEnv(d: CloudEnvDeps): Promise<void> {
  if (d.platform !== 'win32') throw new Error('ads:cloud-env copies to the Windows clipboard; run it on Windows')
  if (!d.env.BWS_ACCESS_TOKEN) throw new Error('BWS_ACCESS_TOKEN is not set')
  const prodId = await prodProjectId(d.bws)
  const secrets = await prodSecrets(d.bws, prodId)
  let built: { block: string; names: string[] } | null = buildEnvBlock(secrets)
  secrets.clear()
  const hash = sha256Hex(built.block)
  await copyToClipboard(d.ps, built.block)
  const names = built.names
  built = null
  for (const n of names) d.log(n)
  d.log(`copied ${names.length} vars; paste into claude.ai/code > environment gss-ads-reads > Edit environment > Environment variables`)
  d.log(`clipboard clears in ${CLEAR_AFTER_MS / 1000} s (Ctrl+C clears now)`)
  const why = await d.waitForClear()
  const r = await clearIfUnchanged(d.ps, hash)
  d.log(
    r === 'cleared'
      ? `clipboard cleared${why === 'interrupt' ? ' (Ctrl+C)' : ''}`
      : r === 'changed'
        ? 'clipboard holds something else now; left alone'
        : r === 'empty'
          ? 'clipboard already empty'
          : 'could not check the clipboard; clear it by copying something else',
  )
}

async function main() {
  if (process.argv.length > 2) {
    process.stdout.write('ads:cloud-env takes no arguments\n')
    process.exitCode = 1
    return
  }
  await runCloudEnv({
    env: process.env,
    platform: process.platform,
    bws: runBwsBinary,
    ps: runPowerShell,
    log: (line) => process.stdout.write(`${line}\n`),
    waitForClear: () =>
      new Promise((resolve) => {
        const t = setTimeout(() => resolve('timer'), CLEAR_AFTER_MS)
        process.once('SIGINT', () => {
          clearTimeout(t)
          resolve('interrupt')
        })
      }),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`error: ${redactedFirstLine(redact(e))}\n`)
    process.exit(1)
  })
}
