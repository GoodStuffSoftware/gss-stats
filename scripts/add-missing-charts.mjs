// Adds two charts to an existing dashboard config, preserving all other widgets:
//   - "New vs returning" (geo doughnut) → the Overview/default page
//   - "Site × device" (geo nested doughnut) → the Beacon page
// Idempotent (skips if the widget id already exists). Usage: node add-missing-charts.mjs <in> <out>
import { readFileSync, writeFileSync } from 'node:fs'

const [, , inPath, outPath] = process.argv
const cfg = JSON.parse(readFileSync(inPath, 'utf8'))

const geoVisitor = {
  id: 'geo-visitor', i: 'geo-visitor', title: 'New vs returning (beacon)', type: 'doughnut',
  dataset: 'geo', dimension: 'visitor', metric: 'pageviews', limit: 5, x: 0, y: 9999, w: 6, h: 8,
}
const bcnSiteDevice = {
  id: 'bcn-sitedevice', i: 'bcn-sitedevice', title: 'Device × site', type: 'nestedDoughnut',
  dataset: 'geo', dimension: 'device', breakdown: 'site', metric: 'pageviews', limit: 30, x: 0, y: 9999, w: 7, h: 9,
}

const changes = []
for (const p of cfg.pages || []) {
  if ((p.isDefault || p.id === 'default') && !p.widgets.some((w) => w.id === 'geo-visitor')) {
    p.widgets.push(geoVisitor)
    changes.push(`${p.name} += New vs returning`)
  }
  if (p.id === 'beacon' && !p.widgets.some((w) => w.id === 'bcn-sitedevice')) {
    p.widgets.push(bcnSiteDevice)
    changes.push(`${p.name} += Site × device`)
  }
}
writeFileSync(outPath, JSON.stringify(cfg))
console.log(changes.length ? changes.join('; ') : 'no changes (already present)')
console.log('pages:', (cfg.pages || []).map((p) => `${p.name}(${p.widgets.length}w)`).join(', '))
