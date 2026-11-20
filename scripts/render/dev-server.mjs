// The one sanctioned way to run a local dev server (wrangler pages dev) from an agent session.
// No shell, no npx, no cmd: it spawns node on wrangler's own entry file, hidden, so no
// console window can open on the desktop. Usage:
//   node scripts/render/dev-server.mjs start --port 8795
//   node scripts/render/dev-server.mjs stop --port 8795
//   node scripts/render/dev-server.mjs status
import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WRANGLER_BIN = join('node_modules', 'wrangler', 'bin', 'wrangler.js')

/** Pure: the command, args and options for the hidden wrangler spawn. Throws on --remote or a bad port. */
export function buildSpawn({ port, extraArgs = [], root = ROOT, logFd = 'ignore', execPath = process.execPath }) {
  if (extraArgs.some((a) => a === '--remote' || a.startsWith('--remote='))) {
    throw new Error('--remote is refused: dev servers use local simulated bindings only')
  }
  const p = Number(port)
  if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error(`bad --port: ${port}`)
  return {
    command: execPath,
    args: [join(root, WRANGLER_BIN), 'pages', 'dev', '--port', String(p), '--ip', 'localhost'],
    // Not detached: windowsHide gives wrangler's tree one hidden console (CREATE_NO_WINDOW) that its children
    // (cli.js, workerd) inherit. A detached spawn has no console, so each child opens a visible one.
    options: { cwd: root, detached: false, windowsHide: true, shell: false, stdio: ['ignore', logFd, logFd] },
  }
}

/** Pure: the detached runner that owns the wrangler tree, so it outlives the launcher and the calling tool. */
export function buildRunnerSpawn({ port, extraArgs = [], execPath = process.execPath, root = ROOT }) {
  buildSpawn({ port, extraArgs, root, execPath }) // same refusals
  return {
    command: execPath,
    args: [fileURLToPath(import.meta.url), 'run', '--port', String(port)],
    options: { cwd: root, detached: true, windowsHide: true, shell: false, stdio: 'ignore' },
  }
}

const runDir = (root) => join(root, '.wrangler', 'dev-server')
const pidFile = (root, port) => join(runDir(root), `${port}.pid`)

const logFile = (port) => join(ROOT, '.wrangler', `dev-server-${port}.log`)

// Runs inside the detached runner: spawn wrangler hidden, log its output, exit when it exits.
function run(port) {
  const { command, args, options } = buildSpawn({ port, logFd: openSync(logFile(port), 'a') })
  const child = spawn(command, args, options)
  child.on('exit', (code) => process.exit(code ?? 1))
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv
  const out = { cmd, port: undefined, extra: [] }
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--port') out.port = rest[++i]
    else out.extra.push(rest[i])
  }
  return out
}

function answers(port) {
  return new Promise((res) => {
    const req = http.get({ host: 'localhost', port, path: '/', timeout: 1500 }, (r) => { r.resume(); res(true) })
    req.on('error', () => res(false))
    req.on('timeout', () => { req.destroy(); res(false) })
  })
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function start(port, extra) {
  mkdirSync(runDir(ROOT), { recursive: true })
  const pf = pidFile(ROOT, port)
  if (existsSync(pf) && alive(Number(readFileSync(pf, 'utf8')))) throw new Error(`port ${port} already has a server (pid ${readFileSync(pf, 'utf8')})`)
  if (await answers(port)) throw new Error(`port ${port} is already answering; pick another`)
  const log = logFile(port)
  const { command, args, options } = buildRunnerSpawn({ port, extraArgs: extra })
  const child = spawn(command, args, options)
  child.unref()
  writeFileSync(pf, String(child.pid))
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    if (!alive(child.pid)) throw new Error(`wrangler exited early; see ${log}`)
    if (await answers(port)) { console.log(`http://localhost:${port}/ (pid ${child.pid}, log ${log})`); return }
    await new Promise((r) => setTimeout(r, 500))
  }
  await stop(port)
  throw new Error(`timed out waiting for port ${port}; see ${log}`)
}

function stop(port) {
  const pf = pidFile(ROOT, port)
  if (!existsSync(pf)) { console.log(`no pid file for port ${port}`); return Promise.resolve() }
  const pid = Number(readFileSync(pf, 'utf8'))
  return new Promise((res) => {
    const done = () => { rmSync(pf, { force: true }); console.log(`stopped port ${port} (pid ${pid})`); res() }
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, done)
    else { try { process.kill(-pid) } catch { /* already gone */ } done() }
  })
}

function status() {
  const dir = runDir(ROOT)
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.pid')) : []
  if (!files.length) console.log('no dev servers')
  for (const f of files) {
    const pid = Number(readFileSync(join(dir, f), 'utf8'))
    console.log(`port ${f.replace('.pid', '')} pid ${pid} ${alive(pid) ? 'running' : 'dead (stale pid file)'}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { cmd, port, extra } = parseArgs(process.argv.slice(2))
  try {
    if (cmd === 'start') await start(port, extra)
    else if (cmd === 'run') run(port)
    else if (cmd === 'stop') await stop(port)
    else if (cmd === 'status') status()
    else { console.error('usage: dev-server.mjs start|stop --port <n> | status'); process.exit(2) }
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
