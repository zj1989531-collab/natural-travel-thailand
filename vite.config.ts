import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'

export default defineConfig(({ mode }) => ({
  base: loadEnv(mode, '.', 'VITE_').VITE_BASE_PATH || '/',
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Keep long-lived runtime libraries separate from application code so
        // a normal feature release only replaces the smaller app chunk.
        manualChunks: {
          supabase: ['@supabase/supabase-js'],
          indexeddb: ['idb']
        }
      }
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx']
  }
}))
