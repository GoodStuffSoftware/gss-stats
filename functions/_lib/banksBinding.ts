/// <reference types="@cloudflare/workers-types" />
//
// The Pages side of the BANKS Service Binding (the gss-budget-banks Worker, workers/banks/): its time limits and
// the env slice that holds it. Plan section 3.1. Kept apart from functions/_lib/gmailConnect.ts (BINDING_TIMEOUT_MS
// is the receipts Worker's) so the two features do not edit each other's files. Use bindingFetch from there.

/**
 * Time limits (ms) for the Pages-to-Worker calls; the exchange talks to Plaid twice, the webhook only verifies and writes.
 * The exchange limit sits above the Worker's worst case (the exchange 15 s, accounts/get 15 s, two D1 batches, then a
 * /item/remove 15 s: about 50 s), so Pages never gives up while the Worker is still storing the new Item.
 */
export const BANKS_TIMEOUT_MS = { linkToken: 10_000, exchange: 60_000, unlink: 10_000, accounts: 15_000, webhook: 8_000 } as const

/** The Pages env slice for the banks routes. Unbound (preview, or local without the Worker): every route but the status read answers 503. */
export interface BanksEnv {
  BANKS?: Fetcher
}
