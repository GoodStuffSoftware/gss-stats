// Flip the bcn-sitedevice nested doughnut to device-inner / site-outer.
// Idempotent. Usage: node flip-sitedevice.mjs <in> <out>
import { readFileSync, writeFileSync } from 'node:fs'
const [, , inPath, outPath] = process.argv
const cfg = JSON.parse(readFileSync(inPath, 'utf8'))
let changed = false
for (const p of cfg.pages || []) {
  const w = (p.widgets || []).find((x) => x.id === 'bcn-sitedevice')
  if (w && w.dimension !== 'device') {
    w.dimension = 'device'
    w.breakdown = 'site'
    w.title = 'Device × site'
    changed = true
  }
}
writeFileSync(outPath, JSON.stringify(cfg))
console.log(changed ? 'flipped bcn-sitedevice → Device × site' : 'no change (already flipped / not present)')
