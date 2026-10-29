import { configDefaults, defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

// Keeps hooks and the editor responsive during parallel test runs; worker processes inherit it on Windows.
// One id per production build, also served as dist/build-id.json (src/composables/useBuildCheck.ts
// polls it). The dev server and vitest keep 'dev', which turns the check off.
function buildIdPlugin(): Plugin {
  let id = 'dev'
  return {
    name: 'gss-build-id',
    config(_c, env) {
      if (env.command === 'build') id = (process.env.GITHUB_SHA ?? 'local').slice(0, 12) + '-' + Date.now().toString(36)
      return { define: { __BUILD_ID__: JSON.stringify(id) } }
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build-id.json', source: JSON.stringify({ id }) })
    },
  }
}

try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}

// Build output goes to dist/ which Pages serves; functions/ is picked up by wrangler.
// `defineConfig` comes from 'vitest/config' (re-exports vite's own) so component tests
// type-check without a second config file. The default environment stays 'node' — the
// functions/_lib/auth.test.ts suite exercises the Workers runtime's real fetch/Response/
// Request semantics and breaks under a DOM polyfill's own (different) versions of those.
// Component tests that need a real DOM to mount into (ChartCard.test.ts etc.) opt in per-file
// with a `// @vitest-environment happy-dom` comment instead — see Vitest's docs on
// environment overrides.
export default defineConfig({
  plugins: [vue(), buildIdPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
  test: {
    // Keeps tests off the operator's real bws token file (~/.bws-token); the bws-token tests set their own.
    env: { BWS_TOKEN_FILE: os.tmpdir() + '/gss-stats-vitest-no-such-bws-token' },
    // workers/live imports the Workers runtime module `cloudflare:workers`, which Node does not have.
    alias: {
      'cloudflare:workers': fileURLToPath(new URL('./workers/live/test/cloudflare-workers-stub.ts', import.meta.url)),
    },
    // Agent worktrees under .claude/worktrees/ are full checkouts with their own
    // test files; without this, `npm test` from the main checkout collects every
    // worktree's suite too, producing large numbers of spurious failing files.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
})
