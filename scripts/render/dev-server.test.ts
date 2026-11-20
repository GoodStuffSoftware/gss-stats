import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module, no types
import { buildSpawn, buildRunnerSpawn } from './dev-server.mjs'

describe('dev-server buildSpawn', () => {
  it('spawns node on wrangler.js with no shell and a hidden window', () => {
    const s = buildSpawn({ port: 8795, root: '/r', execPath: '/node' })
    expect(s.command).toBe('/node')
    expect(s.args).toEqual(expect.arrayContaining(['pages', 'dev', '--port', '8795', '--ip', 'localhost']))
    expect(s.args[0]).toMatch(/wrangler[\\/]bin[\\/]wrangler\.js$/)
    expect(s.options.windowsHide).toBe(true)
    expect(s.options.shell).toBeFalsy()
  })
  it('runs wrangler under a detached, hidden, shell-free runner', () => {
    const r = buildRunnerSpawn({ port: 8795, root: '/r', execPath: '/node' })
    expect(r.options.windowsHide).toBe(true)
    expect(r.options.detached).toBe(true)
    expect(r.options.shell).toBeFalsy()
    expect(r.command).toBe('/node')
  })
  it('refuses --remote', () => {
    expect(() => buildSpawn({ port: 8795, extraArgs: ['--remote'] })).toThrow(/remote/)
    expect(() => buildRunnerSpawn({ port: 8795, extraArgs: ['--remote=true'] })).toThrow(/remote/)
  })
  it('refuses a bad port', () => {
    expect(() => buildSpawn({ port: 'x' })).toThrow(/port/)
  })
})
