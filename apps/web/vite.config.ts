import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // @ffmpeg/ffmpeg spawns its web worker via `new URL('./worker.js',
  // import.meta.url)`. Pre-bundling it with esbuild breaks that resolution,
  // so exclude both ffmpeg packages and let Vite serve them as ESM.
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  server: {
    // Increase the request timeout for large files like FFmpeg WASM
    middlewareMode: false,
    // Configure optimal settings for serving large binary files
    fs: {
      strict: false,
    },
  },
  // Optimize for large binary files
  build: {
    // Ensure large files aren't inlined
    assetsInlineLimit: 0,
  },
})
