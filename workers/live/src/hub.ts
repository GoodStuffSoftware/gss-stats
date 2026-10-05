// Constants and pure helpers for gss-live. They live here, not in index.ts, because workerd treats
// every named export of the main module as an entrypoint and refuses the Worker if one is not a
// handler class or function ("Incorrect type for map entry ..."). index.ts exports only LiveHub,
// Notify and the default handler.

/** The only message the hub ever sends. Carries no row id, count, time or place. */
export const PING = '{"t":"changed"}'
/** Pings are batched to fixed 15-minute boundaries. ET offsets are whole hours, so these are also the ET :00/:15/:30/:45. */
export const BOUNDARY_MS = 900_000
/** Open dashboard tabs allowed at once (gss-stats is a handful of people). At the cap the OLDEST socket is closed to make room. */
export const MAX_SOCKETS = 100

/** The next 15-minute boundary, strictly after `now`. */
export function nextBoundary(now: number): number {
  return Math.floor(now / BOUNDARY_MS) * BOUNDARY_MS + BOUNDARY_MS
}
