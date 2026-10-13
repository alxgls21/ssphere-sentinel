import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), ['VITE_', 'SENTINEL_'])

  // A production bundle never runs on sample data without sign-in: fail the build, not the page.
  if (command === 'build' && (env.VITE_SENTINEL_API ?? '').trim().toLowerCase() === 'mock') {
    throw new Error('VITE_SENTINEL_API=mock is not allowed in a production build.')
  }

  // The browser talks to this server only: the console API is reached through the same origin, so
  // there is no CORS and the session and CSRF cookies belong to one site. `changeOrigin` stays off:
  // Django compares the Origin of a POST with the Host it is given, and both must be the dev server's.
  const backend = {
    '/api': { target: env.SENTINEL_BACKEND_URL || 'http://127.0.0.1:8000', changeOrigin: false },
  }

  return {
    plugins: [react(), tailwindcss()],
    // Honors the "@/..." paths declared in tsconfig.app.json.
    resolve: { tsconfigPaths: true },
    server: { proxy: backend },
    preview: { proxy: backend },
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
  }
})
