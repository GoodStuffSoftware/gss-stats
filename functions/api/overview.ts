/// <reference types="@cloudflare/workers-types" />
//
// "Best Sudoku overview" dataset — the release before/after panel, the one bespoke Overview
// panel left (ADR 0003 slice 7 turns it into a card preset too). Reads the same D1 `hits` table
// as /api/geo, /api/popups and /api/campaigns and reuses their classifiers.
//
// Retired sections: "Today at a glance" (kpis) and the campaign scorecard are metric cards
// since CONFIG_VERSION 10, served by POST /api/metrics (presets 'bsk-kpis' and
// 'campaign-scorecard'); the daily timeline is the standard line chart over /api/geo
// (CONFIG_VERSION 9). Their numbers are pinned by src/components/metrics/presets.parity.test.ts
// against a golden captured from the last build that still served them.
//
// ANONYMOUS AGGREGATES ONLY, no joins — every D1 query below is a GROUP BY producing counts
// (or a bare MIN), never a raw per-row fetch.
//
// POST {} — the panel is computed server-side from the latest dated release.

import { isAuthSuccessBase, isInstallPromptInstalled } from '../../src/lib/campaigns'
import { etDateFromMs } from '../../src/lib/popupEvents'
import { isEventPath, releaseComparisonWindows, siteWindowClause } from '../../src/lib/overview'
import { latestDatedRelease } from '../../src/lib/releases'
// lib/defaults.ts is plain TypeScript (no Vue imports), so the Function shares its site list
// instead of keeping a copy.
import { BEST_SUDOKU_SITES } from '../../src/lib/bestSudokuSites'

interface Env {
  gss_geo: D1Database
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

// One per sign-in: the base row only (lib/campaigns.ts isAuthSuccessBase), never the
// /auth/success/<provider>/<new|existing|unknown> row sent alongside it for the same sign-in.
const isAuthSuccess = isAuthSuccessBase
// Installs = the install prompt's "installed" outcome (once per showing), like the campaign
// funnel; raw install beacons can double-count one install.
const isInstallOutcome = isInstallPromptInstalled

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  if (!ctx.env.gss_geo) return json({ error: 'geo DB not bound' }, 500)
  const db = ctx.env.gss_geo
  const nowMs = Date.now()
  const todayEt = etDateFromMs(nowMs)

  // The first-ever Best Sudoku hit caps the release panel's "before" window.
  const sqlFirstHit = `SELECT MIN(ts) AS t FROM hits WHERE site IN (${BEST_SUDOKU_SITES.map(() => '?').join(', ')})`
  let rFirstHit: any
  try {
    rFirstHit = await db.prepare(sqlFirstHit).bind(...BEST_SUDOKU_SITES).all()
  } catch (e) {
    return json({ error: 'd1 query failed', detail: String(e) }, 500)
  }

  // ── RELEASE PANEL ─────────────────────────────────────────────────────────────────────────
  const firstHitMs = Number(rFirstHit.results?.[0]?.t) || nowMs
  const firstHitEt = etDateFromMs(firstHitMs)
  const latest = latestDatedRelease()
  let releasePanel: any = null
  if (latest) {
    const windows = releaseComparisonWindows(latest.dateEt, firstHitEt, nowMs)
    if (windows) {
      // siteWindowClause applies exclusions: a before/after comparison is exactly where uneven
      // household/lifecycle traffic on either side of the release date would bias the delta.
      const releaseWindowQuery = (startMs: number, endMs: number) => {
        const clause = siteWindowClause(BEST_SUDOKU_SITES, startMs, endMs)
        const sql = `SELECT path, visitor, campaign, COUNT(*) AS c FROM hits WHERE ${clause.sql} GROUP BY path, visitor, campaign`
        return db.prepare(sql).bind(...clause.binds).all()
      }
      let beforeRes: any, afterRes: any
      try {
        ;[beforeRes, afterRes] = await Promise.all([releaseWindowQuery(windows.before[0], windows.before[1]), releaseWindowQuery(windows.after[0], windows.after[1])])
      } catch (e) {
        return json({ error: 'd1 query failed', detail: String(e) }, 500)
      }
      const summarize = (res: any) => {
        const rows = (res.results ?? []).map((x: any) => ({ path: String(x.path ?? ''), visitor: String(x.visitor ?? ''), campaign: String(x.campaign ?? ''), c: Number(x.c) || 0 }))
        let pageviews = 0, taggedArrivals = 0, authSuccess = 0, install = 0
        for (const r of rows) {
          if (!isEventPath(r.path)) pageviews += r.c
          if (r.visitor === 'new' && r.campaign) taggedArrivals += r.c
          if (isAuthSuccess(r.path)) authSuccess += r.c
          if (isInstallOutcome(r.path)) install += r.c
        }
        return { pageviews, taggedArrivals, authSuccess, install }
      }
      releasePanel = {
        release: latest,
        days: windows.days,
        before: summarize(beforeRes),
        after: summarize(afterRes),
        note: 'before = partially instrumented — auth success, install, and campaign tagging are new paths this release adds; the "before" window predates them.',
      }
    }
  }

  return json({ generatedAt: new Date().toISOString(), todayEt, releasePanel })
}

export const onRequestGet: PagesFunction = async () => json({ ok: true, hint: 'POST an overview query: {}' })
