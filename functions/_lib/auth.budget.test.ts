// The Budget list in the ROOT gate (docs/adr/0007-budget-section.md, README "Budget"): every method
// on every spelling of /api/budget/* needs an email on BUDGET_ALLOWED_EMAILS, owner or viewer alike;
// a listed viewer may write there and nowhere else; an empty or missing list admits nobody. Every
// email here is made up (example.com).
import { describe, it, expect, vi } from 'vitest'
import {
  authGate,
  BUDGET_DENIED,
  budgetAllowed,
  createSessionCookie,
  isBudgetPath,
  readAuthConfig,
  VIEWER_KEY_PREFIX,
  type AuthEnv,
  type ViewerStore,
} from './auth'

const ORIGIN = 'https://stats.goodstuff.software'
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0)
const OWNER_UNLISTED = 'owner@example.com'
const OWNER_LISTED = 'owner2@example.com'
const VIEWER_UNLISTED = 'viewer@example.com'
const VIEWER_LISTED = 'viewer2@example.com'

const VIEWERS: ViewerStore = {
  get: async (key) =>
    key === `${VIEWER_KEY_PREFIX}${VIEWER_UNLISTED}` || key === `${VIEWER_KEY_PREFIX}${VIEWER_LISTED}` ? 'viewer' : null,
}

const ENV: AuthEnv = {
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  SESSION_SECRET: 'b'.repeat(48),
  ALLOWED_EMAILS: `${OWNER_UNLISTED},${OWNER_LISTED}`,
  BUDGET_ALLOWED_EMAILS: ` ${OWNER_LISTED.toUpperCase()} , ${VIEWER_LISTED} `, // case and spaces never matter
  STATS_CONFIG: VIEWERS,
}

type Who = 'signedOut' | 'ownerUnlisted' | 'viewerUnlisted' | 'viewerListed' | 'ownerListed'
const EMAILS: Record<Exclude<Who, 'signedOut'>, string> = {
  ownerUnlisted: OWNER_UNLISTED,
  viewerUnlisted: VIEWER_UNLISTED,
  viewerListed: VIEWER_LISTED,
  ownerListed: OWNER_LISTED,
}
const WHO: Who[] = ['signedOut', 'ownerUnlisted', 'viewerUnlisted', 'viewerListed', 'ownerListed']

async function cookieFor(who: Who): Promise<string | undefined> {
  if (who === 'signedOut') return undefined
  const r = readAuthConfig(ENV)
  if (!r.ok) throw new Error(r.problems.join('; '))
  const header = await createSessionCookie(new URL(ORIGIN), r.config, { email: EMAILS[who], sub: `sub-${who}` }, NOW)
  return header.split(';')[0]
}

async function gate(path: string, method: string, who: Who, env: AuthEnv = ENV, base = ORIGIN) {
  const headers = new Headers()
  const cookie = await cookieFor(who)
  if (cookie) headers.set('Cookie', cookie)
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') headers.set('Origin', base)
  const next = vi.fn(async () => new Response('protected', { status: 200 }))
  const res = await authGate(new Request(base + path, { method, headers }), env, next, { now: () => NOW })
  return { res, next }
}

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
const PATHS = [
  '/api/budget/access',
  '/api/budget/transactions/x',
  '/api/Budget/meta',
  '/api//budget/meta',
  '/api/%62udget/meta',
  '/api/budget%2Fmeta',
  '/api/BUDGET%2fmeta',
  '/api/%2562udget/meta',
  '/api/./budget/meta',
  '/api/x/../budget/meta',
  '/api/budget/',
  '/api/budget',
]

describe('isBudgetPath', () => {
  it('catches every spelling that could reach a budget Function', () => {
    for (const p of PATHS) expect(isBudgetPath(p), p).toBe(true)
    expect(isBudgetPath('/api/budget/..%2f..%2fstats')).toBe(true) // read as written, it is still under budget
    expect(isBudgetPath('/api\\budget/meta')).toBe(true)
  })
  it('a path that will not decode counts as budget (deny by default)', () => {
    expect(isBudgetPath('/api/%E0%A4%A')).toBe(true)
    expect(isBudgetPath('/api/%25%25%25%25/x')).toBe(true) // still escaped after three decodes
  })
  it('leaves every other path alone', () => {
    for (const p of ['/', '/api/stats', '/api/config', '/api/budgets', '/api/budgetary/x', '/budget', '/assets/budget.js', '/auth/me', '/api']) {
      expect(isBudgetPath(p), p).toBe(false)
    }
  })
})

