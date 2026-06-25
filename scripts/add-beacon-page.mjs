// Adds a canonical "Beacon" page (all geo-dataset charts) to a dashboard config.
// Usage: node add-beacon-page.mjs <in.json> <out.json>
// Idempotent: skips if a page with id "beacon" already exists. Leaves all other
// pages (e.g. the RUM "Overview" page) untouched.
import { readFileSync, writeFileSync } from 'node:fs'

const [, , inPath, outPath] = process.argv
const cfg = JSON.parse(readFileSync(inPath, 'utf8'))
if (!cfg || !Array.isArray(cfg.pages)) {
  throw new Error('config is not a v2 pages object')
}

const now = Date.now()
const since = new Date(now - 29 * 86_400_000).toISOString().slice(0, 10)
const until = new Date(now).toISOString().slice(0, 10)

const w = (o) => ({ metric: 'pageviews', dataset: 'geo', breakdown: undefined, ...o, i: o.id })

const widgets = [
  w({ id: 'bcn-views', title: 'Pageviews', type: 'stat', dimension: 'site', limit: 1, x: 0, y: 0, w: 3, h: 3 }),
  w({ id: 'bcn-visitor', title: 'New vs returning', type: 'doughnut', dimension: 'visitor', limit: 5, x: 0, y: 3, w: 3, h: 6 }),
  w({ id: 'bcn-trend', title: 'Pageviews over time', type: 'area', dimension: 'date', limit: 90, x: 3, y: 0, w: 9, h: 8 }),
  w({ id: 'bcn-site', title: 'Pageviews by site', type: 'bar', dimension: 'site', limit: 12, x: 0, y: 9, w: 6, h: 8 }),
  w({ id: 'bcn-device', title: 'Device split', type: 'doughnut', dimension: 'device', limit: 6, x: 6, y: 8, w: 6, h: 8 }),
  w({ id: 'bcn-region', title: 'Visitors by region', type: 'hbar', dimension: 'region', limit: 15, x: 0, y: 17, w: 6, h: 8 }),
  w({ id: 'bcn-city', title: 'Top cities', type: 'hbar', dimension: 'city', limit: 15, x: 6, y: 16, w: 6, h: 8 }),
  w({ id: 'bcn-country', title: 'By country', type: 'hbar', dimension: 'country', limit: 10, x: 0, y: 25, w: 6, h: 8 }),
  w({ id: 'bcn-isp', title: 'By ISP / network', type: 'hbar', dimension: 'org', limit: 12, x: 6, y: 24, w: 6, h: 8 }),
  w({ id: 'bcn-ref', title: 'Top referrers', type: 'hbar', dimension: 'referrer', limit: 10, x: 0, y: 33, w: 6, h: 8 }),
  w({ id: 'bcn-pages', title: 'Top pages', type: 'hbar', dimension: 'path', limit: 10, x: 6, y: 32, w: 6, h: 8 }),
  w({ id: 'bcn-map', title: 'Visitor map', type: 'map', dimension: '', limit: 2000, x: 0, y: 41, w: 12, h: 9 }),
]

const page = {
  id: 'beacon',
  name: 'Beacon',
  isDefault: false,
  filters: {
    site: 'goodstuff.software',
    host: '',
    since,
    until,
    excludeSelfReferrals: true,
    excludeOwnVisits: true,
    ownBrowser: 'Opera',
    ownOS: 'Windows',
  },
  widgets,
}

if (cfg.pages.some((p) => p.id === 'beacon')) {
  console.log('Beacon page already present — no change.')
} else {
  cfg.pages.push(page)
  console.log('Added Beacon page.')
}
writeFileSync(outPath, JSON.stringify(cfg))
console.log('pages now:', cfg.pages.map((p) => `${p.name}${p.isDefault ? '*' : ''}`).join(', '))
