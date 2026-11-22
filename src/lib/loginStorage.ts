// Per-login browser storage: a localStorage key made of a fixed prefix and a hash of the signed-in
// account's lower-cased address (`<prefix>:<hash>`), so two people on one browser keep separate
// state. The key holds the hash, never the address. The hash is cyrb53 over trim().toLowerCase(), the
// same as `panelsKey` in the Budget section's panelVisibility.ts, so that code can adopt this helper
// and keep every saved value.
//
// localStorage can be missing, blocked or throw (private windows, disabled site data, quota), so every
// access is wrapped: a failed read is "nothing saved", a failed write or remove is ignored.

/** cyrb53: a small non-cryptographic 53-bit hash, as 14 hex digits. Enough to tell two accounts apart in a key. */
export function hash53(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

/** `<prefix>:<hash of the lower-cased address>`, or null when no one is signed in (nothing is kept then). */
export function loginKey(prefix: string, email: string | null | undefined): string | null {
  const who = (email ?? '').trim().toLowerCase()
  return who ? `${prefix}:${hash53(who)}` : null
}

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null // even touching localStorage can throw when site data is blocked
  }
}

/** The raw text saved under this login's key, or null (nobody signed in, nothing saved, storage failing). */
export function readLoginItem(prefix: string, email: string | null | undefined): string | null {
  const key = loginKey(prefix, email)
  if (!key) return null
  try {
    return store()?.getItem(key) ?? null
  } catch {
    return null
  }
}

/** Save `text` under this login's key. Does nothing when nobody is signed in; never throws. */
export function writeLoginItem(prefix: string, email: string | null | undefined, text: string): void {
  const key = loginKey(prefix, email)
  if (!key) return
  try {
    store()?.setItem(key, text)
  } catch {
    // storage full, blocked or unavailable: the value lasts this visit only
  }
}

/** One-time move of a pre-login value: when this login has nothing saved and `legacyKey` holds a value, it
 * becomes this login's value and the legacy key is removed. Never throws. */
export function adoptLegacyItem(prefix: string, email: string | null | undefined, legacyKey: string): void {
  const key = loginKey(prefix, email)
  if (!key) return
  try {
    const s = store()
    if (!s || s.getItem(key) !== null) return
    const legacy = s.getItem(legacyKey)
    if (legacy === null) return
    s.setItem(key, legacy)
    s.removeItem(legacyKey)
  } catch {
    // storage failing: leave the legacy value where it is
  }
}
