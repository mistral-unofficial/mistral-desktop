import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // The MCPB package is ESM-only: bundle it (and fflate) instead of requiring it at runtime.
  main: { build: { externalizeDeps: { exclude: ['@anthropic-ai/mcpb', 'fflate'] } } },
  preload: {},
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [react()]
  }
})
