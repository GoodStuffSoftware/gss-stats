// The beacon site tags for Best Sudoku traffic. The web build tags itself "bestsudoku-web"
// (plus a small "bestsudoku" bucket from any page that falls back to the hostname auto-tag),
// and the app pings the beacon as "bestsudoku-app".
//
// A leaf module (no imports) so the metrics registry's facts can read it without importing
// lib/defaults.ts, which itself imports the registry to validate saved cards (normCardRef):
// the constant lives here, and lib/defaults.ts re-exports it for every existing importer.
export const BEST_SUDOKU_SITES = ['bestsudoku-web', 'bestsudoku', 'bestsudoku-app']
