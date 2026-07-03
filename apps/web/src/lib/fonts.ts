// ---------------------------------------------------------------------------
// Font registry for text overlays.
//
// Overlays store a CSS font-family STACK (TextStyle.fontFamily) — never a
// runtime handle — so documents stay serializable and render with graceful
// fallbacks when a font is missing. The Arabic families are self-hosted
// woff2 (@font-face rules in /src/fonts.css, files in /public/fonts — see
// LICENSE.md there). Direction is DERIVED (Arabic font or Arabic characters
// => RTL), never stored, so existing documents need no migration.
//
// KFGQPC HAFS (Uthmani) is deliberately NOT bundled: the King Fahd Glorious
// Quran Printing Complex licenses it for free Quran display but forbids
// modification/resale and controls redistribution. The user imports their own
// copy at runtime (FontFace API, session-only); its picker entry falls back
// to Amiri Quran until then, and after a reload the import must be repeated.
// ---------------------------------------------------------------------------

import { create } from 'zustand';
import type { TextStyle } from '../types';

export interface FontOption {
  label: string;
  /** CSS font-family stack, stored verbatim in TextStyle.fontFamily. */
  value: string;
  /** RTL + complex-shaping group (drives direction and line height). */
  arabic?: boolean;
  /** Not bundled; needs a user-imported font file this session (KFGQPC). */
  requiresImport?: boolean;
}

export const LATIN_FONTS: FontOption[] = [
  { label: 'Sans', value: 'Inter, system-ui, sans-serif' },
  { label: 'Serif', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Mono', value: '"Courier New", monospace' },
  { label: 'Impact', value: 'Impact, Haettenschweiler, sans-serif' },
  { label: 'Script', value: '"Brush Script MT", "Segoe Script", cursive' },
];

/** Family name we register the user-imported KFGQPC file under. */
export const KFGQPC_FAMILY = 'KFGQPC HAFS Uthmanic Script';

export const ARABIC_FONTS: FontOption[] = [
  { label: 'Amiri', value: '"Amiri", serif', arabic: true },
  { label: 'Amiri Quran', value: '"Amiri Quran", "Amiri", serif', arabic: true },
  { label: 'Scheherazade New', value: '"Scheherazade New", serif', arabic: true },
  { label: 'Lateef', value: '"Lateef", serif', arabic: true },
  {
    label: 'KFGQPC HAFS (Uthmani)',
    value: `"${KFGQPC_FAMILY}", "Amiri Quran", "Amiri", serif`,
    arabic: true,
    requiresImport: true,
  },
];

export const FONT_GROUPS: { label: string; fonts: FontOption[] }[] = [
  { label: 'Standard', fonts: LATIN_FONTS },
  { label: 'Arabic / Quran', fonts: ARABIC_FONTS },
];

// ---- direction / metrics ----------------------------------------------------

/** Arabic script blocks incl. presentation forms and Quranic annotation marks. */
const ARABIC_CHAR_RE = /[؀-ۿݐ-ݿࡰ-ࣿﭐ-﷿ﹰ-﻿]/;

export const containsArabic = (text: string): boolean => ARABIC_CHAR_RE.test(text);

const ARABIC_FAMILY_RE = /Amiri|Scheherazade|Lateef|KFGQPC/i;

export const isArabicFontFamily = (fontFamily: string): boolean =>
  ARABIC_FAMILY_RE.test(fontFamily);

/**
 * Base paragraph direction for an overlay. RTL when the font is from the
 * Arabic group OR the text contains Arabic characters; combined with
 * `unicode-bidi: plaintext` (see overlayTextStyle) each line still resolves
 * its own direction, so mixed Arabic+Latin behaves.
 */
export function overlayDirection(style: Pick<TextStyle, 'fontFamily'>, text: string): 'rtl' | 'ltr' {
  return isArabicFontFamily(style.fontFamily) || containsArabic(text) ? 'rtl' : 'ltr';
}

/**
 * Line height for an overlay. An explicit style.lineHeight wins; otherwise
 * it is automatic per font group: Arabic fonts carry tall ascenders plus
 * stacked harakat / Quranic marks; the Latin 1.15 would clip or overlap
 * lines, so the Arabic group gets a taller box. Used by BOTH the preview CSS
 * and the export rasterizer so the two can't diverge.
 */
export function overlayLineHeight(style: Pick<TextStyle, 'fontFamily' | 'lineHeight'>): number {
  if (style.lineHeight != null) return style.lineHeight;
  return isArabicFontFamily(style.fontFamily) ? 1.7 : 1.15;
}

// ---- runtime-imported fonts (KFGQPC) ----------------------------------------

interface FontState {
  /** Families successfully imported this session via the FontFace API. */
  importedFamilies: string[];
  registerImported: (family: string) => void;
}

export const useFontStore = create<FontState>((set) => ({
  importedFamilies: [],
  registerImported: (family) =>
    set((s) =>
      s.importedFamilies.includes(family)
        ? s
        : { importedFamilies: [...s.importedFamilies, family] },
    ),
}));

/**
 * Load a user-supplied font file (.ttf/.otf/.woff2) and register it under
 * `family` for this browser session (document.fonts). Throws on parse failure.
 */
export async function importFontFile(file: File, family: string): Promise<void> {
  const buf = await file.arrayBuffer();
  const face = new FontFace(family, buf);
  await face.load();
  document.fonts.add(face);
  useFontStore.getState().registerImported(family);
}

// ---- sample texts -----------------------------------------------------------

/**
 * Ready-to-insert Arabic/Quranic samples (Uthmani orthography, incl. U+0671
 * alif wasla, U+0670 dagger alif, U+06DD end-of-ayah). They exist to VERIFY
 * shaping/diacritics and as starting points — the UI reminds users to check
 * Quranic text against an authentic source before publishing.
 */
export interface ArabicSample {
  name: string;
  text: string;
  style: Partial<TextStyle>;
}

const QURAN_SAMPLE_STYLE: Partial<TextStyle> = {
  fontFamily: '"Amiri Quran", "Amiri", serif',
  fontSize: 7,
  color: '#ffffff',
  outlineColor: '#000000',
  outlineWidth: 0,
  shadow: true,
  background: 'transparent',
  alignment: 'center',
  opacity: 1,
};

export const ARABIC_SAMPLES: ArabicSample[] = [
  {
    name: 'Bismillah',
    text: 'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ',
    style: QURAN_SAMPLE_STYLE,
  },
  {
    name: 'Ayah (112:1)',
    text: 'قُلْ هُوَ ٱللَّهُ أَحَدٌ ۝١',
    style: QURAN_SAMPLE_STYLE,
  },
  {
    name: 'Dhikr',
    text: 'سُبْحَانَ اللَّهِ وَبِحَمْدِهِ',
    style: { ...QURAN_SAMPLE_STYLE, fontFamily: '"Scheherazade New", serif', fontSize: 6 },
  },
];
