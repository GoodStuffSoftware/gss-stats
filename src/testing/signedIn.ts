// Test helper: a signed-in account for tests that mount App. App keeps this viewer's saved navigation
// state under a key made from the login (lib/viewerPrefs.ts), so those tests name a made-up login and
// read and write the state at PREFS_KEY.
import { signedInEmail } from '../session'
import { viewerPrefsKey } from '../lib/viewerPrefs'

export const TEST_EMAIL = 'viewer@example.com'
export const PREFS_KEY = viewerPrefsKey(TEST_EMAIL)!

/** Sign in as TEST_EMAIL (App's loadIdentity is mocked in these tests, so it only reads this ref). */
export function signInForTest(email: string | null = TEST_EMAIL): void {
  signedInEmail.value = email
}
