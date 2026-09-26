// Regression coverage for the HIGH review finding (2026-09-26): useCampaignsData used to
// create a per-campaign `watch(e.data, …)` inside an ASYNC function, after an `await` — by
// then Vue's active effect scope (only tracked synchronously, during a component's setup()
// or an effectScope.run() callback) was already gone, so the watcher was never tied to the
// calling widget and never stopped on unmount. Every mount leaked one watcher per campaign.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { CAMPAIGNS } from './campaigns'
import type { CampaignCompareResponse } from '../types'

vi.mock('../api', () => ({
  fetchCampaignCompare: vi.fn(),
}))

const fakeResponse = { campaign: { id: CAMPAIGNS[0].id } } as unknown as CampaignCompareResponse

describe('useCampaignsData — watcher lifecycle', () => {
  beforeEach(() => {
    vi.resetModules() // fresh module-level cache/inflight Maps per test
  })

  it('a watcher registered inside its owning effect scope stops reacting once that scope is disposed — even if the fetch it was waiting on resolves LATER', async () => {
    const { fetchCampaignCompare } = await import('../api')
    const { useCampaignsData } = await import('./campaignsData')
    const id = CAMPAIGNS[0].id
    let resolveFetch!: (v: CampaignCompareResponse) => void
    vi.mocked(fetchCampaignCompare).mockImplementation(
      () =>
        new Promise((res) => {
          resolveFetch = res
        }),
    )

    const scope = effectScope()
    let api!: ReturnType<typeof useCampaignsData>
    scope.run(() => {
      api = useCampaignsData(() => [id])
    })
    await nextTick()

    // Unmount BEFORE the fetch resolves — exactly the race the leak enabled: a widget
    // removed, or a tab switched away from, while its request is still in flight.
    scope.stop()

    resolveFetch(fakeResponse)
    await new Promise((r) => setTimeout(r, 0))
    await nextTick()

    // The per-campaign watcher lived inside `scope` and was stopped by scope.stop() before
    // the fetch landed, so this composable instance's own dataByCampaign is never updated
    // (a leaked watcher, by contrast, would still write into it here).
    expect(api.dataByCampaign[id]).toBeUndefined()
  })

  it('a fresh mount after an earlier one was disposed still receives data normally (the fix does not also break the live case)', async () => {
    const { fetchCampaignCompare } = await import('../api')
    const { useCampaignsData } = await import('./campaignsData')
    const id = CAMPAIGNS[0].id
    vi.mocked(fetchCampaignCompare).mockResolvedValue(fakeResponse)

    const scope1 = effectScope()
    scope1.run(() => useCampaignsData(() => [id]))
    await nextTick()
    scope1.stop()

    const scope2 = effectScope()
    let api2!: ReturnType<typeof useCampaignsData>
    scope2.run(() => {
      api2 = useCampaignsData(() => [id])
    })
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))
    await nextTick()

    expect(api2.dataByCampaign[id]).toEqual(fakeResponse)
    scope2.stop()
  })

  it('repeated mount/unmount cycles leave no watcher tied to a disposed scope still writing into that scope\'s own data (no unbounded leak)', async () => {
    const { fetchCampaignCompare } = await import('../api')
    const { useCampaignsData } = await import('./campaignsData')
    const id = CAMPAIGNS[0].id
    const resolvers: ((v: CampaignCompareResponse) => void)[] = []
    vi.mocked(fetchCampaignCompare).mockImplementation(
      () =>
        new Promise((res) => {
          resolvers.push(res)
        }),
    )

    const instances: ReturnType<typeof useCampaignsData>[] = []
    for (let i = 0; i < 5; i++) {
      const scope = effectScope()
      let api!: ReturnType<typeof useCampaignsData>
      scope.run(() => {
        api = useCampaignsData(() => [id])
      })
      await nextTick()
      instances.push(api)
      scope.stop() // unmount immediately, before its fetch resolves
    }

    // Resolve every in-flight fetch AFTER every instance above was unmounted.
    for (const resolve of resolvers) resolve(fakeResponse)
    await new Promise((r) => setTimeout(r, 0))
    await nextTick()

    // None of the 5 disposed instances should have been written to after their scope stopped.
    for (const api of instances) expect(api.dataByCampaign[id]).toBeUndefined()
  })
})
