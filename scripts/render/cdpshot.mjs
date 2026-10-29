// True-width screenshot of a local page, for the render check (docs/render-check.md).
//
//   node scripts/render/cdpshot.mjs <port> <width> <height> <page-id> <out.png>
//
// Why not `chrome --headless --screenshot --window-size=390,...`: headless Chrome will not make its window
// narrower than about 500 px, so a "390" shot taken that way is really about 512 wide and the phone layout
// is not what a phone shows. This script opens the page and sets the viewport through the DevTools Protocol
// (Emulation.setDeviceMetricsOverride), which has no minimum width, then captures the viewport. Give a
// height tall enough to hold the whole page (for example 12000).
//
// Talks to a local `wrangler pages dev --port <port>` on loopback and to Chrome's debugging port on
// loopback only. Hidden window, fresh profile, removed afterwards. Chrome is found at CHROME_PATH, else the
// default Windows install path. No credentials or other env data are used. Needs Node 22 or newer (global
// fetch and WebSocket).
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [port, w, h, page, out] = process.argv.slice(2)
if (!port || !w || !h || !page || !out) {
  console.error('usage: node scripts/render/cdpshot.mjs <port> <width> <height> <page-id> <out.png>')
  process.exit(2)
}
const SETTLE_MS = 9000 // the page loads its data after the first paint; wait for it
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const profile = mkdtempSync(join(tmpdir(), 'cdp-'))
const debugPort = 9300 + Math.floor(Math.random() * 500)
const chrome = spawn(
  chromePath,
  ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, '--hide-scrollbars', 'about:blank'],
  { windowsHide: true, stdio: 'ignore' },
)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let spawnError
chrome.on('error', (e) => (spawnError = e)) // a wrong CHROME_PATH: report it, and still clean up the profile

try {
  let targets
  for (let i = 0; i < 50; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()
      if (targets.find((t) => t.type === 'page')) break
    } catch {
      // Chrome is not listening yet
    }
    await sleep(200)
  }
  const target = targets?.find((t) => t.type === 'page')
  if (!target) throw new Error(spawnError ? `could not start Chrome at ${chromePath}: ${spawnError.message}` : 'Chrome did not open a debugging page')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d)
      pending.delete(d.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id
      pending.set(i, r)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  await send('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?page=${page}` })
  await sleep(SETTLE_MS)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
  ws.close()
  console.log(out)
} finally {
  chrome.kill()
  await sleep(500)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    // Chrome may still hold the profile for a moment; the OS temp directory is cleaned out later
  }
}
