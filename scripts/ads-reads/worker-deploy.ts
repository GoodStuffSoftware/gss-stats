// ads:worker-deploy — deploy the gss-stats-sync Worker (workers/sync/) stamped with the git
// commit it was built from, so a Worker running an older src/lib/campaigns.ts cannot drift
// silently: the SHA becomes the version tag and message, the GIT_SHA var the Worker reports in
// every sync-run row and response (with a hash of the campaign definitions, which the dashboard
// compares with its own — src/lib/adsRefresh.ts workerConfigDrift).
//
//   npm run ads:worker-deploy -- --cf-token-file <path> [--paused] [--dry-run] [--allow-dirty]
//
// --paused deploys with NO cron trigger (the schedules are set to []), e.g. while the cron is
// held for a review; a normal deploy attaches the cron in workers/sync/wrangler.toml.
// Refuses a dirty working tree unless --allow-dirty (the SHA would not describe the code).

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { campaignsConfigHash } from '../../src/lib/adsSync'
import { fail, loadCfToken } from './cli'
import { repoRoot } from './wrangler'

async function main() {
  const { values: opts } = parseArgs({
    options: { 'cf-token-file': { type: 'string' }, paused: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false }, 'allow-dirty': { type: 'boolean', default: false } },
    strict: true,
  })
  const root = repoRoot()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const sha = git('rev-parse', 'HEAD')
  if (git('status', '--porcelain') && !opts['allow-dirty']) throw new Error('working tree has local changes: commit them (or pass --allow-dirty) so the deployed SHA describes the code')
  const token = loadCfToken(opts['cf-token-file'])
  let config = path.join(root, 'workers', 'sync', 'wrangler.toml')
  let tmp: string | null = null
  if (opts.paused) {
    const src = fs.readFileSync(config, 'utf8')
    const main = path.join(root, 'workers', 'sync', 'src', 'index.ts').replace(/\\/g, '/')
    const paused = src.replace(/^main = .*$/m, `main = "${main}"`).replace(/^crons = \[.*\]$/m, 'crons = []')
    if (!/^crons = \[\]$/m.test(paused)) throw new Error('could not find the crons line in workers/sync/wrangler.toml')
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gss-stats-sync-'))
    config = path.join(tmp, 'wrangler.toml')
    fs.writeFileSync(config, paused)
  }
  const hash = campaignsConfigHash()
  const args = [path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'deploy', '-c', config, '--var', `GIT_SHA:${sha}`, '--tag', sha.slice(0, 12), '--message', `gss-stats-sync ${sha.slice(0, 12)} campaigns ${hash}${opts.paused ? ' (paused: no cron)' : ''}`]
  if (opts['dry-run']) args.push('--dry-run')
  const r = spawnSync(process.execPath, args, { cwd: root, env: { ...process.env, ...(token ? { CLOUDFLARE_API_TOKEN: token } : {}), WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }, encoding: 'utf8' })
  const scrub = (s: string) => (token ? s.split(token).join('<redacted>') : s)
  process.stdout.write(scrub(r.stdout ?? ''))
  process.stderr.write(scrub(r.stderr ?? ''))
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  process.stdout.write(`\ngss-stats-sync ${opts['dry-run'] ? 'dry run' : 'deploy'}: sha ${sha}, campaigns hash ${hash}, cron ${opts.paused ? 'NONE (paused)' : 'as in workers/sync/wrangler.toml'}\n`)
  if (r.status !== 0) process.exitCode = r.status ?? 1
}

main().catch(fail)
