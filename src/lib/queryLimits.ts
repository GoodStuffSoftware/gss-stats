// Shared request-size guards for the beacon-backed D1 readers (functions/api/geo.ts and
// functions/api/popups.ts, both querying `gss_geo`.hits). Extracted from geo.ts (2026-09-27,
// the D1 bind-ceiling review round) so every reader enforces the SAME caps and the SAME clear
// 400 before a request ever reaches D1 — geo.ts already had these; popups.ts had NONE despite
// unconditionally binding its own event-beacon include-clause (lib/popupEvents.ts
// popupIncludeClause) and never capping how many `sites` a request could send, so a large
// enough `sites` array there fell through to a raw D1 error (caught generically as a 500,
// never a clear 400 naming what to change) instead of being refused up front the way geo.ts's
// MAX_SITES always has.
//
// MAX_SITES / MAX_CONSTRAINTS are the UI's own documented maximums (ChartEditor.vue), not
// arbitrary — defense in depth against a malformed/oversized request, not a UX limit in
// themselves. MAX_BOUND_PARAMS / MAX_SQL_BYTES are D1's own statement limits (100 bound
// parameters per query, a 100 KB SQL text cap; 90,000 bytes here leaves headroom).

export const MAX_SITES = 50
export const MAX_CONSTRAINTS = 16
export const MAX_BOUND_PARAMS = 100
export const MAX_SQL_BYTES = 90_000

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

/** A clear 400 when a statement would exceed D1's limits, else null. Both callers run this
 * AFTER building the full SQL + bind list and BEFORE calling `.prepare(sql).bind(...)`, so a
 * chart that asks for too much gets a message naming what to change instead of a raw D1 error. */
export function statementTooLarge(sql: string, bindCount: number): Response | null {
  if (bindCount > MAX_BOUND_PARAMS) {
    return json({ error: `this chart's filters are too many to query at once (${bindCount} values; at most ${MAX_BOUND_PARAMS}): select fewer sites or filters` }, 400)
  }
  const bytes = new TextEncoder().encode(sql).length
  if (bytes > MAX_SQL_BYTES) {
    return json({ error: `this chart's filters make the query too large (${bytes} bytes; at most ${MAX_SQL_BYTES}): use fewer pop-up filters` }, 400)
  }
  return null
}

/** A clear 400 when `siteCount` exceeds MAX_SITES, else null. */
export function tooManySites(siteCount: number): Response | null {
  return siteCount > MAX_SITES ? json({ error: `too many sites (at most ${MAX_SITES})` }, 400) : null
}
