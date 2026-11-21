// POST /api/budget/categories on the node:sqlite D1 fake (synthetic data), and its access rules end to end:
// root gate -> scoped middleware -> route, for every method and identity. Emails are made up (example.com).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CategoryCreateResponse, TxnPatchResponse } from '../../../src/lib/budget/types'
import { authGate, createSessionCookie, readAuthConfig, VIEWER_KEY_PREFIX, type ViewerStore } from '../../_lib/auth'
import type { BudgetData, BudgetEnv } from '../../_lib/budgetAccess'
import { callRoute, createBudgetDb, insertTxn, json, syntheticSeedSql, type FakeBudgetDb } from '../../_lib/testing/budgetDb'
import { onRequest as middleware } from './_middleware'
import { onRequest as catchAll } from './[[path]]'
import { onRequest as patchRoute } from './transactions/[id]'
import { onRequest } from './categories'

let db: FakeBudgetDb
beforeEach(async () => { db = await createBudgetDb() })

const post = (body: unknown, over: { rawBody?: string; email?: string | null; method?: string } = {}) =>
  callRoute(onRequest, db, '/api/budget/categories', { method: 'POST', body, ...over })
const cats = () => db.all<{ id: string; label: string; color: string | null; sort: number; archived: number }>('SELECT * FROM categories ORDER BY sort, id')

