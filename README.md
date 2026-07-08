# Video Editor

A CapCut-style, **mobile-first web video editor** for ≤60-second videos, plus a
batch **Shorts** splitter that cuts one long video into many one-minute clips.
Everything runs in the browser — React 19 + TypeScript + Vite, Zustand for
state, FFmpeg.wasm for media processing. **No backend.**

## Repository layout

This is a pnpm + Turborepo monorepo:

```
.
├── apps/
│   └── web/            # the editor (Vite app) — this is what ships
│       ├── public/     # copied verbatim to dist/ (ffmpeg wasm, fonts, .htaccess)
│       └── src/        # store / lib / components / types
├── packages/
│   └── config/         # shared config (prettier, …)
├── turbo.json
└── pnpm-workspace.yaml
```

## Development

```bash
pnpm install     # install deps
pnpm dev         # Vite dev server (auto-picks 5173/5174/…)
pnpm build       # tsc -b && vite build — the authoritative typecheck + bundle
pnpm lint        # eslint
pnpm preview     # serve the production build locally
```

`pnpm build` is the real gate (strict TS then Vite). The production bundle is
emitted to **`apps/web/dist/`**.

## Deployment

The app is fully static — serve the **contents of `apps/web/dist/`** from your
web root. The build already includes a `.htaccess` (from `apps/web/public/`) that
fixes the index/403, sets the correct `.wasm` MIME type, and configures caching.

> Do **not** add COOP/COEP (cross-origin isolation) headers — they break
> FFmpeg's CDN fallback.

### Hostinger / shared Apache hosting

1. Build locally:
   ```bash
   pnpm install && pnpm build
   ```
2. Upload the **contents** of `apps/web/dist/` (not the folder itself) into
   `public_html/`. The result must be:
   ```
   public_html/
   ├── .htaccess
   ├── index.html      ← directly at the root (this is what fixes the 403)
   ├── assets/
   └── ffmpeg/         ← ~32 MB of wasm
   ```
   A 403 on the home page means `index.html` is not at the web root (usually the
   files were left inside a `dist/` subfolder).
3. If it persists, check permissions: folders `755`, files `644`.

To make a ready-to-upload zip on Windows (PowerShell):

```powershell
Compress-Archive -Path apps/web/dist/* -DestinationPath editor-dist.zip -Force
```

Then upload `editor-dist.zip` via hPanel → File Manager → into `public_html/`
and **Extract** it there.

### Static hosts with Git integration (Vercel / Netlify / Cloudflare Pages)

- **Build command:** `pnpm build`
- **Output directory:** `apps/web/dist`
- **Install command:** `pnpm install`

(The `.htaccess` is Apache-only and simply ignored by these hosts.)