describe('budgetAllowed', () => {
  it('is an exact, case-insensitive match on the list', () => {
    const env = { BUDGET_ALLOWED_EMAILS: 'A@example.com, b@example.com' }
    expect(budgetAllowed('a@example.com', env)).toBe(true)
    expect(budgetAllowed('B@EXAMPLE.COM', env)).toBe(true)
    expect(budgetAllowed('c@example.com', env)).toBe(false)
    expect(budgetAllowed('a@example.com.evil.test', env)).toBe(false)
    expect(budgetAllowed('example.com', env)).toBe(false)
    expect(budgetAllowed(undefined, env)).toBe(false)
  })
  it('fails closed on a missing, empty or blank list', () => {
    for (const raw of [undefined, '', '   ', ',,', ' , ']) {
      expect(budgetAllowed('a@example.com', { BUDGET_ALLOWED_EMAILS: raw }), String(raw)).toBe(false)
    }
  })
  it('refuses a non-ASCII look-alike of a listed address', () => {
    expect(budgetAllowed('Kate@example.com', { BUDGET_ALLOWED_EMAILS: 'kate@example.com' })).toBe(false) // KELVIN SIGN
  })
})

describe('the root gate, every method x identity x spelling', () => {
  for (const method of METHODS) {
    for (const path of PATHS) {
      it(`${method} ${path}`, async () => {
        for (const who of WHO) {
          const { res, next } = await gate(path, method, who)
          const label = `${who} ${method} ${path}`
          if (who === 'signedOut') {
            expect(res.status, label).toBe(401)
            expect(next, label).not.toHaveBeenCalled()
          } else if (who === 'ownerUnlisted' || who === 'viewerUnlisted') {
            expect(res.status, label).toBe(403)
            if (method !== 'HEAD') expect(await res.json(), label).toEqual(BUDGET_DENIED)
            expect(next, label).not.toHaveBeenCalled()
          } else {
            expect(res.status, label).toBe(200)
            expect(next, label).toHaveBeenCalledOnce()
          }
          // Every answer is uncacheable: a denial is no-store, a pass is private, no-store.
          expect(res.headers.get('Cache-Control'), label).toMatch(/no-store/)
        }
      })
    }
  }
})

