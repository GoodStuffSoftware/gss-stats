// The Trial plan's 10-Items-for-life guard (plan sections 2.1 plaid_slot_log and 3.3). Removing an Item does not free
// a slot, so the log is append-only (triggers in migration 0005). A row is written BEFORE the exchange call:
// 'pending' counts; 'done' follows a good exchange; 'failed' only when Plaid answered with an error (a timeout leaves
// the row pending, so overcounting is the safe side); 'prior' is an Item made outside this app, entered by hand.
import type { Env } from './env'

export const SLOT_LIMIT = 10

export type SlotEnvironment = 'production' | 'sandbox'

export const slotEnvironment = (env: Env): SlotEnvironment => (env.PLAID_ENV === 'production' ? 'production' : 'sandbox')

/** Production slots in use (pending, done and prior count; failed and sandbox do not). One query. */
export async function slotsUsed(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT count(*) AS n FROM plaid_slot_log WHERE environment = 'production' AND status IN ('pending','done','prior')`)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/**
 * Reserve a slot as ONE conditional INSERT, so two racing reservations at 9 used cannot both win. Production inserts
 * only while fewer than SLOT_LIMIT are used; sandbox inserts unconditionally. Returns the new row id, or null when the
 * guard refused (0 rows written).
 */
export async function reserveSlot(
  db: D1Database,
  env: Env,
  who: string,
  institutionId: string | null,
  now: Date = new Date(),
): Promise<number | null> {
  const environment = slotEnvironment(env)
  const iso = now.toISOString()
  const sql =
    environment === 'production'
      ? `INSERT INTO plaid_slot_log (environment, status, institution_id, created_at, created_by)
         SELECT 'production', 'pending', ?1, ?2, ?3
         WHERE (SELECT count(*) FROM plaid_slot_log WHERE environment = 'production' AND status IN ('pending','done','prior')) < ${SLOT_LIMIT}
         RETURNING id`
      : `INSERT INTO plaid_slot_log (environment, status, institution_id, created_at, created_by)
         VALUES ('sandbox', 'pending', ?1, ?2, ?3)
         RETURNING id`
  const row = await db.prepare(sql).bind(institutionId, iso, who).first<{ id: number }>()
  return row ? row.id : null
}

/** The UPDATE that closes a slot row; exported so the exchange can run it inside its D1 batch. */
export function finishSlotStmt(
  db: D1Database,
  id: number,
  status: 'done' | 'failed',
  plaidItemId: string | null = null,
  now: Date = new Date(),
): D1PreparedStatement {
  return db
    .prepare(`UPDATE plaid_slot_log SET status = ?1, plaid_item_id = ?2, finished_at = ?3 WHERE id = ?4`)
    .bind(status, plaidItemId, now.toISOString(), id)
}

export async function finishSlot(
  db: D1Database,
  id: number,
  status: 'done' | 'failed',
  plaidItemId: string | null = null,
  now: Date = new Date(),
): Promise<void> {
  await finishSlotStmt(db, id, status, plaidItemId, now).run()
}
