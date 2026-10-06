// The Step 8 report page: build it from a synthetic morning read (fixtures/threshold-50.json run
// through the real CLI code, nothing committed from a live campaign), check the payload
// round-trips, check the build fails loudly on bad input, and run the page's own script in
// happy-dom to check every section degrades to a "not read" line instead of breaking.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import { beforeAll, describe, expect, it } from 'vitest'
import { fixtureDeps, type Fixture } from './cli'
import { runMorningRead, type MorningOptions, type MorningResult } from './read'
import { asciiFold, asciiResult, formatMorningReport, withJson } from './report'
import { buildReadPage, JSON_SPLIT, PLACEHOLDER, TEMPLATE_PATH, type Narrative } from './read-page'
import { MIN_COHORT } from '../../src/lib/popupEvents'

const here = path.dirname(fileURLToPath(import.meta.url))
const template = fs.readFileSync(TEMPLATE_PATH, 'utf8')
const opts: MorningOptions = { campaignId: '24279250691', releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24 }
const narrative: Narrative = {
  headline: 'Synthetic $50 read: $50.10 spent, <b>not markup</b>',
  working: ['Delivery steady: $13.40 yesterday.'],
  notWorking: ['Asks are low.'],
  soWhat: ['Proposal: CONTINUE, no kill rule tripped.', 'Watch asks at $75.'],
}

let result: MorningResult
let human: string
let raw: string
beforeAll(async () => {
  const fx: Fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8'))
  result = await runMorningRead(fixtureDeps(fx, true), opts)
  human = formatMorningReport(result)
  raw = withJson(human, result)
})

/** The payload the build injected, read back the way the page reads it. */
function payloadOf(html: string) {
  const m = html.match(/<script type="application\/json" id="report-src">([\s\S]*?)<\/script>/)
  expect(m).not.toBeNull()
  expect(m![1]).not.toContain('<')
  return JSON.parse(m![1])
}

/** Renders the built page in happy-dom by running its inline script against the DOM. */
function render(html: string) {
  const win = new Window({ url: 'https://example.test/' })
  const doc = win.document
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  const pageScript = scripts.find((s) => !s[0].startsWith('<script type="application/json"'))![1]
  doc.write(html.replace(pageScript, ''))
  new Function('document', 'window', 'navigator', pageScript)(doc, win, win.navigator)
  const text = (id: string) => doc.getElementById(id)?.textContent ?? ''
  return { doc, text, body: doc.body.textContent ?? '' }
}

const degrade = (mutate: (r: Record<string, unknown>) => void) => {
  const r = JSON.parse(JSON.stringify(result))
  mutate(r)
  return withJson(human, r)
}

describe('read-page build', () => {
  it('injects the payload with the raw output round-tripping exactly, "$" and "<" included', () => {
    const tricky = raw.replace('BSK retest', 'BSK retest $& $1 $$ </script><b>')
    const html = buildReadPage({ template, raw: tricky, narrative, audit: { commit: 'abc1234' } })
    expect(html).not.toContain(PLACEHOLDER)
    expect(html).toContain('<title>BSK Retest Morning Read</title>')
    const p = payloadOf(html)
    expect(p.raw).toBe(tricky)
    expect(p.narrative).toEqual(narrative)
    expect(p.audit).toEqual({ commit: 'abc1234', branch: 'docs/ads-next-campaign', file: `docs/marketing/google-ads/retest/data/${result.etDate}.json` })
  })
  it('audit is null when no commit is given, and explicit branch/file win over the defaults', () => {
    expect(payloadOf(buildReadPage({ template, raw, narrative })).audit).toBeNull()
    expect(payloadOf(buildReadPage({ template, raw, narrative, audit: { commit: 'f0b13bf', branch: 'b', file: 'f.json' } })).audit).toEqual({ commit: 'f0b13bf', branch: 'b', file: 'f.json' })
  })
  it('fails on a missing or unparseable JSON block', () => {
    expect(() => buildReadPage({ template, raw: human, narrative })).toThrow(/no "----- JSON -----" line/)
    expect(() => buildReadPage({ template, raw: `${human}\n${JSON_SPLIT}\n{"cut off": `, narrative })).toThrow(/does not parse/)
  })
  it('fails on a narrative missing a field or with an empty array', () => {
    const { soWhat: _drop, ...noSoWhat } = narrative
    expect(() => buildReadPage({ template, raw, narrative: noSoWhat })).toThrow(/narrative\.soWhat/)
    expect(() => buildReadPage({ template, raw, narrative: { ...narrative, working: [] } })).toThrow(/narrative\.working is missing or an empty array/)
    expect(() => buildReadPage({ template, raw, narrative: { ...narrative, headline: '' } })).toThrow(/narrative\.headline/)
    expect(() => buildReadPage({ template, raw, narrative: [] })).toThrow(/not a JSON object/)
  })
  it('the CLI writes nothing and exits non-zero with a one-line reason on bad input, and prints the path on success', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-page-'))
    const input = path.join(dir, 'read.out')
    const narr = path.join(dir, 'narrative.json')
    const out = path.join(dir, 'page.html')
    fs.writeFileSync(narr, JSON.stringify(narrative))
    const tsx = path.join(here, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
    const run = () => execFileSync(process.execPath, [tsx, path.join(here, 'read-page.ts'), '--input', input, '--narrative', narr, '--out', out, '--audit-commit', 'abc1234'], { encoding: 'utf8', stdio: 'pipe' })
    fs.writeFileSync(input, human)
    let err: { status?: number; stderr?: string } = {}
    try {
      run()
    } catch (e) {
      err = e as typeof err
    }
    expect(err.status).toBe(1)
    expect(err.stderr!.trim().split('\n')).toHaveLength(1)
    expect(err.stderr).toMatch(/^read-page: no "----- JSON -----" line/)
    expect(fs.existsSync(out)).toBe(false)
    fs.writeFileSync(input, raw)
    expect(run().trim()).toBe(path.resolve(out))
    expect(payloadOf(fs.readFileSync(out, 'utf8')).raw).toBe(raw)
    fs.rmSync(dir, { recursive: true, force: true })
  }, 30_000)
})

