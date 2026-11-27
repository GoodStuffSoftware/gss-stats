// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../session', () => ({ checkSessionExpired: vi.fn(async () => {}) }))
import { checkSessionExpired } from '../session'
import { resetAccessProbe } from './budget/clientRead'
import { CODE_SECTIONS, accessibleSections, type CodeSection } from './codeSections'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  resetAccessProbe()
  vi.mocked(checkSessionExpired).mockClear()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('accessibleSections (the code-defined ☰ menu items)', () => {
  it('lists Budget when GET /api/budget/access says 200, with one request', async () => {
    fetchMock.mockResolvedValue(json({ ok: true, email: 'a@example.com' }))
    expect(await accessibleSections()).toEqual([
      { id: 'budget', label: 'Budget', icon: 'wallet', pages: [{ id: 'overview', label: 'Overview' }, { id: 'loans', label: 'Loans' }, { id: 'receipts', label: 'Receipts' }, { id: 'banks', label: 'Banks' }] },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/budget/access')
  })

  it.each([
    ['403', () => fetchMock.mockResolvedValue(json({ error: 'budget_denied' }, 403))],
    ['401', () => fetchMock.mockResolvedValue(json({ error: 'unauthorized' }, 401))],
    ['500', () => fetchMock.mockResolvedValue(json({}, 500))],
    ['a network error', () => fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))],
  ])('lists nothing on %s', async (_n, arrange) => {
    arrange()
    expect(await accessibleSections()).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1) // the single access check, nothing else
  })

  it('401 raises the existing session-expired check', async () => {
    fetchMock.mockResolvedValue(json({}, 401))
    await accessibleSections()
    expect(checkSessionExpired).toHaveBeenCalledTimes(1)
  })

  it('checks each section on its own: a throwing check hides only that section, order kept', async () => {
    const mk = (id: string, access: CodeSection['access']): CodeSection => ({ id, label: id.toUpperCase(), icon: 'file', access })
    const out = await accessibleSections([
      mk('a', async () => true),
      mk('b', async () => {
        throw new Error('boom')
      }),
      mk('c', async () => false),
      mk('d', async () => true),
    ])
    expect(out.map((s) => s.id)).toEqual(['a', 'd'])
  })

  it('the registry has Budget only (a section is code, never the KV layout)', () => {
    expect(CODE_SECTIONS.map((s) => s.id)).toEqual(['budget'])
  })
})