describe('a listed viewer writes under budget only', () => {
  it('a listed viewer writes under /api/budget/* and is view-only everywhere else', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const budget = await gate('/api/budget/transactions/x', method, 'viewerListed')
      expect(budget.res.status, method).toBe(200)
      expect(budget.next, method).toHaveBeenCalledOnce()
      for (const path of ['/api/config', '/api/ads/refresh', '/api/stats/', '/api/budgets', '/api/anything-added-later']) {
        const other = await gate(path, method, 'viewerListed')
        expect(other.res.status, `${method} ${path}`).toBe(403)
        expect(((await other.res.json()) as { error?: string }).error, `${method} ${path}`).toBe('view_only')
        expect(other.next, `${method} ${path}`).not.toHaveBeenCalled()
      }
    }
  })

  it('an unlisted viewer gets budget_denied on budget (not view_only) and view_only elsewhere', async () => {
    const budget = await gate('/api/budget/transactions/x', 'PATCH', 'viewerUnlisted')
    expect(((await budget.res.json()) as { error?: string }).error).toBe('budget_denied')
    const other = await gate('/api/config', 'PUT', 'viewerUnlisted')
    expect(((await other.res.json()) as { error?: string }).error).toBe('view_only')
  })

  it('non-budget paths behave as before for every identity', async () => {
    for (const who of ['ownerUnlisted', 'ownerListed', 'viewerUnlisted', 'viewerListed'] as const) {
      expect((await gate('/api/config', 'GET', who)).res.status, who).toBe(200)
      expect((await gate('/', 'GET', who)).res.status, who).toBe(200)
    }
    for (const who of ['ownerUnlisted', 'ownerListed'] as const) {
      expect((await gate('/api/config', 'PUT', who)).res.status, who).toBe(200)
    }
    expect((await gate('/api/config', 'GET', 'signedOut')).res.status).toBe(401)
  })

  it('a cross-origin write to budget is refused before the list is looked at', async () => {
    const r = readAuthConfig(ENV)
    if (!r.ok) throw new Error('env')
    const cookie = (await createSessionCookie(new URL(ORIGIN), r.config, { email: OWNER_LISTED, sub: 's' }, NOW)).split(';')[0]
    const next = vi.fn(async () => new Response('protected'))
    const res = await authGate(
      new Request(`${ORIGIN}/api/budget/transactions/x`, { method: 'PATCH', headers: { Cookie: cookie, Origin: 'https://evil.example.com' } }),
      ENV,
      next,
      { now: () => NOW },
    )
    expect(res.status).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('the list secret missing or empty locks budget for everyone', () => {
  for (const raw of [undefined, '', '   ', ' , ']) {
    it(`BUDGET_ALLOWED_EMAILS = ${JSON.stringify(raw)}`, async () => {
      const env: AuthEnv = { ...ENV, BUDGET_ALLOWED_EMAILS: raw }
      for (const method of METHODS) {
        for (const who of WHO) {
          const { res, next } = await gate('/api/budget/access', method, who, env)
          expect(res.status, `${who} ${method}`).toBe(who === 'signedOut' ? 401 : 403)
          expect(next, `${who} ${method}`).not.toHaveBeenCalled()
        }
      }
      // ... and nothing else is affected.
      expect((await gate('/api/config', 'GET', 'ownerListed', env)).res.status).toBe(200)
    })
  }
})

describe('the local dev bypass', () => {
  const LOCAL = 'http://localhost'
  const bypass = (extra: AuthEnv = {}): AuthEnv => ({ AUTH_DEV_BYPASS: '1', ...extra })

  it('opens budget only for a listed dev email', async () => {
    for (const method of METHODS) {
      const unlisted = await gate('/api/budget/access', method, 'signedOut', bypass({ BUDGET_ALLOWED_EMAILS: OWNER_LISTED }), LOCAL)
      expect(unlisted.res.status, method).toBe(403)
      expect(unlisted.next, method).not.toHaveBeenCalled()
      const missing = await gate('/api/budget/access', method, 'signedOut', bypass(), LOCAL)
      expect(missing.res.status, method).toBe(403)
      const listed = await gate('/api/budget/access', method, 'signedOut', bypass({ BUDGET_ALLOWED_EMAILS: 'dev@localhost' }), LOCAL)
      expect(listed.res.status, method).toBe(200)
      expect(listed.next, method).toHaveBeenCalledOnce()
      const custom = await gate(
        '/api/budget/access',
        method,
        'signedOut',
        bypass({ AUTH_DEV_EMAIL: 'Dev@Example.com', BUDGET_ALLOWED_EMAILS: 'dev@example.com' }),
        LOCAL,
      )
      expect(custom.res.status, method).toBe(200)
    }
  })

  it('every spelling is checked under the bypass too', async () => {
    for (const path of PATHS) {
      const { res, next } = await gate(path, 'GET', 'signedOut', bypass(), LOCAL)
      expect(res.status, path).toBe(403)
      expect(next, path).not.toHaveBeenCalled()
    }
  })

  it('non-budget paths still pass under the bypass whatever the list says', async () => {
    expect((await gate('/api/config', 'GET', 'signedOut', bypass(), LOCAL)).res.status).toBe(200)
  })

  it('does nothing on a non-loopback host, even with the list holding the dev email', async () => {
    for (const spelled of ['1', 'true', '0', ' 1']) {
      const env: AuthEnv = { ...ENV, AUTH_DEV_BYPASS: spelled, BUDGET_ALLOWED_EMAILS: `dev@localhost,${OWNER_LISTED}` }
      const { res, next } = await gate('/api/budget/access', 'GET', 'signedOut', env)
      expect(res.status, spelled).toBe(401)
      expect(next, spelled).not.toHaveBeenCalled()
    }
  })

  it('only the exact flag "1" counts', async () => {
    for (const spelled of ['true', '0', 'yes', ' 1', '']) {
      const env: AuthEnv = { ...ENV, AUTH_DEV_BYPASS: spelled, BUDGET_ALLOWED_EMAILS: 'dev@localhost' }
      const { res } = await gate('/api/budget/access', 'GET', 'signedOut', env, LOCAL)
      expect(res.status, JSON.stringify(spelled)).toBe(401)
    }
  })
})
