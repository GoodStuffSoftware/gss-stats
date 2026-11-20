// Budget data is private and per account: it never goes through the shared edge cache
// (functions/_lib/edgeCache.ts) or the Workers Cache API. A budget file that names either fails here.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..', '..', '_lib')
const FORBIDDEN = /edgeCache|cachedJson|caches\.default/

function walk(dir: string, keep: (name: string, isDir: boolean) => boolean): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const isDir = statSync(full).isDirectory()
    if (!keep(name, isDir)) continue
    if (isDir) out.push(...walk(full, keep))
    else out.push(full)
  }
  return out
}

// This test file names the forbidden words, so it is not scanned.
const files = [
  ...walk(HERE, () => true),
  ...walk(LIB, (name, isDir) => isDir || name.startsWith('budget')),
].filter((f) => /\.(ts|mjs|js)$/.test(f) && !f.endsWith('noEdgeCache.test.ts'))

describe('budget code stays out of the edge cache', () => {
  it('scans the budget Functions and the budget helpers', () => {
    const names = files.map((f) => relative(join(HERE, '..', '..'), f).replace(/\\/g, '/'))
    expect(names).toContain('api/budget/_middleware.ts')
    expect(names).toContain('_lib/budgetAccess.ts')
  })

  it.each(files.map((f) => [relative(join(HERE, '..', '..'), f).replace(/\\/g, '/'), f]))('%s', (_name, file) => {
    expect(readFileSync(file, 'utf8')).not.toMatch(FORBIDDEN)
  })
})
