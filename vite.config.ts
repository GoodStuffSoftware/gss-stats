import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Build output goes to dist/ which Pages serves; functions/ is picked up by wrangler.
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
})
