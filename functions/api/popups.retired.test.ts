// /api/popups' retired dimensions ('rates', 'eligible' — metric cards since layout version 11; 'rate' —
// a one-item metric card since layout version 18, its server branch removed in 0.24.1)
// answer 400 with a message naming the card, so a dashboard tab loaded before the update shows an
// error on those panels instead of silently falling back to the 'kind' counts ("No data").
import { describe, expect, it } from 'vitest'
import { onRequestPost, RETIRED_POPUP_DIMS } from './popups'

const noDb = { prepare: () => { throw new Error('a retired dimension must not query') } }
async function post(body: unknown) {
  const request = new Request('https://stats.example/api/popups', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  return (onRequestPost as any)({ request, env: { gss_geo: noDb }, waitUntil: () => {} }) as Promise<Response>
}

describe('/api/popups retired dimensions', () => {
  it.each(Object.entries(RETIRED_POPUP_DIMS))('%s → 400 naming the "%s" card and asking for a reload', async (dim, card) => {
    const res = await post({ dimension: dim, popup: 'upsell', since: '2026-09-01', until: '2026-09-26' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; retired: string }
    expect(body.retired).toBe(dim)
    expect(body.error).toContain(`"${card}" card`)
    expect(body.error).toMatch(/Reload the page/)
  })
  it('only the card-replaced dimensions are retired', async () => {
    expect(Object.keys(RETIRED_POPUP_DIMS).sort()).toEqual(['eligible', 'rate', 'rates'])
  })
  it('an older tab asking for one rate (dimension "rate" + rateKey) gets a clean 400 JSON error, not a 500 or a fallback to counts', async () => {
    const res = await post({ dimension: 'rate', rateKey: 'upsell:tap', since: '2026-09-01', until: '2026-09-26', sites: ['bestsudoku-web'], limit: 1 })
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toMatch(/json/)
    const body = (await res.json()) as { error: string; retired: string; rate?: unknown }
    expect(body.retired).toBe('rate')
    expect(body.error).toMatch(/Reload the page/)
    expect(body).not.toHaveProperty('rate')
  })
})