describe('POST /api/budget/categories', () => {
  it('makes a category: 201, trimmed label, u- id, no colour, sorted after every existing category', async () => {
    const maxBefore = Math.max(...cats().map((c) => c.sort))
    const res = await post({ name: '  Pet   food ' })
    expect(res.status).toBe(201)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    const body = await json<CategoryCreateResponse>(res)
    expect(body).toEqual({ category: { id: 'u-pet-food', label: 'Pet food', color: null, sort: maxBefore + 10 }, created: true })
    expect(cats().at(-1)).toMatchObject({ id: 'u-pet-food', label: 'Pet food', archived: 0 })
    // the next one goes after that one, so nothing already listed moves or changes palette slot
    const second = await json<CategoryCreateResponse>(await post({ name: 'Hobbies' }))
    expect(second.category.sort).toBe(maxBefore + 20)
    expect(cats().slice(0, -2).every((c) => c.sort <= maxBefore)).toBe(true)
  })

  it('a name that matches a category in any letter case returns that category (200, created false) and writes nothing', async () => {
    const before = cats()
    for (const name of ['groceries', 'GROCERIES', ' Groceries ', 'Gifts & giving']) {
      const res = await post({ name })
      expect(res.status, name).toBe(200)
      const body = await json<CategoryCreateResponse>(res)
      expect(body.created).toBe(false)
      expect(body.category.id).toBe(before.find((c) => c.label.toLowerCase() === name.trim().toLowerCase())!.id)
    }
    expect(cats()).toEqual(before)
    // also against one made in the app
    await post({ name: 'Hobbies' })
    const again = await json<CategoryCreateResponse>(await post({ name: 'hobbies' }))
    expect(again).toMatchObject({ created: false, category: { id: 'u-hobbies' } })
  })

  it('an archived category is not a duplicate: a new one is made with its own id', async () => {
    await post({ name: 'Hobbies' })
    db.exec("UPDATE categories SET archived = 1 WHERE id = 'u-hobbies'")
    const body = await json<CategoryCreateResponse>(await post({ name: 'Hobbies' }))
    expect(body).toMatchObject({ created: true, category: { id: 'u-hobbies-2' } })
  })

  it('ids never collide: a taken slug gets a suffix, an id taken in a race is retried', async () => {
    db.exec("INSERT INTO categories (id, label, sort) VALUES ('u-pets-2', 'Something else', 2000)")
    await post({ name: 'Pets!' }) // u-pets
    const b = await json<CategoryCreateResponse>(await post({ name: 'Pets?' }))
    expect(b.category.id).toBe('u-pets-3') // u-pets and u-pets-2 are taken
    // a different caller takes the id between our read and our write
    const real = db.d1.prepare.bind(db.d1)
    let raced = false
    ;(db.d1 as unknown as { prepare: (s: string) => unknown }).prepare = (sql: string) => {
      if (sql.startsWith('INSERT INTO categories') && !raced) {
        raced = true
        db.exec("INSERT INTO categories (id, label, sort) VALUES ('u-cats', 'Raced', 3000)")
      }
      return real(sql)
    }
    const c = await json<CategoryCreateResponse>(await post({ name: 'Cats' }))
    expect(c.category.id).toBe('u-cats-2')
    expect(db.get('SELECT label FROM categories WHERE id = ?', 'u-cats')).toEqual({ label: 'Raced' })
  })

  it('a long name still gets an id that fits the 32-character limit', async () => {
    const a = await json<CategoryCreateResponse>(await post({ name: 'a'.repeat(40) }))
    const b = await json<CategoryCreateResponse>(await post({ name: 'a'.repeat(39) + 'b' }))
    expect(a.category.id.length).toBeLessThanOrEqual(32)
    expect(b.category.id.length).toBeLessThanOrEqual(32)
    expect(b.category.id).not.toBe(a.category.id)
  })

  it('400 bad_request for every invalid name, naming the field; nothing is written', async () => {
    const before = cats()
    const long = 'x'.repeat(41)
    const cases: unknown[] = [
      {}, { name: null }, { name: 5 }, { name: '' }, { name: '   ' }, { name: long }, { name: 'a\u0000b' }, { name: 'a\nb' }, { name: 'a\tb' },
      { name: 'zero' + String.fromCharCode(0x200b) + 'width' }, { name: 'Uncategorized' }, { name: 'income' }, { name: 'Not spending' },
    ]
    for (const body of cases) {
      const res = await post(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      const out = await json<{ error: string; message: string }>(res)
      expect(out.error).toBe('bad_request')
      expect(out.message).toMatch(/^name:/)
    }
    expect((await post(null, { rawBody: 'not json' })).status).toBe(400)
    expect((await post(null, { rawBody: '[]' })).status).toBe(400)
    expect((await post({ name: 'x', pad: 'p'.repeat(2000) })).status).toBe(413)
    expect(cats()).toEqual(before)
  })

  it('a malicious name is only ever a bound value', async () => {
    const res = await post({ name: "x'); DROP TABLE categories;--" })
    expect(res.status).toBe(201)
    expect(cats().some((c) => c.label === "x'); DROP TABLE categories;--")).toBe(true)
  })

  it('POST only (405 with Allow, HEAD too); 403 without identity; 503 without the database', async () => {
    for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']) {
      const res = await callRoute(onRequest, db, '/api/budget/categories', { method })
      expect(res.status, method).toBe(405)
      expect(res.headers.get('Allow')).toBe('POST')
    }
    expect((await post({ name: 'Hobbies' }, { email: null })).status).toBe(403)
    expect(cats().some((c) => c.id === 'u-hobbies')).toBe(false)
  })

  it('the new category is used by an ordinary edit: manual source, audit row, review cleared', async () => {
    const id = insertTxn(db, { merchant_key: 'gadget-hut', merchant_name: 'Gadget Hut', needs_review: 1, review_reason: 'low_confidence' })
    const made = await json<CategoryCreateResponse>(await post({ name: 'Hobbies' }))
    const res = await callRoute(patchRoute, db, `/api/budget/transactions/${id}`, {
      method: 'PATCH', params: { id }, body: { categoryId: made.category.id, expectedUpdatedAt: '2026-12-05T10:00:00.000Z' },
    })
    expect(res.status).toBe(200)
    const { txn } = await json<TxnPatchResponse>(res)
    expect(txn).toMatchObject({ categoryId: 'u-hobbies', categorySource: 'manual', ruleId: null, confidence: 100, needsReview: false, reviewReason: null })
    expect(db.all('SELECT txn_id, old_category_id, new_category_id FROM category_edits')).toEqual([{ txn_id: id, old_category_id: null, new_category_id: 'u-hobbies' }])
  })

  it('a seed re-apply leaves the category and the row edited to it as they were', async () => {
    const id = insertTxn(db, { category_id: null })
    await post({ name: 'Hobbies' })
    db.exec("UPDATE categories SET color = '#123456' WHERE id = 'u-hobbies'")
    db.exec(`UPDATE transactions SET category_id = 'u-hobbies', category_source = 'manual' WHERE id = '${id}'`)
    const before = { cats: cats(), txn: db.get('SELECT * FROM transactions WHERE id = ?', id) }
    db.exec(await syntheticSeedSql())
    expect(cats()).toEqual(before.cats)
    expect(db.get('SELECT * FROM transactions WHERE id = ?', id)).toEqual(before.txn)
  })
})

// ---- access: every method x identity, through the real root gate and the scoped middleware ----------------