describe('read-page rendering', () => {
  it('renders a full threshold read: narrative, audit, verbatim report and JSON', () => {
    const { text, doc, body } = render(buildReadPage({ template, raw, narrative, audit: { commit: 'abc1234' } }))
    expect(text('headline')).toBe(narrative.headline)
    expect(text('narrative')).toContain('Watch asks at $75.')
    expect(text('raw-human')).toBe(asciiFold(human).replace(/\s+$/, ''))
    expect(JSON.parse(text('raw-json'))).toEqual(asciiResult(result))
    expect(text('footer')).toContain('abc1234')
    expect(doc.getElementById('kill')!.querySelectorAll('tbody tr').length).toBeGreaterThan(0)
    expect(body).not.toMatch(/could not be read|Could not be shown/)
  })
  it('renders the first-session funnel with site-wide counts and "not yet tracked" for untracked steps', () => {
    const { doc } = render(buildReadPage({ template, raw, narrative }))
    const rows = [...doc.getElementById('first-session')!.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent))
    expect(rows.find((r) => r[0] === 'Game views')).toEqual(['Game views', '64', '1,900', ''])
    expect(rows.find((r) => r[0] === 'Game complete')).toEqual(['Game complete', '0', '41', '']) // no ratio against game views (mixed units)
    expect(rows.find((r) => r[0] === 'First move')).toEqual(['First move', 'not yet tracked', 'no rows yet', ''])
    expect(rows.find((r) => r[0] === 'Welcome card shown')![1]).toBe('not yet tracked')
  })
  const firstSessionRows = (html: string) => {
    const { doc } = render(html)
    return [...doc.getElementById('first-session')!.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent))
  }
  it('shows the v1.97.0 first-run counters after the tour steps, "not yet tracked" while the fixture predates v1.97.0', () => {
    const rows = firstSessionRows(buildReadPage({ template, raw, narrative }))
    const labels = rows.map((r) => r[0])
    const i = labels.indexOf('Tour skip')
    expect(labels.slice(i + 1, i + 11)).toEqual([
      '  of which skipped at: preamble', '  of which skipped at: hub', '  of which skipped at: section',
      'Game start: easy', 'Game start: medium', 'Game start: hard', 'Game start: expert', 'Game start: difficulty unknown',
      'Tutorial complete: first run', 'Tutorial complete: replay',
    ])
    expect(labels[i + 11]).toBe('First move')
    for (const l of labels.slice(i + 1, i + 11)) expect(rows.find((r) => r[0] === l)).toEqual([l, 'not yet tracked', 'no rows yet', ''])
  })
  it('shows the v1.97.0 first-run counters as tagged and site-wide counts once they have rows', () => {
    const fig = (tagged: number, site: number) => ({ tagged, site, tracked: true })
    const rows = firstSessionRows(
      buildReadPage({
        template,
        raw: degrade((d) => {
          const f = (d.firstSession as any).funnel
          f.tourExit = { preamble: fig(2, 20), hub: fig(3, 30), section: fig(0, 10) }
          f.gameStart = { easy: fig(6, 1090), medium: fig(0, 40), hard: fig(1, 20), expert: fig(0, 7), unknown: fig(0, 3) }
          f.tutorialComplete = { 'first-run': fig(0, 2), replay: fig(4, 11) }
        }),
        narrative,
      }),
    )
    expect(rows.find((r) => r[0] === '  of which skipped at: hub')).toEqual(['  of which skipped at: hub', '3', '30', ''])
    expect(rows.find((r) => r[0] === 'Game start: easy')).toEqual(['Game start: easy', '6', '1,090', ''])
    expect(rows.find((r) => r[0] === 'Tutorial complete: replay')).toEqual(['Tutorial complete: replay', '4', '11', ''])
  })
  it('a result saved before the v1.97.0 counters existed still renders the first-session panel, without the new rows', () => {
    const rows = firstSessionRows(
      buildReadPage({
        template,
        raw: degrade((d) => {
          const f = (d.firstSession as any).funnel
          delete f.tourExit
          delete f.gameStart
          delete f.tutorialComplete
        }),
        narrative,
      }),
    )
    expect(rows.find((r) => r[0] === 'Game views')).toEqual(['Game views', '64', '1,900', ''])
    expect(rows.some((r) => /^(\s*of which skipped at|Game start|Tutorial complete):/.test(r[0]!))).toBe(false)
  })
  it('the first-session panel degrades to a line when it is missing', () => {
    const { body } = render(buildReadPage({ template, raw: degrade((d) => { d.firstSession = null }), narrative }))
    expect(body).toContain('Not read on this run: tagged beacon rows unavailable')
    expect(body).not.toMatch(/Could not be shown/)
  })
  it('says the audit trail was not written when audit is null', () => {
    const { text } = render(buildReadPage({ template, raw, narrative }))
    expect(text('footer')).toContain('Audit trail: not written on this run')
  })
  it('degrades every missing or failed sub-read to a short line instead of breaking', () => {
    const r = degrade((d) => {
      d.thresholdRead = null
      d.spend = { ...(d.spend as object), ok: false, error: 'spend: synthetic outage', yesterday: null }
      d.diagnostics = null
      d.playReports = { ok: false, error: 'service-account file unreadable', errors: [], checkpoints: [] }
      delete d.releaseHealth
      d.tagged = { ok: false, error: 'beacon: synthetic outage', cumulative: null, yesterday: null }
      d.status = null
      d.statusError = 'status: synthetic outage'
      d.play = null
    })
    const { text, body } = render(buildReadPage({ template, raw: r, narrative }))
    expect(text('headline')).toBe(narrative.headline)
    expect(body).not.toMatch(/could not be read|Could not be shown/)
    expect(body).toContain('Not read on this run: spend (spend: synthetic outage)')
    expect(body).toContain('Not read on this run: release health is missing')
    expect(body).toContain('Not read on this run: diagnostics missing')
    expect(body).toContain('Not read on this run: service-account file unreadable')
    expect(body).toContain('Not read on this run: returns are read on threshold reads only')
    expect(body).toContain('Not read on this run: tagged beacon counts (beacon: synthetic outage)')
    expect(text('dateline')).toContain('Campaign status not read on this run (status: synthetic outage)')
    expect(text('raw-human')).toBe(asciiFold(human).replace(/\s+$/, ''))
  })
  it('shows diagnostics errors and per-sub-read gaps, and a READ FAILED line as a callout', () => {
    const r = degrade((d) => {
      d.diagnostics = { spendThroughEt: '2026-09-29', hourly: null, geo: null, devices: [], targeting: null, recommendations: null, countryCounts: null, accountCrossCheck: null, errors: ['geo: GAQL synthetic error'] }
    }).replace(/\n/, '\nREAD FAILED: beacon (synthetic)\n')
    const { text, body } = render(buildReadPage({ template, raw: r, narrative }))
    expect(body).toContain('geo: GAQL synthetic error')
    expect(body).toContain('Not read on this run: geo breakdown')
    expect(text('callouts')).toContain('READ FAILED: beacon (synthetic)')
    expect(body).not.toMatch(/Could not be shown/)
  })
  it('contains a section that throws while rendering to that section', () => {
    const r = degrade((d) => {
      ;(d.releaseHealth as { results: unknown }).results = [null]
    })
    const { text, body } = render(buildReadPage({ template, raw: r, narrative }))
    expect(body).toMatch(/Could not be shown/)
    expect(text('headline')).toBe(narrative.headline)
    expect(text('footer')).toContain('Audit trail')
  })
})
