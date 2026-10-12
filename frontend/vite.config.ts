import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Honors the "@/..." paths declared in tsconfig.app.json.
  resolve: { tsconfigPaths: true },
  build: {
    // ECharts is the one large asset (~190 kB gzipped). It is split into a lazy chunk so the shell,
    // verdict and queue paint first, so the default 500 kB warning is raised for it on purpose.
    chunkSizeWarningLimit: 600,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
