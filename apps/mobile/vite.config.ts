import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { rmSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

// The native app is a thin Capacitor shell around the SAME editor as
// apps/web: sources come from ../web/src (alias `@web`) and static assets
// (self-hosted ffmpeg wasm, fonts) from ../web/public. Only the entry point
// and the native platform glue live in this package.
const webDir = fileURLToPath(new URL('../web', import.meta.url))
const outDir = fileURLToPath(new URL('./dist', import.meta.url))

/** Web-hosting files from ../web/public that mean nothing inside the app. */
const WEB_ONLY_ASSETS = ['.htaccess', 'manifest.webmanifest']

function dropWebOnlyAssets(): Plugin {
  return {
    name: 'mobile:drop-web-only-assets',
    apply: 'build',
    closeBundle() {
      for (const f of WEB_ONLY_ASSETS) rmSync(`${outDir}/${f}`, { force: true })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), dropWebOnlyAssets()],
  publicDir: `${webDir}/public`,
  resolve: {
    alias: { '@web': `${webDir}/src` },
    // Shared sources resolve their deps from apps/web/node_modules; force a
    // single copy of the stateful libraries so hooks/stores aren't duplicated.
    dedupe: ['react', 'react-dom', 'zustand'],
  },
  // Same FFmpeg constraints as apps/web (see its vite.config.ts): don't
  // pre-bundle @ffmpeg/* (breaks the worker URL) and keep the worker a module
  // worker in production so the ESM core loads via import().
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir,
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
})
