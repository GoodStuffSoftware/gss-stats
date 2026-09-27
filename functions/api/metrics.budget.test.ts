// The planner's statement budget (ADR 0003 section 3, step 3): a batch whose distinct facts
// need more statements than MAX_STATEMENTS is answered 413 { maxStatements } before any
// statement runs, and the client splits it. With three campaigns the real registry tops out
// near a dozen statements, so this file lowers the budget to prove the gate itself.
import { describe, expect, it, vi } from 'vitest'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../_lib/testing/hitsDb'

vi.mock('../../src/lib/metrics/validate', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/lib/metrics/validate')>()), MAX_STATEMENTS: 3 }))
const { onRequestPost } = await import('./metrics')

describe('statement budget', () => {
  it('over budget: 413 with maxStatements, and no statement runs', async () => {
    const db = openHitsDb()
    insertHits(db, [{ ts: Date.now(), site: 'bestsudoku-web', path: '/game' }])
    const d1 = sqliteD1(db)
    const undo = installCaches(memoryCache())
    const requests = ['24215315197', '24279250691'].flatMap((id) => [
      { key: `${id}.asks`, metric: 'campaign.asks', params: { campaignId: id } }, // campaignPathVisitor (+ flightPathsSeen when closed)
      { key: `${id}.d0`, metric: 'campaign.returnD0', params: { campaignId: id } }, // campaignReturns
    ])
    const res = await onRequestPost(pagesContext(postJson('/api/metrics', { v: 1, requests }), { gss_geo: d1 }))
    undo()
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ maxStatements: 3 })
    expect(d1.statements).toEqual([])
  })
  it('at budget: answered', async () => {
    const db = openHitsDb()
    const d1 = sqliteD1(db)
    const undo = installCaches(memoryCache())
    const res = await onRequestPost(pagesContext(postJson('/api/metrics', { v: 1, requests: [{ key: 'a', metric: 'campaign.asks', params: { campaignId: '24215315197' } }, { key: 'b', metric: 'bsk.pageviews' }] }), { gss_geo: d1 }))
    undo()
    expect(res.status).toBe(200)
    expect(d1.statements).toHaveLength(3)
  })
})
