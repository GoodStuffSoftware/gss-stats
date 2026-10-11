// The Cloudflare account id the GraphQL Analytics queries filter on (accountTag). It is env data,
// so it lives in the CF_ACCOUNT_ID Pages secret (README "Environment data"), never as a constant
// in this public repo. Locally it comes from .dev.vars.

/** A Cloudflare account id: 32 lowercase hex characters. */
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/

/** The configured account id, or null when CF_ACCOUNT_ID is unset or malformed. The value is
 * interpolated into a GraphQL query string, so anything but 32 hex characters is refused. */
export function cfAccountId(env: { CF_ACCOUNT_ID?: string }): string | null {
  const id = (env.CF_ACCOUNT_ID ?? '').trim().toLowerCase()
  return ACCOUNT_ID_RE.test(id) ? id : null
}
