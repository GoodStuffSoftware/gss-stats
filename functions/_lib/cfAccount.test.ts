import { describe, expect, it } from 'vitest'
import { cfAccountId } from './cfAccount'
import { onRequestPost } from '../api/stats'
import { pagesContext, postJson, TEST_ACCOUNT_ID } from './testing/hitsDb'

describe('cfAccountId (CF_ACCOUNT_ID secret)', () => {
  it('returns a 32-hex id, trimmed and lower-cased', () => {
    expect(cfAccountId({ CF_ACCOUNT_ID: TEST_ACCOUNT_ID })).toBe(TEST_ACCOUNT_ID)
    expect(cfAccountId({ CF_ACCOUNT_ID: ` ${TEST_ACCOUNT_ID.toUpperCase()}\r\n` })).toBe(TEST_ACCOUNT_ID)
  })

  it.each([[undefined], [''], ['   '], ['abc'], [TEST_ACCOUNT_ID + '0'], ['0123456789abcdef0123456789abcdeg'], ['" }) { x } #0123456789abcdef01234']])(
    'refuses %j (unset, or not exactly 32 hex: it goes into a GraphQL query)',
    (v) => expect(cfAccountId({ CF_ACCOUNT_ID: v })).toBeNull(),
  )

  it('/api/stats answers 500 naming the variable, never querying, when it is missing', async () => {
    const req = postJson('/api/stats', { site: 'all', dimensions: ['date'], metric: 'pageviews', limit: 50, since: '2026-09-01', until: '2026-09-30' })
    const res = await onRequestPost(pagesContext(req, { CF_ANALYTICS_TOKEN: 'test-token-not-real', STATS_CONFIG: {} as KVNamespace }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'CF_ACCOUNT_ID not configured' })
  })
})
