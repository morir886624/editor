// ---------------------------------------------------------------------------
// Native implementation of the editor's Platform seam (see
// apps/web/src/lib/platform.ts). Inside the Capacitor WebView an
// `<a download>` does nothing, so finished files are:
//   1. streamed out of the WebView into the app cache (Filesystem plugin,
//      chunked base64 so a 100 MB+ export never sits in one bridge message),
//   2. then copied into the device gallery (@capacitor-community/media) or
//      handed to the system share sheet (@capacitor/share).
// ---------------------------------------------------------------------------

import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Media } from '@capacitor-community/media'
import { Share } from '@capacitor/share'
import type { OutputFile, Platform } from '@web/lib/platform'

/** Gallery album (Android folder / iOS camera roll on iOS) for saved videos. */
const ALBUM_NAME = 'Video Editor'
/** Cache sub-folder for staged output files; wiped on every app start. */
export const STAGING_DIR = 'outputs'
/** Bytes per bridge call. A multiple of 3 so every chunk is padding-free base64. */
const CHUNK_BYTES = 3 * 1024 * 1024

const blobOf = async (file: OutputFile): Promise<Blob> =>
  file.blob ?? (await (await fetch(file.url)).blob())

/** Base64 (no data: prefix) of a blob slice, via FileReader — no giant strings. */
function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'))
    reader.onload = () => {
      const res = String(reader.result)
      resolve(res.slice(res.indexOf(',') + 1))
    }
    reader.readAsDataURL(blob)
  })
}

/** File names can come from user media; keep them filesystem-safe. */
const safeName = (name: string): string => name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'video.mp4'

/**
 * Write an output file into the app cache, chunk by chunk.
 * @returns the native file:// URI of the staged copy.
 */
async function stage(file: OutputFile): Promise<string> {
  const blob = await blobOf(file)
  const path = `${STAGING_DIR}/${safeName(file.filename)}`

  if (blob.size === 0) throw new Error(`${file.filename} is empty.`)
  for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
    const data = await toBase64(blob.slice(offset, offset + CHUNK_BYTES))
    if (offset === 0) {
      await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true })
    } else {
      await Filesystem.appendFile({ path, data, directory: Directory.Cache })
    }
  }
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
  return uri
}

async function unstage(uri: string): Promise<void> {
  try {
    await Filesystem.deleteFile({ path: uri })
  } catch {
    /* already gone — the cache is wiped on next start anyway */
  }
}

/**
 * Android needs an album identifier (a folder under the app's public media
 * dir, indexed by the gallery). iOS saves to the camera roll without one —
 * and passing none there only asks for add-only photo permission.
 */
let albumPromise: Promise<string | undefined> | null = null
function albumIdentifier(): Promise<string | undefined> {
  if (Capacitor.getPlatform() !== 'android') return Promise.resolve(undefined)
  albumPromise ??= (async () => {
    const { path } = await Media.getAlbumsPath()
    try {
      await Media.createAlbum({ name: ALBUM_NAME })
    } catch {
      /* "Album already exists" — fine */
    }
    return `${path}/${ALBUM_NAME}`
  })().catch((e) => {
    albumPromise = null // let the next save retry
    throw e
  })
  return albumPromise
}

const stripExt = (name: string) => name.replace(/\.[^.]+$/, '')

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export const nativePlatform: Platform = {
  isNative: true,
  saveLabel: 'Save to gallery',
  canShare: true,

  async saveFiles(files) {
    const album = await albumIdentifier()
    for (const file of files) {
      const uri = await stage(file)
      try {
        await Media.saveVideo({
          path: uri,
          albumIdentifier: album,
          fileName: stripExt(safeName(file.filename)), // Android only; ext comes from the path
        })
      } catch (e) {
        throw new Error(`Could not save ${file.filename} to the gallery: ${errorText(e)}`)
      } finally {
        await unstage(uri)
      }
    }
  },

  async shareFiles(files) {
    // Staged copies are NOT deleted here: the receiving app may read them
    // after share() resolves. They're cleared on the next app start.
    const uris: string[] = []
    for (const file of files) uris.push(await stage(file))
    try {
      await Share.share({
        title: files.length === 1 ? files[0].filename : `${files.length} videos`,
        files: uris,
        dialogTitle: 'Share video',
      })
    } catch (e) {
      // Dismissing the share sheet rejects with "Share canceled" — not an error.
      if (/cancel/i.test(errorText(e))) return
      throw e
    }
  },

  prefersMobileLayout: () => true,
}
