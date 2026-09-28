import { configDefaults, defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Build output goes to dist/ which Pages serves; functions/ is picked up by wrangler.
// `defineConfig` comes from 'vitest/config' (re-exports vite's own) so component tests
// type-check without a second config file. The default environment stays 'node' — the
// functions/_lib/auth.test.ts suite exercises the Workers runtime's real fetch/Response/
// Request semantics and breaks under a DOM polyfill's own (different) versions of those.
// Component tests that need a real DOM to mount into (ChartCard.test.ts etc.) opt in per-file
// with a `// @vitest-environment happy-dom` comment instead — see Vitest's docs on
// environment overrides.
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
  test: {
    // Agent worktrees under .claude/worktrees/ are full checkouts with their own
    // test files; without this, `npm test` from the main checkout collects every
    // worktree's suite too, producing large numbers of spurious failing files.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
})