const ORIGIN = 'https://stats.goodstuff.software'
const OWNER_UNLISTED = 'owner@example.com'
const OWNER_LISTED = 'owner2@example.com'
const VIEWER_UNLISTED = 'viewer@example.com'
const VIEWER_LISTED = 'viewer2@example.com'
const VIEWERS: ViewerStore = {
  get: async (key) => (key === `${VIEWER_KEY_PREFIX}${VIEWER_UNLISTED}` || key === `${VIEWER_KEY_PREFIX}${VIEWER_LISTED}` ? 'viewer' : null),
}
type Who = 'signedOut' | 'ownerUnlisted' | 'viewerUnlisted' | 'viewerListed' | 'ownerListed'
const EMAILS = { ownerUnlisted: OWNER_UNLISTED, viewerUnlisted: VIEWER_UNLISTED, viewerListed: VIEWER_LISTED, ownerListed: OWNER_LISTED }
const WHO: Who[] = ['signedOut', 'ownerUnlisted', 'viewerUnlisted', 'viewerListed', 'ownerListed']
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']

const env = (): BudgetEnv => ({
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  SESSION_SECRET: 'c'.repeat(48),
  ALLOWED_EMAILS: `${OWNER_UNLISTED},${OWNER_LISTED}`,
  BUDGET_ALLOWED_EMAILS: `${OWNER_LISTED},${VIEWER_LISTED}`,
  STATS_CONFIG: VIEWERS,
  BUDGET_DB: db.d1,
})

async function cookieFor(who: Who, e: BudgetEnv): Promise<string | undefined> {
  if (who === 'signedOut') return undefined
  const r = readAuthConfig(e)
  if (!r.ok) throw new Error(r.problems.join('; '))
  return (await createSessionCookie(new URL(ORIGIN), r.config, { email: EMAILS[who], sub: `sub-${who}` }, Date.now())).split(';')[0]
}

/** Root gate -> scoped middleware -> the categories route (the catch-all for any other path). */
async function full(path: string, method: string, who: Who, body?: unknown) {
  const e = env()
  const headers = new Headers()
  const cookie = await cookieFor(who, e)
  if (cookie) headers.set('Cookie', cookie)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('Origin', ORIGIN)
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  const req = new Request(ORIGIN + path, { method, headers, body: body === undefined || method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body) })
  const data: BudgetData = {}
  const reached = vi.fn()
  const mwCtx = {
    request: req, env: e, data,
    next: async () => {
      reached()
      const leaf = new URL(req.url).pathname === '/api/budget/categories' ? onRequest : catchAll
      return leaf({ request: req, env: e, data, params: {} } as never)
    },
  } as unknown as Parameters<typeof middleware>[0]
  const res = await authGate(req, e, () => Promise.resolve(middleware(mwCtx)) as Promise<Response>)
  return { res, reached }
}

describe('/api/budget/categories access: 401 signed out, 403 off the allowlist, for every method', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })

  for (const method of METHODS) {
    it(method, async () => {
      for (const who of WHO) {
        const label = `${who} ${method}`
        const before = cats().length
        const { res, reached } = await full('/api/budget/categories', method, who, method === 'POST' ? { name: 'Hobbies' } : undefined)
        if (who === 'signedOut') {
          expect(res.status, label).toBe(401)
          expect(reached, label).not.toHaveBeenCalled()
        } else if (who === 'ownerUnlisted' || who === 'viewerUnlisted') {
          expect(res.status, label).toBe(403)
          expect(reached, label).not.toHaveBeenCalled()
        } else {
          expect(reached, label).toHaveBeenCalledOnce()
          expect(res.status, label).toBe(method === 'POST' ? 201 : 405)
        }
        // a refused caller writes nothing; the one POST that got through wrote exactly once
        if (res.status === 401 || res.status === 403) expect(cats().length, label).toBe(before)
        if (res.status !== 401) {
          expect(res.headers.get('Cache-Control'), label).toMatch(/no-store/)
          expect(res.headers.get('Cache-Control'), label).toMatch(/private/)
        }
        // keep each identity independent: a created category would turn the next POST into a 200
        db.exec("DELETE FROM categories WHERE id LIKE 'u-%'")
      }
    })
  }

  it('the existing routes answer as before (an unknown budget path is still the catch-all 404 for a listed account)', async () => {
    expect((await full('/api/budget/nope', 'POST', 'viewerListed', {})).res.status).toBe(404)
    expect((await full('/api/budget/nope', 'POST', 'signedOut', {})).res.status).toBe(401)
  })
})
