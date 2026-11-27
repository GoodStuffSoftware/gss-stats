// The banks Worker's bindings and vars (workers/banks/wrangler.toml). Secrets are Secrets Store bindings read with
// readSecret; a missing or empty one reads as ''.
import { readSecret, type SecretBinding } from '../../receipts/src/disconnect'

export { readSecret, type SecretBinding }

export interface Env {
  BUDGET_DB: D1Database
  PLAID_CLIENT_ID?: SecretBinding
  PLAID_SECRET?: SecretBinding
  BANKS_TOKEN_KEY?: SecretBinding
  BANKS_TOKEN_KEY_OLD?: SecretBinding
  RECEIPTS_ALLOWED_EMAILS?: SecretBinding
  /** 'production' or 'sandbox'. */
  PLAID_ENV?: string
  PLAID_WEBHOOK_URL?: string
  PLAID_REDIRECT_URI?: string
}

/** The allowed Budget people (lower-case), or null when the secret is missing or empty. */
export async function allowedEmails(env: Env): Promise<Set<string> | null> {
  const raw = await readSecret(env.RECEIPTS_ALLOWED_EMAILS)
  return raw === '' ? null : new Set(raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean))
}
