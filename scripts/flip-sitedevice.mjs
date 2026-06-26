// Set the bcn-sitedevice nested doughnut to site-inner / device-outer
// (devices on the outer ring). Idempotent. Usage: node flip-sitedevice.mjs <in> <out>
import { readFileSync, writeFileSync } from 'node:fs'
const [, , inPath, outPath] = process.argv
const cfg = JSON.parse(readFileSync(inPath, 'utf8'))
let changed = false
for (const p of cfg.pages || []) {
  const w = (p.widgets || []).find((x) => x.id === 'bcn-sitedevice')
  if (w && w.dimension !== 'site') {
    w.dimension = 'site'
    w.breakdown = 'device'
    w.title = 'Site × device'
    changed = true
  }
}
writeFileSync(outPath, JSON.stringify(cfg))
console.log(changed ? 'set bcn-sitedevice → Site × device (devices outer)' : 'no change (already site-inner / not present)')
